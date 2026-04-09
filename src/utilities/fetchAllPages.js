'use strict';

/**
 * fetchAllPages.js — Optimized smart crawler with AI classification.
 *
 * Phase 1 — Crawl homepage + level-1 deep (concurrency-capped, fast timeout)
 * Phase 2 — AI classifies all collected URLs
 * Phase 3 — Drill into service hubs (skip already-visited, run in parallel with AI)
 * Phase 4 — AI shortlists top N pages for audit
 */

const { chromium } = require('playwright-core');
const { URL } = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  crawlTimeout: 8_000,      // ⚡ reduced from 20s — we only need links, not full render
  maxServiceSubPages: 30,
  auditLimit: 10,
  crawlConcurrency: 8,      // ⚡ max parallel browser pages open at once
};
const SHORTLIST_SERVICE_PAGE_CAP = Number(process.env.AI_SHORTLIST_SERVICE_CAP || 4);

// ─── Hard skip rules ──────────────────────────────────────────────────────────

const HARD_SKIP = [
  /[?&]page=\d/,
  /\/page\/\d+/,
  /[?&](p|pg|offset)=\d/,
  /\/(login|log-in|logout|log-out|register|signup|sign-up|sign-in|wp-admin|wp-login)\b/,
  /\/\d{4}\/\d{2}\//,
  /\/(tag|tags|category|categories|author|authors)\//,
  /\.(pdf|docx?|xlsx?|pptx?|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|csv)(\?|$)/i,
  /[?&](q|s|search|query)=/,
  /\/search\b/,
  /\/policies\//,
  /\/(privacy|terms|legal|refund|shipping|returns)(\b|\/)/,
  /\/(cart|checkout|basket|wishlist|my-account)\b/,
  /\/(sitemap|feed|rss|atom)(\.xml)?$/,
  /[?&]utm_/,
  /^#/,
];

function isHardSkipped(url) {
  return HARD_SKIP.some((p) => p.test(url));
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid']) {
      u.searchParams.delete(p);
    }
    if (u.pathname.endsWith('/') && u.pathname.length > 1) u.pathname = u.pathname.slice(0, -1);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function isSameDomain(url, origin) {
  try { return new URL(url).origin === origin; }
  catch { return false; }
}

function pathDepth(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).length; }
  catch { return 10; }
}

function getPathname(url) {
  try { return new URL(url).pathname.toLowerCase(); }
  catch { return '/'; }
}

