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
const { classifyUrlsWithAI, shortlistPagesForAudit } = require('./aiClassifier');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  crawlTimeout: 8_000,      // ⚡ reduced from 20s — we only need links, not full render
  maxUrlsToAI: 300,
  maxServiceSubPages: 20,
  auditLimit: 10,
  crawlConcurrency: 8,      // ⚡ max parallel browser pages open at once
};

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
    sentToAI: 0,
    aiSkipped: 0,
    serviceSubPagesFound: 0,
    errors: 0,
    aiCalls: 0,
    crawlTimeMs: 0,
    aiTimeMs: 0,
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
      if (isHardSkipped(norm)) { stats.hardSkipped++; return; }
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
  // PHASE 2 — AI classification (runs while Phase 3 crawl queues up)
  // ────────────────────────────────────────────────────────────────────────────
  const toSend = allRawLinks.slice(0, cfg.maxUrlsToAI);
  stats.sentToAI = toSend.length;

  console.log(`\n🤖 Phase 2: AI classifying ${toSend.length} URLs...`);

  const aiStart = Date.now();
  let aiResult;
  try {
    aiResult = await classifyUrlsWithAI(toSend, homepageUrl, 'initial');
    stats.aiCalls++;
    stats.aiSkipped = aiResult.skipped || 0;
  } catch (err) {
    console.error(`   ⚠️  AI classification failed: ${err.message}`);
    await browser.close();
    return { pages, stats };
  }

  stats.aiTimeMs = Date.now() - aiStart;

  const importantPages = aiResult.important || [];
  console.log(`\n   ✅ AI selected ${importantPages.length} pages in ${(stats.aiTimeMs / 1000).toFixed(1)}s\n`);

  for (const item of importantPages) {
    if (!item.url || item.url === homepageUrl) continue;
    addPage(item.url, {
      url: item.url,
      tier: item.tier || 1,
      category: item.category || 'other',
      reasoning: item.reasoning || '',
      discoveredVia: homepageUrl,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Drill into service hubs
  // ⚡ Only visit hubs NOT already crawled in Phase 1
  // ────────────────────────────────────────────────────────────────────────────
  const drillUrls = (aiResult.drillInto || []).filter(
    (u) => u && isSameDomain(u, origin) && !visited.has(u), // ⚡ skip already-visited
  );

  if (drillUrls.length > 0) {
    console.log(`\n🔧 Phase 3: Drilling into ${drillUrls.length} unvisited hub(s)...`);

    const subPageLinks = new Map();

    // ⚡ Concurrency-capped drill
    const drillTasks = drillUrls.map((hubUrl) => async () => {
      console.log(`   → ${hubUrl}`);
      const links = await fetchPageLinks(context, hubUrl, cfg.crawlTimeout);
      if (!links) return;

      for (const { href, text } of links) {
        const norm = normalizeUrl(href, hubUrl);
        if (!norm || !isSameDomain(norm, origin)) continue;
        if (isHardSkipped(norm)) return;
        if (pages.has(norm) || rawLinkMap.has(norm)) return; // ⚡ skip known URLs
        if (!subPageLinks.has(norm)) subPageLinks.set(norm, { url: norm, text });
      }
    });

    await pooled(drillTasks, cfg.crawlConcurrency);

    const subPageList = [...subPageLinks.values()].slice(0, cfg.maxServiceSubPages + 20);

    if (subPageList.length > 0) {
      console.log(`   Sending ${subPageList.length} new sub-page candidates to AI...`);
      try {
        const subAiResult = await classifyUrlsWithAI(subPageList, homepageUrl, 'subpages');
        stats.aiCalls++;

        const subPages = (subAiResult.important || []).slice(0, cfg.maxServiceSubPages);
        console.log(`\n   ✅ AI selected ${subPages.length} service sub-pages\n`);

        for (const item of subPages) {
          if (!item.url || pages.has(item.url)) continue;
          addPage(item.url, {
            url: item.url, tier: 2,
            category: item.category || 'service-page',
            reasoning: item.reasoning || '',
            discoveredVia: drillUrls[0],
          });
          stats.serviceSubPagesFound++;
        }
      } catch (err) {
        console.error(`   ⚠️  Sub-page AI failed: ${err.message}`);
      }
    } else {
      console.log(`   No new sub-pages found`);
    }
  } else if ((aiResult.drillInto || []).length > 0) {
    console.log(`\n🔧 Phase 3: All ${aiResult.drillInto.length} hub(s) already crawled in Phase 1 — skipping`);
  }

  await browser.close();

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 4 — AI shortlisting
  // ────────────────────────────────────────────────────────────────────────────
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const meta of pages.values()) tierCounts[meta.tier] = (tierCounts[meta.tier] || 0) + 1;

  let pagesShortlistedForAudit = [];
  let selectionStrategy = '';

  console.log(`\n🎯 Phase 4: Shortlisting top ${cfg.auditLimit} pages for audit...`);

  try {
    const shortlistResult = await shortlistPagesForAudit(pages, homepageUrl, cfg.auditLimit);
    stats.aiCalls++;
    pagesShortlistedForAudit = shortlistResult.shortlisted || [];
    selectionStrategy = shortlistResult.selectionStrategy || '';

    console.log(`\n   Strategy: ${selectionStrategy}\n`);
    for (const p of pagesShortlistedForAudit) {
      const icon = p.auditPriority === 'critical' ? '🔴' : p.auditPriority === 'high' ? '🟠' : '🟡';
      console.log(`   ${String(p.rank).padStart(2)}. ${icon} [${(p.category || '').padEnd(14)}] ${p.url}`);
      console.log(`       └─ ${p.auditReason}`);
    }
  } catch (err) {
    console.error(`   ⚠️  Shortlisting failed: ${err.message}`);
    pagesShortlistedForAudit = [...pages.values()]
      .sort((a, b) => a.tier - b.tier)
      .slice(0, cfg.auditLimit)
      .map((p, i) => ({
        rank: i + 1, url: p.url, category: p.category, tier: p.tier,
        auditPriority: p.tier === 1 ? 'critical' : 'high',
        auditReason: 'Fallback — AI unavailable',
      }));
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`✅ Important pages identified : ${pages.size}`);
  console.log(`   Tier-1 (core)             : ${tierCounts[1]}`);
  console.log(`   Tier-2 (service pages)    : ${tierCounts[2]}`);
  console.log(`   Tier-3 (extras)           : ${tierCounts[3]}`);
  console.log(`   Shortlisted for audit     : ${pagesShortlistedForAudit.length}`);
  console.log(`   Raw links collected       : ${stats.rawLinksFound}`);
  console.log(`   Crawl time                : ${(stats.crawlTimeMs / 1000).toFixed(1)}s`);
  console.log(`   AI time                   : ${(stats.aiTimeMs / 1000).toFixed(1)}s`);
  console.log(`   AI calls made             : ${stats.aiCalls}`);
  console.log('──────────────────────────────────────────────────────────\n');

  return { pages, pagesShortlistedForAudit, selectionStrategy, stats };
}

module.exports = { fetchImportantPages };