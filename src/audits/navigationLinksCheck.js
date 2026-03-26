'use strict';

const { URL } = require('url');

const CHECK_CONCURRENCY  = 8;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_INTERNAL_LINKS = 60;
const MAX_EXTERNAL_LINKS = 20;

const WEIGHTS = {
  navLinks:      30,
  internalLinks: 30,
  externalLinks: 20,
  footerLinks:   20,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function isSameDomain(href, origin) {
  try { return new URL(href).origin === origin; } catch { return false; }
}

// ─── normalizeUrl ─────────────────────────────────────────────────────────────
// Rule 1: bare "#"  alone               → null  (broken, handled in collectLinks)
// Rule 2: "#section", "#about", "#top"  → null  (skip — same-page jump)
// Rule 3: "/page#section", "https://x.com/page#about" → strip hash → check page
// Rule 4: everything else               → resolve and return

function normalizeUrl(href, base) {
  try {
    const raw = (href || '').trim();
    // Rules 1 & 2: anything starting with # → skip (bare # already flagged as broken in collectLinks)
    if (raw.startsWith('#')) return null;
    const u = new URL(raw, base);
    u.hash = '';
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

const SKIP_PATTERNS = [
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
  /\.(pdf|docx?|xlsx?|zip|png|jpg|jpeg|gif|svg|webp|mp4|mp3)(\?|$)/i,
  /\/(wp-admin|wp-login)\b/i,
  /[?&](utm_|fbclid|gclid)/,
  /[?&]add-to-cart=/i,
];

function shouldSkip(url) {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function pooled(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ─── HTTP check ───────────────────────────────────────────────────────────────
// attempt 1 = HEAD  (fast)
// attempt 2 = GET   (only if HEAD returns 405 Method Not Allowed)
// Uses real browser UA to avoid anti-bot 404s (storeleads etc.)

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

async function checkUrl(href, attempt = 1) {
  const method = attempt === 1 ? 'HEAD' : 'GET';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(href, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    clearTimeout(timer);

    // Retry with GET only if server rejects HEAD method
    if (attempt === 1 && res.status === 405) return checkUrl(href, 2);

    return {
      url:        href,
      finalUrl:   res.url !== href ? res.url : null,
      status:     res.status,
      ok:         res.status >= 200 && res.status < 400,
      redirected: res.url !== href,
      method,
    };
  } catch (err) {
    const isTimeout = err.name === 'AbortError' || err.message?.includes('abort');
    return {
      url:    href,
      status: isTimeout ? 'timeout' : 'error',
      ok:     false,
      error:  isTimeout ? 'Request timed out' : err.message?.slice(0, 100),
      method,
    };
  }
}

// ─── DOM extraction ───────────────────────────────────────────────────────────

async function extractLinksByRegion(page, pageUrl) {
  return page.evaluate(() => {

    // ── collectLinks: uses getAttribute (raw href) not a.href (resolved) ──
    // a.href resolves "#" to "https://site.com/#" — we lose the raw "#"
    // getAttribute gives us the actual value in HTML
    function collectLinks(roots, region) {
      const rootList = Array.isArray(roots) ? roots : (roots ? [roots] : []);
      const links = [];
      for (const root of rootList) {
        if (!root) continue;
        for (const a of root.querySelectorAll('a[href]')) {
          const raw      = (a.getAttribute('href') || '').trim();
          const resolved = a.href || '';
          const text     = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().slice(0, 80);

          // Bare "#" only → broken placeholder (NOT "#section")
          if (raw === '#' || raw === '#!' || raw === '' || raw === 'javascript:void(0)' || raw === 'javascript:;') {
            links.push({ href: raw || '#', text, region, _broken: true, _brokenReason: 'empty-anchor' });
            continue;
          }

          // "#section" style → skip (valid same-page jump)
          if (raw.startsWith('#')) continue;

          // Only collect http/https resolved URLs
          if (!resolved.startsWith('http')) continue;
          links.push({ href: resolved, raw, text, region });
        }
      }
      return links;
    }

    // ── Nav: all <nav> elements inside header + standalone navs ──────────
    const navRoots = [];
    const headerEl = document.querySelector('header') || document.querySelector('[role="banner"]');
    if (headerEl) {
      const navsInHeader = Array.from(headerEl.querySelectorAll('nav'));
      navRoots.push(...(navsInHeader.length > 0 ? navsInHeader : [headerEl]));
    }
    const standaloneNavs = Array.from(document.querySelectorAll('nav'))
      .filter(n => !navRoots.some(r => r.contains(n) || n.contains(r)));
    navRoots.push(...standaloneNavs);
    if (navRoots.length === 0) {
      const fb = document.querySelector('[role="navigation"]') || document.querySelector('nav');
      if (fb) navRoots.push(fb);
    }

    const navLinks = collectLinks(navRoots, 'nav');

    // Nav buttons (JS dropdowns — no href)
    const navButtons = [];
    for (const root of navRoots) {
      Array.from(root.querySelectorAll('button, [role="menuitem"], [role="button"]'))
        .filter(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
          return t.length >= 2 && !/^[\s\W]+$/.test(t) && !/^(close|menu|toggle|open|×|☰)$/i.test(t);
        })
        .forEach(el => navButtons.push({ text: el.innerText?.trim().slice(0, 60), type: 'button-trigger', region: 'nav' }));
    }

    // ── Footer ────────────────────────────────────────────────────────────
    const footerEl = document.querySelector('footer') || document.querySelector('[role="contentinfo"]');
    const footerLinks = collectLinks(footerEl, 'footer');

    // ── Body: scan all <a> but EXCLUDE those inside nav or footer ─────────
    // This is the fix for links appearing in wrong region
    const excludeEls = [...navRoots, ...(footerEl ? [footerEl] : [])];
    const bodyLinks = [];
    for (const a of document.body.querySelectorAll('a[href]')) {
      if (excludeEls.some(el => el && el.contains(a))) continue;

      const raw      = (a.getAttribute('href') || '').trim();
      const resolved = a.href || '';
      const text     = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().slice(0, 80);

      if (raw === '#' || raw === '#!' || raw === '' || raw === 'javascript:void(0)' || raw === 'javascript:;') {
        bodyLinks.push({ href: raw || '#', text, region: 'body', _broken: true, _brokenReason: 'empty-anchor' });
        continue;
      }
      if (raw.startsWith('#')) continue;
      if (!resolved.startsWith('http')) continue;
      bodyLinks.push({ href: resolved, raw, text, region: 'body' });
    }

    // ── Per-region dedup ──────────────────────────────────────────────────
    // Real URLs: dedup by href within each region
    // Broken anchors: keep ALL — each is a separate broken link
    function dedupRegion(links) {
      const seen = new Set();
      return links.filter(l => {
        if (l._broken) return true;           // keep every broken anchor
        if (seen.has(l.href)) return false;
        seen.add(l.href);
        return true;
      });
    }

    return {
      links: [
        ...dedupRegion(navLinks),
        ...dedupRegion(footerLinks),
        ...dedupRegion(bodyLinks),
      ],
      navButtons,
    };
  });
}

// ─── Categorise ───────────────────────────────────────────────────────────────

function categoriseLinks(rawLinks, pageUrl, origin) {
  const nav = [], footer = [], internal = [], external = [];

  for (const link of rawLinks) {

    // Pre-flagged broken anchors — push directly without normalizing
    if (link._broken) {
      const entry = {
        url:     link.href,
        text:    link.text,
        region:  link.region,
        status:  'broken-anchor',
        ok:      false,
        error:   'Empty anchor (#) — placeholder link with no destination',
        _broken: true,
      };
      if (link.region === 'nav')    nav.push(entry);
      if (link.region === 'footer') footer.push(entry);
      if (link.region === 'body')   internal.push(entry);
      continue;
    }

    const norm = normalizeUrl(link.href, pageUrl);
    if (!norm || shouldSkip(norm)) continue;

    const entry = { url: norm, text: link.text, region: link.region };
    const same  = isSameDomain(norm, origin);

    if (link.region === 'nav')    nav.push(entry);
    if (link.region === 'footer') footer.push(entry);
    if (link.region === 'body') {
      if (same) internal.push(entry);
      else      external.push(entry);
    }
  }

  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(e => {
      if (e._broken) return true;
      if (seen.has(e.url)) return false;
      seen.add(e.url); return true;
    });
  };

  return {
    nav:      dedup(nav),
    footer:   dedup(footer),
    internal: dedup(internal).slice(0, MAX_INTERNAL_LINKS),
    external: dedup(external).slice(0, MAX_EXTERNAL_LINKS),
  };
}

// ─── Check link group ─────────────────────────────────────────────────────────

async function checkLinkGroup(links, label) {
  if (links.length === 0) return [];

  const toCheck     = links.filter(l => !l._broken);
  const preResolved = links.filter(l =>  l._broken);

  const anchorNote = preResolved.length > 0 ? ` + ${preResolved.length} broken anchor(s)` : '';
  console.log(`   🔗 Checking ${toCheck.length} ${label} links (${CHECK_CONCURRENCY} concurrent)${anchorNote}...`);

  if (toCheck.length === 0) return preResolved;

  const tasks   = toCheck.map(link => () => checkUrl(link.url));
  const results = await pooled(tasks, CHECK_CONCURRENCY);
  const checked = toCheck.map((link, i) => ({ ...link, ...results[i] }));
  return [...checked, ...preResolved];
}

// ─── Analyse results ──────────────────────────────────────────────────────────

function analyseResults(checked) {
  const { nav, footer, internal, external, navButtons = [] } = checked;
  const issues = [];
  let score = 100;

  // 403/429/401 = bot-blocked, not truly broken — real users can access
  const BOT_BLOCKED = new Set([401, 403, 429]);
  const isBroken    = (r) => r._broken || (!r.ok && r.status !== 'timeout' && !BOT_BLOCKED.has(r.status));
  const isBotBlocked = (r) => BOT_BLOCKED.has(r.status);
  const isTimedOut  = (r) => r.status === 'timeout';
  const isRedirect  = (r) => r.ok && r.redirected;

  // Nav
  const navBroken  = nav.filter(isBroken);
  const navTimeout = nav.filter(isTimedOut);
  if (nav.length === 0) {
    score -= Math.round(WEIGHTS.navLinks * 0.5);
    issues.push({ type: 'warning', code: 'NAV_NO_LINKS', message: 'No navigation links found in header/nav' });
  } else if (navBroken.length > 0) {
    score -= Math.round(WEIGHTS.navLinks * Math.min((navBroken.length / nav.length) * 2, 1));
    issues.push({
      type:   navBroken.length >= 3 ? 'critical' : 'warning',
      code:   'NAV_BROKEN_LINKS',
      message: `${navBroken.length} of ${nav.length} nav link(s) are broken`,
      detail: navBroken.slice(0, 5).map(r => `[${r.status || 'broken-anchor'}] ${r.url} — "${r.text}"`),
    });
  }

  // Internal
  const intBroken  = internal.filter(isBroken);
  const intTimeout = internal.filter(isTimedOut);
  if (intBroken.length > 0) {
    score -= Math.round(WEIGHTS.internalLinks * Math.min((intBroken.length / internal.length) * 2, 1));
    issues.push({
      type:    intBroken.length >= 5 ? 'critical' : 'warning',
      code:    'INTERNAL_BROKEN_LINKS',
      message: `${intBroken.length} broken internal link(s) (out of ${internal.length} checked)`,
      detail:  intBroken.slice(0, 5).map(r => `[${r.status || 'broken-anchor'}] ${r.url}`),
    });
  }
  if (intTimeout.length > 3) {
    score -= 5;
    issues.push({ type: 'warning', code: 'INTERNAL_TIMEOUTS', message: `${intTimeout.length} internal links timed out` });
  }

  // External
  const extBroken  = external.filter(isBroken);
  if (extBroken.length > 0) {
    score -= Math.round(WEIGHTS.externalLinks * Math.min((extBroken.length / Math.max(external.length, 1)) * 2, 1));
    issues.push({
      type:    'warning',
      code:    'EXTERNAL_BROKEN_LINKS',
      message: `${extBroken.length} broken external link(s) (out of ${external.length} checked)`,
      detail:  extBroken.slice(0, 5).map(r => `[${r.status}] ${r.url}`),
    });
  }

  // Footer
  const footBroken  = footer.filter(isBroken);
  const footTimeout = footer.filter(isTimedOut);
  if (footer.length === 0) {
    score -= Math.round(WEIGHTS.footerLinks * 0.3);
    issues.push({ type: 'info', code: 'FOOTER_NO_LINKS', message: 'No footer links detected' });
  } else if (footBroken.length > 0) {
    score -= Math.round(WEIGHTS.footerLinks * Math.min((footBroken.length / footer.length) * 2, 1));
    issues.push({
      type:    'warning',
      code:    'FOOTER_BROKEN_LINKS',
      message: `${footBroken.length} broken footer link(s) (out of ${footer.length} checked)`,
      detail:  footBroken.slice(0, 5).map(r => `[${r.status || 'broken-anchor'}] ${r.url} — "${r.text}"`),
    });
  }

  // Redirects
  const allChecked = [...nav, ...internal, ...external, ...footer];
  const redirects  = allChecked.filter(isRedirect);
  const botBlocked = allChecked.filter(isBotBlocked);

  if (redirects.length > 0) {
    issues.push({
      type:    'info',
      code:    'REDIRECTED_LINKS',
      message: `${redirects.length} link(s) redirect — consider updating to final URL`,
      detail:  redirects.slice(0, 3).map(r => `${r.url} → ${r.finalUrl}`),
    });
  }
  if (botBlocked.length > 0) {
    const s = {}; botBlocked.forEach(r => { s[r.status] = (s[r.status]||0)+1; });
    issues.push({
      type:    'info',
      code:    'BOT_BLOCKED_LINKS',
      message: `${botBlocked.length} link(s) bot-blocked (${Object.entries(s).map(([k,v])=>`${v}× ${k}`).join(', ')}) — accessible to real users`,
      detail:  botBlocked.slice(0, 3).map(r => `[${r.status}] ${r.url}`),
    });
  }

  score = Math.max(0, score);
  const criticals = issues.filter(i => i.type === 'critical');
  const warnings  = issues.filter(i => i.type === 'warning');

  return {
    score,
    overallStatus: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
    issues,
    summary: {
      nav:      { total: nav.length,      broken: navBroken.length,   timedOut: navTimeout.length  },
      internal: { total: internal.length, broken: intBroken.length,   timedOut: intTimeout.length  },
      external: { total: external.length, broken: extBroken.length,   timedOut: external.filter(isTimedOut).length },
      footer:   { total: footer.length,   broken: footBroken.length,  timedOut: footTimeout.length },
    },
    details: { nav, navButtons, internal, external, footer },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function auditNavigationLinks(context, url, timeout = 30_000) {
  const page   = await context.newPage();
  const origin = getOrigin(url);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response   = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const httpStatus = response?.status() ?? null;

    if (!httpStatus || httpStatus >= 400) {
      return { url, httpStatus, overallStatus: 'critical', score: 0,
        issues: [{ type: 'critical', code: 'PAGE_LOAD_FAILED', message: `HTTP ${httpStatus}` }],
        summary: {}, details: {} };
    }

    try {
      await page.waitForFunction(() => (document.body?.innerText?.trim().length ?? 0) > 100, { timeout: 5_000 });
    } catch {}

    console.log(`   🕸  Extracting links from DOM...`);
    const extracted  = await extractLinksByRegion(page, url);
    await page.close();

    const rawLinks   = extracted.links;
    const navButtons = extracted.navButtons ?? [];
    const categorised = categoriseLinks(rawLinks, url, origin);

    console.log(`   Found — nav:${categorised.nav.length}  footer:${categorised.footer.length}  internal:${categorised.internal.length}  external:${categorised.external.length}`);

    const [navChecked, footerChecked, internalChecked, externalChecked] = await Promise.all([
      checkLinkGroup(categorised.nav,      'nav'),
      checkLinkGroup(categorised.footer,   'footer'),
      checkLinkGroup(categorised.internal, 'internal'),
      checkLinkGroup(categorised.external, 'external'),
    ]);

    const analysis = analyseResults({ nav: navChecked, footer: footerChecked, internal: internalChecked, external: externalChecked, navButtons });
    return { url, httpStatus, ...analysis };

  } catch (err) {
    return { url, httpStatus: null, overallStatus: 'critical', score: 0,
      issues: [{ type: 'critical', code: 'AUDIT_FATAL', message: `Nav check crashed: ${err.message}` }],
      summary: {}, details: {}, fatalError: err.message };
  } finally {
    try { await page.close(); } catch {}
  }
}

module.exports = { auditNavigationLinks };