function canonicalPathForSelection(url) {
  let p = getPathname(url);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  // Collapse country/localized variants, e.g. /fr/pricing -> /pricing
  p = p.replace(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\//i, '/');
  return p || '/';
}

function categoryWeight(category = '') {
  const c = String(category || '').toLowerCase();
  if (c === 'home') return 70;
  if (c === 'contact') return 62;
  if (c === 'services') return 58;
  if (c === 'pricing') return 55;
  if (c === 'about') return 52;
  if (c === 'faq') return 50;
  if (c === 'portfolio') return 46;
  if (c === 'blog') return 42;
  if (c === 'service-page') return 36;
  return 24;
}

function slugIntentWeight(url = '') {
  const lower = String(url || '').toLowerCase();
  let score = 0;

  if (/\/(about|our-story|story|who-we-are)\b/.test(lower)) score += 30;
  if (/\/(contact|support|help)\b/.test(lower)) score += 34;
  if (/\/(services?|solutions?|offerings?)\b/.test(lower)) score += 28;
  if (/\/(collections?|catalog|shop)\b/.test(lower)) score += 24;
  if (/\/(pricing|plans?)\b/.test(lower)) score += 22;
  if (/\/(faq|frequently-asked-questions)\b/.test(lower)) score += 18;
  if (/\/(products?)\//.test(lower)) score += 8; // keep product details but below hubs
  if (/\/(blogs?|articles?|news)\//.test(lower)) score += 6;

  return score;
}

function normalizeCategory(category, url = '') {
  const c = String(category || '').trim().toLowerCase();
  if (c) return c;
  const lowerUrl = String(url || '').toLowerCase();
  if (/\/collections\//.test(lowerUrl)) return 'services';
  if (/\/products\//.test(lowerUrl)) return 'service-page';
  if (/\/blogs?\//.test(lowerUrl)) return 'blog';
  if (/\/faq/.test(lowerUrl)) return 'faq';
  if (/\/contact/.test(lowerUrl)) return 'contact';
  if (/\/about/.test(lowerUrl)) return 'about';
  return 'other';
}

function computeLinkPriority(link, homepageUrl) {
  const url = String(link?.url || '');
  if (!url || url === homepageUrl) return Number.NEGATIVE_INFINITY;

  const text = String(link?.text || '').toLowerCase();
  const lower = url.toLowerCase();
  let score = 0;

  if (/\/(contact|about|services?|pricing|faq|collections?|products?|blog|team|portfolio)\b/.test(lower)) score += 36;
  if (/\/(products?|collections?)\//.test(lower)) score += 16;
  if (/\/(blogs?|articles?)\//.test(lower)) score += 14;
  if (/(contact|about|services?|pricing|product|collection|blog|faq)/.test(text)) score += 10;
  if (pathDepth(url) <= 2) score += 10;
  if (pathDepth(url) >= 5) score -= 8;
  if (/[?&]/.test(url)) score -= 4;

  return score;
}

function classifyByRules(url, homepageUrl) {
  const lower = String(url || '').toLowerCase();
  let path = '/';
  try { path = new URL(url).pathname.toLowerCase(); } catch {}
  const canonical = canonicalPathForSelection(url);
  const depth = pathDepth(url);

  if (/\/(docs?|documentation|developers?|api|reference|changelog)(\b|\/)/.test(path)) {
    return { category: 'other', tier: 3, isCoreLanding: false, isSingleDetail: false, landingType: 'docs', reasoning: 'Documentation page (supporting)' };
  }

  if (url === homepageUrl) {
    return { category: 'home', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'home', canonicalPath: canonical, reasoning: 'Starting point' };
  }

  const isContact = /\/(contact|contact-us|get-in-touch)(\b|\/)/.test(path) || /\/(support|help)(\/)?$/.test(path);
  const isAbout = /\/(about|about-us|our-story|story|who-we-are)(\/)?$/.test(path);
  const isServicesLanding = /\/(services?|solutions?|offerings?|what-we-do|our-services|our-solutions)(\/)?$/.test(path);
  const isProductsLanding = /^\/(products?|shop|store|catalog)(\/)?$/.test(canonical);
  const isCollectionLanding = /^\/collections?(\/all)?(\/)?$/.test(canonical) || /^\/collections\/[a-z0-9-]+(\/)?$/.test(canonical);
  const isSingleService = /\/(services?|solutions?)\/[a-z0-9-]+/.test(path);
  const isSingleProduct = /\/(products?)\/[a-z0-9-]+/.test(path);

  if (isContact) return { category: 'contact', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'contact', canonicalPath: canonical, reasoning: 'Core conversion page' };
  if (isAbout) return { category: 'about', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'about', canonicalPath: canonical, reasoning: 'Core trust page' };
  if (isServicesLanding) return { category: 'services', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'services', canonicalPath: canonical, reasoning: 'Service hub landing page' };
  if ((isProductsLanding || isCollectionLanding) && depth <= 3) {
    return { category: 'services', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'products-hub', canonicalPath: canonical, reasoning: 'Product/collection landing page' };
  }
  if (isSingleService || isSingleProduct) return { category: 'service-page', tier: 2, isCoreLanding: false, isSingleDetail: true, landingType: 'detail', canonicalPath: canonical, reasoning: 'Single service/product detail page' };

  if (/\/(faq|frequently-asked-questions)(\/)?$/.test(path)) {
    return { category: 'faq', tier: 2, isCoreLanding: false, isSingleDetail: false, landingType: 'faq', canonicalPath: canonical, reasoning: 'Helpful supporting page' };
  }
  if (/\/(pricing|plans?)(\/)?$/.test(path)) {
    // Only top-level pricing pages are core. Nested pricing pages are treated as detail pages.
    if (/^\/(pricing|plans?)(\/)?$/.test(canonical)) {
      return { category: 'pricing', tier: 1, isCoreLanding: true, isSingleDetail: false, landingType: 'pricing', canonicalPath: canonical, reasoning: 'Conversion decision page' };
    }
    return { category: 'service-page', tier: 2, isCoreLanding: false, isSingleDetail: true, landingType: 'detail', canonicalPath: canonical, reasoning: 'Product pricing detail page' };
  }
  if (/\/(team|careers?|partners?|portfolio|industries?)(\/)?$/.test(path)) {
    return { category: 'other', tier: 3, isCoreLanding: false, isSingleDetail: false, landingType: 'supporting', canonicalPath: canonical, reasoning: 'Supporting page' };
  }
  if (/^\/(blog|blogs|news)(\/)?$/.test(canonical)) {
    return { category: 'blog', tier: 3, isCoreLanding: false, isSingleDetail: false, landingType: 'blog-index', canonicalPath: canonical, reasoning: 'Blog index page' };
  }
  if (/\/(blog|blogs|newsroom|news)\//.test(path)) {
    return { category: 'other', tier: 3, isCoreLanding: false, isSingleDetail: false, landingType: 'blog-post', canonicalPath: canonical, reasoning: 'Blog post (lower priority)' };
  }

  // Score unknown pages to decide if they still look relevant.
  const heuristic = computeLinkPriority({ url: lower, text: '' }, homepageUrl);
  if (heuristic >= 30) {
    return { category: 'other', tier: 3, isCoreLanding: false, isSingleDetail: false, landingType: 'other', canonicalPath: canonical, reasoning: 'Relevant by URL pattern' };
  }

  return null;
}

function buildShortlistCandidates(pages, homepageUrl) {
  const list = [];
  for (const meta of pages.values()) {
    const url = meta?.url;
    if (!url) continue;

    const tier = [1, 2, 3].includes(Number(meta.tier)) ? Number(meta.tier) : 3;
    const category = normalizeCategory(meta.category, url);
    const reasoning = String(meta.reasoning || '').trim() || 'Selected by AI';

    let score = 0;
    score += tier === 1 ? 120 : tier === 2 ? 80 : 45;
    score += categoryWeight(category);
    score += slugIntentWeight(url);
    score += Math.max(0, 10 - pathDepth(url));
    if (url === homepageUrl) score += 200;
    if (/\/collections\//.test(url)) score += 14;
    if (/\/blogs?\//.test(url)) score += 8;
    if (/\/products\//.test(url)) score -= 10;

    list.push({
      url,
      tier,
      category,
      reasoning,
      discoveredVia: meta.discoveredVia || homepageUrl,
      landingType: meta.landingType || null,
      canonicalPath: meta.canonicalPath || canonicalPathForSelection(url),
      _score: score,
    });
  }

  list.sort((a, b) => b._score - a._score || a.url.length - b.url.length);

  // Collapse locale/page duplicates for non-detail pages so shortlist stays diverse.
  const deduped = [];
  const seenCore = new Set();
  for (const item of list) {
    const key = `${item.landingType || item.category}:${item.canonicalPath || canonicalPathForSelection(item.url)}`;
    if (item.landingType !== 'detail' && seenCore.has(key)) continue;
    deduped.push(item);
    if (item.landingType !== 'detail') seenCore.add(key);
  }

  return deduped;
}

function chooseDeterministicShortlist(candidates, homepageUrl, limit) {
  const chosen = [];
  const used = new Set();
  const usedCanonical = new Set();
  const categoryCounts = new Map();
  let servicePageCount = 0;
  let collectionHubCount = 0;

  function pushCandidate(c) {
    if (!c || used.has(c.url) || chosen.length >= limit) return false;

    const canonicalKey = `${c.landingType || c.category}:${c.canonicalPath || canonicalPathForSelection(c.url)}`;
    if (usedCanonical.has(canonicalKey) && c.landingType !== 'detail') return false;

    chosen.push(c);
    used.add(c.url);
    usedCanonical.add(canonicalKey);
    categoryCounts.set(c.category, (categoryCounts.get(c.category) || 0) + 1);
    if (c.category === 'service-page') servicePageCount++;
    if (c.landingType === 'products-hub') collectionHubCount++;
    return true;
  }

  function pickFirst(predicate) {
    for (const c of candidates) {
      if (used.has(c.url)) continue;
      if (!predicate(c)) continue;
      return pushCandidate(c);
    }
    return false;
  }

  // Always include homepage if present.
  const home = candidates.find((c) => c.url === homepageUrl);
  if (home) pushCandidate(home);

  // Mandatory core coverage slots.
  pickFirst((c) => c.landingType === 'contact');
  pickFirst((c) => c.landingType === 'about');
  pickFirst((c) => c.landingType === 'services');
  pickFirst((c) => c.landingType === 'products-hub');
  pickFirst((c) => c.landingType === 'pricing' || c.landingType === 'faq');

  // Then allow more core pages but cap collection hub spam.
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (used.has(c.url)) continue;
    if (!c.isCoreLanding) continue;
    if (c.landingType === 'products-hub' && collectionHubCount >= 3) continue;
    pushCandidate(c);
  }

  // Second pass: fill with single service/product pages.
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (used.has(c.url)) continue;
    if (!c.isSingleDetail) continue;

    if (c.category === 'service-page' && servicePageCount >= SHORTLIST_SERVICE_PAGE_CAP) continue;
    pushCandidate(c);
  }

  // Third pass: keep diversity while capping noisy categories.
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (used.has(c.url)) continue;

    const current = categoryCounts.get(c.category) || 0;
    if (c.category === 'service-page' && servicePageCount >= SHORTLIST_SERVICE_PAGE_CAP) continue;
    if (c.category === 'other' && current >= 2) continue;
    if (c.category === 'blog' && current >= 1) continue;

    chosen.push(c);
    used.add(c.url);
    categoryCounts.set(c.category, current + 1);
    if (c.category === 'service-page') servicePageCount++;
  }

  // Second pass: fill remaining slots by raw score.
  for (const c of candidates) {
    if (chosen.length >= limit) break;
    if (used.has(c.url)) continue;
    if (c.landingType === 'products-hub' && collectionHubCount >= 3) continue;
    if (c.category === 'service-page' && servicePageCount >= SHORTLIST_SERVICE_PAGE_CAP) continue;
    pushCandidate(c);
  }

  return chosen.map((c, i) => ({
    rank: i + 1,
    url: c.url,
    category: c.category,
    tier: c.tier,
    auditPriority: c.tier === 1 ? 'critical' : c.tier === 2 ? 'high' : 'medium',
    auditReason: c.reasoning,
  }));
}

function normalizeShortlist(shortlisted, knownPages, homepageUrl, limit) {
  const out = [];
  const seen = new Set();

  for (const item of shortlisted || []) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    const page = knownPages.get(url);
    if (!page) continue;

    seen.add(url);
    out.push({
      rank: out.length + 1,
      url,
      category: normalizeCategory(item.category || page.category, url),
      tier: [1, 2, 3].includes(Number(item.tier)) ? Number(item.tier) : Number(page.tier) || 3,
      auditPriority: ['critical', 'high', 'medium'].includes(String(item.auditPriority || '').toLowerCase())
        ? String(item.auditPriority).toLowerCase()
        : (Number(page.tier) === 1 ? 'critical' : Number(page.tier) === 2 ? 'high' : 'medium'),
      auditReason: String(item.auditReason || page.reasoning || 'Selected by AI').trim().slice(0, 180),
    });

    if (out.length >= limit) break;
  }

  // Guarantee homepage presence where available.
  const hasHomepage = out.some((p) => p.url === homepageUrl);
  if (!hasHomepage && knownPages.has(homepageUrl)) {
    out.unshift({
      rank: 1,
      url: homepageUrl,
      category: 'home',
      tier: 1,
      auditPriority: 'critical',
      auditReason: 'Starting point',
    });
    if (out.length > limit) out.length = limit;
    out.forEach((p, i) => { p.rank = i + 1; });
  }

  return out;
}

// ─── Concurrency-capped pool ──────────────────────────────────────────────────

/**
 * Run async tasks with a max concurrency cap.
 * Much faster than all-at-once (which overloads the browser)
 * and much faster than sequential (which wastes time waiting).
 */
async function pooled(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );

  return results;
}

// ─── Playwright helpers ───────────────────────────────────────────────────────

async function extractLinks(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.href,
      text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().slice(0, 100),
    })).filter((l) => l.href.startsWith('http')),
  );
}

async function fetchPageLinks(context, url, timeout) {
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!res || res.status() >= 400) return null;
    return await extractLinks(page);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function fetchImportantPages(homepageUrl, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const origin = new URL(homepageUrl).origin;

  const stats = {
    rawLinksFound: 0,
    hardSkipped: 0,
    serviceSubPagesFound: 0,
    errors: 0,
    crawlTimeMs: 0,
    shortlistRecovered: 0,
    shortlistCandidates: 0,
  };

  // ── Boot browser ──────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // ⚡ Block everything except document + XHR — images, fonts, CSS, scripts all skipped
  // We only need the HTML to extract <a href> links
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['document', 'xhr', 'fetch'].includes(type)) return route.continue();
    return route.abort();
  });

  const pages = new Map();
  const visited = new Set();

  function addPage(url, meta) {
    if (!pages.has(url)) {
      pages.set(url, meta);
      const tierLabel = meta.tier === 1 ? 'T1' : meta.tier === 2 ? 'T2' : 'T3';
      console.log(`  [${tierLabel}] [${(meta.category || 'unknown').padEnd(14)}] ${url}`);
      if (meta.reasoning) console.log(`       └─ ${meta.reasoning}`);
    }
  }

  addPage(homepageUrl, {
    url: homepageUrl, tier: 1, category: 'home',
    reasoning: 'Starting point', discoveredVia: 'start',
  });

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 1 — Crawl homepage + level-1 deep
  // ────────────────────────────────────────────────────────────────────────────
  const crawlStart = Date.now();
  console.log(`\n🌐 Phase 1: Crawling homepage...`);

  visited.add(homepageUrl);
  const homepageLinks = await fetchPageLinks(context, homepageUrl, cfg.crawlTimeout);

  if (!homepageLinks) {
    console.error('❌ Could not load homepage');
    await browser.close();
    return { pages, stats };
  }

  // Collect unique same-domain links from homepage
  const rawLinkMap = new Map();
  for (const { href, text } of homepageLinks) {
    const norm = normalizeUrl(href, homepageUrl);
    if (!norm || !isSameDomain(norm, origin)) continue;
    if (isHardSkipped(norm)) { stats.hardSkipped++; continue; }
    if (!rawLinkMap.has(norm)) rawLinkMap.set(norm, { url: norm, text });
  }

  // ⚡ Level-1 deep crawl — concurrency-capped instead of all-at-once
  const level1Urls = [...rawLinkMap.keys()].slice(0, 30);
  console.log(`   Found ${rawLinkMap.size} links — crawling ${level1Urls.length} pages (${cfg.crawlConcurrency} concurrent)...`);

  const level1Tasks = level1Urls.map((url) => async () => {
    if (visited.has(url)) return;
    visited.add(url);

    const links = await fetchPageLinks(context, url, cfg.crawlTimeout);
    if (!links) return;

    for (const { href, text } of links) {
      const norm = normalizeUrl(href, url);
      if (!norm || !isSameDomain(norm, origin)) continue;
      if (isHardSkipped(norm)) { stats.hardSkipped++; continue; }
      if (!rawLinkMap.has(norm)) rawLinkMap.set(norm, { url: norm, text });
    }
  });

  await pooled(level1Tasks, cfg.crawlConcurrency);

  rawLinkMap.delete(homepageUrl);
  const allRawLinks = [...rawLinkMap.values()];
  stats.rawLinksFound = allRawLinks.length;
  stats.crawlTimeMs = Date.now() - crawlStart;

  console.log(`   ✓ ${allRawLinks.length} unique links in ${(stats.crawlTimeMs / 1000).toFixed(1)}s`);

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Rule-based page tagging from crawled links
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n🧭 Phase 2: Rule-based page classification (${allRawLinks.length} URLs)...`);

  for (const item of allRawLinks) {
    const rule = classifyByRules(item.url, homepageUrl);
    if (!rule) continue;
    addPage(item.url, {
      url: item.url,
      tier: rule.tier,
      category: rule.category,
      reasoning: rule.reasoning,
      discoveredVia: homepageUrl,
      isCoreLanding: rule.isCoreLanding,
      isSingleDetail: rule.isSingleDetail,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Rule-based drill into landing hubs for more detail pages
  // ────────────────────────────────────────────────────────────────────────────
  const drillUrls = [...rawLinkMap.keys()].filter((u) => {
    if (!u || visited.has(u)) return false;
    const lower = u.toLowerCase();
    return /\/(services?|solutions?|products?|collections?|shop|catalog)(\/)?$/.test(lower) || /\/collections\/[a-z0-9-]+(\/)?$/.test(lower);
  });

  if (drillUrls.length > 0) {
    console.log(`\n🔧 Phase 3: Drilling into ${drillUrls.length} landing hub(s)...`);

    const subPageLinks = new Map();
    const drillTasks = drillUrls.map((hubUrl) => async () => {
      console.log(`   → ${hubUrl}`);
      const links = await fetchPageLinks(context, hubUrl, cfg.crawlTimeout);
      if (!links) return;

      for (const { href, text } of links) {
        const norm = normalizeUrl(href, hubUrl);
        if (!norm || !isSameDomain(norm, origin)) continue;
        if (isHardSkipped(norm)) continue;
        if (!subPageLinks.has(norm)) subPageLinks.set(norm, { url: norm, text });
      }
    });

    await pooled(drillTasks, cfg.crawlConcurrency);

    const subPageList = [...subPageLinks.values()].slice(0, cfg.maxServiceSubPages * 8);
    let added = 0;
    for (const item of subPageList) {
      if (pages.has(item.url)) continue;
      const rule = classifyByRules(item.url, homepageUrl);
      if (!rule) continue;
      addPage(item.url, {
        url: item.url,
        tier: rule.tier,
        category: rule.category,
        reasoning: rule.reasoning,
        discoveredVia: 'rule-drill',
        isCoreLanding: rule.isCoreLanding,
        isSingleDetail: rule.isSingleDetail,
      });
      if (rule.isSingleDetail) {
        stats.serviceSubPagesFound++;
        added++;
      }
    }
    console.log(`   ✓ Added ${added} single service/product page(s) from hubs`);
  }

  await browser.close();

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 4 — Rule-based shortlisting
  // ────────────────────────────────────────────────────────────────────────────
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const meta of pages.values()) tierCounts[meta.tier] = (tierCounts[meta.tier] || 0) + 1;

  let pagesShortlistedForAudit = [];
  let selectionStrategy = '';
  const shortlistCandidates = buildShortlistCandidates(pages, homepageUrl);
  stats.shortlistCandidates = shortlistCandidates.length;

  console.log(`\n🎯 Phase 4: Shortlisting top ${cfg.auditLimit} pages for audit...`);
  pagesShortlistedForAudit = chooseDeterministicShortlist(shortlistCandidates, homepageUrl, cfg.auditLimit);
  stats.shortlistRecovered = pagesShortlistedForAudit.length;
  selectionStrategy = 'Rule-based shortlist: core landings first, then single service/product pages';

  console.log(`\n   Strategy: ${selectionStrategy}\n`);
  for (const p of pagesShortlistedForAudit) {
    const icon = p.auditPriority === 'critical' ? '🔴' : p.auditPriority === 'high' ? '🟠' : '🟡';
    console.log(`   ${String(p.rank).padStart(2)}. ${icon} [${(p.category || '').padEnd(14)}] ${p.url}`);
    console.log(`       └─ ${p.auditReason}`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`✅ Important pages identified : ${pages.size}`);
  console.log(`   Tier-1 (core)             : ${tierCounts[1]}`);
  console.log(`   Tier-2 (service pages)    : ${tierCounts[2]}`);
  console.log(`   Tier-3 (extras)           : ${tierCounts[3]}`);
  console.log(`   Shortlisted for audit     : ${pagesShortlistedForAudit.length}`);
  console.log(`   Raw links collected       : ${stats.rawLinksFound}`);
  console.log(`   Crawl time                : ${(stats.crawlTimeMs / 1000).toFixed(1)}s`);
  console.log(`   Rule matched pages        : ${stats.shortlistCandidates}`);
  console.log('──────────────────────────────────────────────────────────\n');

  return { pages, pagesShortlistedForAudit, selectionStrategy, stats };
}

module.exports = { fetchImportantPages };