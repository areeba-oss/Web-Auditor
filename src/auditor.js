'use strict';

/**
 * auditor.js — Main audit orchestrator
 *
 * Usage:
 *   node auditor.js https://stripe.com              ← homepage → crawl 10 pages → audit all
 *   node auditor.js https://stripe.com/pricing      ← specific page → audit directly
 *
 * Flow:
 *   Homepage URL  → fetchImportantPages() → shortlist 10 → run 6 layers on each
 *   Specific URL  → skip crawl           → run 6 layers on that page directly
 *
 * Layers:
 *   1. basicHealthCheck      — HTTP status, blank screen, JS errors, network failures
 *   2. uiLayoutCheck         — Header, footer, CTA, logo, responsive, overflow (AI vision)
 *   3. navigationLinksCheck  — Nav/internal/external/footer links (HEAD requests)
 *   4. formsCheck            — Empty submit, invalid email, error messages (AI vision)
 *   5. ecommerceCheck        — Product listing → detail → ATC → cart → checkout
 *   6. performanceCheck      — PSI API: FCP, LCP, CLS, TBT, TTFB (desktop + mobile)
 */

require('dotenv').config();

const fs                       = require('fs');
const { chromium }             = require('playwright-core');
const { fetchImportantPages }  = require('./utilities/fetchAllPages');
const { auditPageHealth }      = require('./audits/basicHealthCheck');
const { auditUILayout }        = require('./audits/uiLayoutCheck');
const { auditNavigationLinks } = require('./audits/navigationLinksCheck');
const { auditForms }           = require('./audits/formsCheck');
const { auditEcommerce }       = require('./audits/ecommerceCheck');
const { auditPerformance }     = require('./audits/performanceCheck');

// ─── Config ───────────────────────────────────────────────────────────────────

const AUDIT_TIMEOUT   = 30_000;   // per-layer timeout (ms)
const CRAWL_LIMIT     = 10;       // pages to shortlist when crawling homepage
const LAYER_DELAY_MS  = 500;      // small pause between layers (rate limit safety)
const OUTPUT_FILE     = 'results.json';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isHomepage(url) {
  try {
    const u = new (require('url').URL)(url);
    return u.pathname.replace(/\/$/, '') === '';
  } catch { return false; }
}

function getOrigin(url) {
  try { return new (require('url').URL)(url).origin; } catch { return url; }
}

function statusIcon(status) {
  if (status === 'healthy')  return '✅';
  if (status === 'warning')  return '⚠️ ';
  if (status === 'critical') return '🔴';
  return '—';
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function printSeparator(char = '─', len = 60) { console.log(char.repeat(len)); }

function printLayerHeader(n, name, url) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Layer ${n}: ${name}`);
  console.log(`  URL: ${url.slice(0, 80)}`);
  console.log('─'.repeat(60));
}

/**
 * Works for all layers.
 * For performance (which nests score/issues under desktop/mobile),
 * we pass the already-normalised flat wrapper — see normalisePerformance().
 */
function printLayerSummary(name, result) {
  if (!result) {
    console.log(`  ${name.padEnd(22)} ⚠️  skipped or crashed`);
    return;
  }
  const score  = result.score != null ? `${result.score}/100` : 'N/A';
  const status = statusIcon(result.overallStatus);
  const issues = (result.issues || []).filter(i => i.type !== 'info');
  console.log(`  ${name.padEnd(22)} ${status}  ${score.padEnd(7)}  ${issues.length > 0 ? issues[0].message.slice(0, 45) : 'No issues'}`);
}

// ─── Layer 6 normalisation ────────────────────────────────────────────────────
//
// The new performanceCheck returns:
//   { url, desktop: { score, overallStatus, lab, field, issues }, mobile: { … } }
//
// auditor.js (score weighting, printLayerSummary, results JSON) needs a flat
// shape with top-level score / overallStatus / issues.
//
// We keep the full desktop+mobile data intact and just add those top-level
// convenience fields so the rest of the file doesn't need special-casing.

function normalisePerformance(raw) {
  if (!raw) return null;

  // Already old-format (flat score/overallStatus) — nothing to do
  if (raw.score != null && !raw.desktop) return raw;

  const desktop = raw.desktop ?? {};
  const mobile  = raw.mobile  ?? {};

  // Representative score = desktop score (most auditors weight desktop)
  // Fall back to mobile if desktop failed
  const score         = desktop.score         ?? mobile.score         ?? null;
  const overallStatus = desktop.overallStatus ?? mobile.overallStatus ?? 'critical';

  // Merge issues from both strategies, deduplicated by code
  const seen   = new Set();
  const issues = [];
  for (const issue of [...(desktop.issues ?? []), ...(mobile.issues ?? [])]) {
    const key = `${issue.code}|${issue.device ?? ''}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  }

  return {
    ...raw,         // keep url, desktop, mobile untouched
    score,
    overallStatus,
    issues,
  };
}

// ─── Run all 6 layers on a single page ───────────────────────────────────────

async function auditPage(browser, pageUrl, homepageUrl, pageLabel) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  const result = {
    url:         pageUrl,
    label:       pageLabel,
    health:      null,
    ui:          null,
    navigation:  null,
    forms:       null,
    ecommerce:   null,
    performance: null,
    overallScore: null,
    completedAt: new Date().toISOString(),
  };

  try {

    // ── Layer 1: Basic Health ──────────────────────────────────────────────
    printLayerHeader(1, 'Basic Health Check', pageUrl);
    try {
      result.health = await auditPageHealth(context, pageUrl, AUDIT_TIMEOUT);
      console.log(`  Status: ${statusIcon(result.health.overallStatus)}  Score: ${result.health.score}/100`);
      console.log(`  HTTP: ${result.health.httpStatus}  Blank: ${result.health.blankScreen ? '❌' : '✅'}  JS errors: ${result.health.significantErrors?.length ?? 0}  Failed reqs: ${result.health.failedRequests?.length ?? 0}`);
    } catch (err) {
      console.warn(`  ⚠️  Layer 1 crashed: ${err.message.slice(0, 80)}`);
    }
    await sleep(LAYER_DELAY_MS);

    // Skip remaining layers if page returned an HTTP error
    if (result.health?.httpStatus != null && result.health.httpStatus >= 400) {
      console.log('\n  ⏭  Page returned HTTP error — skipping remaining layers');
      result.overallScore = 0;
      return result;
    }

    // ── Layer 2: UI Layout ─────────────────────────────────────────────────
    printLayerHeader(2, 'UI & Layout Check', pageUrl);
    try {
      result.ui = await auditUILayout(context, pageUrl, homepageUrl, AUDIT_TIMEOUT);
      console.log(`  Status: ${statusIcon(result.ui.overallStatus)}  Score: ${result.ui.score}/100`);
      const d = result.ui.details;
      if (d) {
        const hdr = d.header?.desktop?.visible ?? d.header?.mobile?.visible;
        const ftr = d.footer?.desktop?.visible ?? d.footer?.mobile?.visible;
        const cta = d.cta?.desktop?.found    ?? d.cta?.mobile?.found;
        const ovf = d.overflow?.hasOverflow;
        console.log(`  Header: ${hdr ? '✅' : '❌'}  Footer: ${ftr ? '✅' : '❌'}  CTA: ${cta ? '✅' : '❌'}  Overflow: ${ovf ? '❌' : '✅'}`);
        if (d.logo?.visible !== undefined) {
          console.log(`  Logo: ${d.logo.visible ? '✅' : '❌'}  Links home: ${d.logo.linksToHome ? '✅' : '❌'}`);
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  Layer 2 crashed: ${err.message.slice(0, 80)}`);
    }
    await sleep(LAYER_DELAY_MS);

    // ── Layer 3: Navigation & Links ────────────────────────────────────────
    //
    // IMPORTANT — broken link counting in summary:
    //   • nav    broken links → represent a site-wide nav issue (same nav on every page)
    //   • footer broken links → same — site-wide footer
    //   • internal broken links → page-specific content links  ✔ count per page
    //   • external broken links → page-specific content links  ✔ count per page
    //
    // The raw summary stores each region separately so buildReport.js can
    // deduplicate nav/footer broken links across pages in the site summary.
    // Here we just print an accurate per-page breakdown.

    printLayerHeader(3, 'Navigation & Links', pageUrl);
    try {
      result.navigation = await auditNavigationLinks(context, pageUrl, AUDIT_TIMEOUT);
      console.log(`  Status: ${statusIcon(result.navigation.overallStatus)}  Score: ${result.navigation.score}/100`);
      const s = result.navigation.summary;
      if (s) {
        console.log(`  Nav: ${s.nav?.total ?? 0} links (${s.nav?.broken ?? 0} broken)  Footer: ${s.footer?.total ?? 0} links (${s.footer?.broken ?? 0} broken)`);
        console.log(`  Internal: ${s.internal?.total ?? 0} links (${s.internal?.broken ?? 0} broken)  External: ${s.external?.total ?? 0} links (${s.external?.broken ?? 0} broken)`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Layer 3 crashed: ${err.message.slice(0, 80)}`);
    }
    await sleep(LAYER_DELAY_MS);

    // ── Layer 4: Forms ─────────────────────────────────────────────────────
    printLayerHeader(4, 'Forms Testing', pageUrl);
    try {
      result.forms = await auditForms(context, pageUrl, AUDIT_TIMEOUT);
      console.log(`  Status: ${statusIcon(result.forms.overallStatus)}  Score: ${result.forms.score}/100`);
      console.log(`  Forms found: ${result.forms.formsFound ?? 0}  Tested: ${result.forms.formsTested ?? 0}`);
      if (!result.forms.formsFound) console.log(`  ℹ️  No testable forms on this page`);
    } catch (err) {
      console.warn(`  ⚠️  Layer 4 crashed: ${err.message.slice(0, 80)}`);
    }
    await sleep(LAYER_DELAY_MS);

    // ── Layer 5: Ecommerce ─────────────────────────────────────────────────
    printLayerHeader(5, 'Ecommerce Flow', pageUrl);
    try {
      result.ecommerce = await auditEcommerce(context, pageUrl, AUDIT_TIMEOUT);
      if (!result.ecommerce?.isEcommerce) {
        console.log(`  ℹ️  Not an ecommerce page — skipped`);
      } else {
        console.log(`  Status: ${statusIcon(result.ecommerce.overallStatus)}  Score: ${result.ecommerce.score}/100`);
        console.log(`  Platform: ${result.ecommerce.platform ?? 'unknown'}  Confidence: ${result.ecommerce.confidence ?? '—'}`);
        const steps = ['productListing', 'productDetail', 'addToCart', 'cartPage', 'checkout'];
        const stepLine = steps.map(s => result.ecommerce[s]?.passed ? '✅' : (result.ecommerce[s]?.tested ? '❌' : '—')).join(' ');
        console.log(`  Funnel: ${stepLine}  (listing → detail → ATC → cart → checkout)`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Layer 5 crashed: ${err.message.slice(0, 80)}`);
    }
    await sleep(LAYER_DELAY_MS);

    // ── Layer 6: Performance (PSI API — desktop + mobile) ──────────────────
    //
    // auditPerformance() returns:
    //   { url, desktop: { score, overallStatus, lab, field, issues }, mobile: { … } }
    //
    // normalisePerformance() adds flat top-level score/overallStatus/issues
    // so printLayerSummary and the score weighting below work without changes.

    printLayerHeader(6, 'Performance (PSI)', pageUrl);
    try {
      const rawPerf = await auditPerformance(context, pageUrl, AUDIT_TIMEOUT);
      result.performance = normalisePerformance(rawPerf);

      const d = result.performance?.desktop;
      const m = result.performance?.mobile;

      console.log(`  Overall Status: ${statusIcon(result.performance?.overallStatus)}  Desktop Score: ${d?.score ?? '—'}/100  Mobile Score: ${m?.score ?? '—'}/100`);

      if (d?.lab) {
        console.log(`  Desktop — FCP: ${fmtMs(d.lab.fcp)}  LCP: ${fmtMs(d.lab.lcp)}  CLS: ${d.lab.cls ?? '—'}  TBT: ${fmtMs(d.lab.tbt)}  TTFB: ${fmtMs(d.lab.ttfb)}`);
      }
      if (m?.lab) {
        console.log(`  Mobile  — FCP: ${fmtMs(m.lab.fcp)}  LCP: ${fmtMs(m.lab.lcp)}  CLS: ${m.lab.cls ?? '—'}  TBT: ${fmtMs(m.lab.tbt)}  TTFB: ${fmtMs(m.lab.ttfb)}`);
      }

      const perfIssues = (result.performance?.issues ?? []).filter(i => i.type !== 'info');
      if (perfIssues.length > 0) {
        console.log(`  Top issue: ${perfIssues[0].message.slice(0, 70)}`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Layer 6 crashed: ${err.message.slice(0, 80)}`);
    }

    // ── Overall score — weighted average across all layers ─────────────────
    //
    // Ecommerce layer is only included when the page is actually an ecommerce page.
    // Performance uses the desktop score as the representative value (set by
    // normalisePerformance above).

    const scoreInputs = [
      { result: result.health,      weight: 20 },
      { result: result.ui,          weight: 20 },
      { result: result.navigation,  weight: 15 },
      { result: result.forms,       weight: 10 },
      { result: result.performance, weight: 20 },
      ...(result.ecommerce?.isEcommerce ? [{ result: result.ecommerce, weight: 15 }] : []),
    ].filter(s => s.result?.score != null);

    if (scoreInputs.length > 0) {
      const totalWeight = scoreInputs.reduce((s, x) => s + x.weight, 0);
      result.overallScore = Math.round(
        scoreInputs.reduce((s, x) => s + (x.result.score * x.weight), 0) / totalWeight,
      );
    }

  } finally {
    await context.close();
  }

  return result;
}

// ─── Print final page summary ─────────────────────────────────────────────────

function printPageSummary(pageResult) {
  const scoreStr = pageResult.overallScore != null ? `${pageResult.overallScore}/100` : 'N/A';
  const icon = pageResult.overallScore >= 80 ? '✅' : pageResult.overallScore >= 50 ? '⚠️ ' : '❌';

  printSeparator('═', 60);
  console.log(`  📄 ${pageResult.label}`);
  console.log(`  ${pageResult.url.slice(0, 70)}`);
  console.log(`  Overall Score: ${icon}  ${scoreStr}`);
  printSeparator('─');
  console.log('  Layer                  Status  Score    Top Issue');
  printSeparator('─');

  printLayerSummary('1. Health',      pageResult.health);
  printLayerSummary('2. UI Layout',   pageResult.ui);
  printLayerSummary('3. Navigation',  pageResult.navigation);
  printLayerSummary('4. Forms',       pageResult.forms);

  if (pageResult.ecommerce?.isEcommerce) {
    printLayerSummary('5. Ecommerce', pageResult.ecommerce);
  } else {
    console.log(`  ${'5. Ecommerce'.padEnd(22)} —   N/A     Not an ecommerce page`);
  }

  // Performance: show desktop + mobile scores side-by-side
  const perf = pageResult.performance;
  if (!perf) {
    console.log(`  ${'6. Performance'.padEnd(22)} ⚠️  skipped or crashed`);
  } else {
    const d     = perf.desktop;
    const m     = perf.mobile;
    const dScr  = d?.score != null ? `D:${d.score}` : 'D:—';
    const mScr  = m?.score != null ? `M:${m.score}` : 'M:—';
    const icon  = statusIcon(perf.overallStatus);
    const issue = (perf.issues ?? []).find(i => i.type !== 'info');
    console.log(`  ${'6. Performance'.padEnd(22)} ${icon}  ${(dScr + ' ' + mScr).padEnd(7)}  ${issue ? issue.message.slice(0, 40) : 'No issues'}`);
  }

  printSeparator('═', 60);
}

// ─── Print full audit summary ─────────────────────────────────────────────────

function printAuditSummary(allResults, totalMs) {
  console.log('\n\n');
  printSeparator('═', 60);
  console.log('  🏁  AUDIT COMPLETE — FULL SUMMARY');
  printSeparator('═', 60);
  console.log(`  Pages audited : ${allResults.length}`);
  console.log(`  Total time    : ${(totalMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log('  Page                                           Score');
  printSeparator('─');

  for (const r of allResults) {
    const label = r.label.slice(0, 42).padEnd(43);
    const score = r.overallScore != null ? `${r.overallScore}/100` : 'N/A ';
    const icon  = r.overallScore >= 80 ? '✅' : r.overallScore >= 50 ? '⚠️ ' : '❌';
    console.log(`  ${label} ${icon}  ${score}`);
  }

  printSeparator('─');

  const scored = allResults.filter(r => r.overallScore != null);
  if (scored.length > 0) {
    const avg  = Math.round(scored.reduce((s, r) => s + r.overallScore, 0) / scored.length);
    const icon = avg >= 80 ? '✅' : avg >= 50 ? '⚠️ ' : '❌';
    console.log(`  ${'Average Score'.padEnd(43)} ${icon}  ${avg}/100`);
  }

  // ── Critical issues across all pages ──────────────────────────────────────
  const allCriticals = allResults.flatMap(r => {
    const issues = [
      ...(r.health?.issues         || []),
      ...(r.ui?.issues             || []),
      ...(r.navigation?.issues     || []),
      ...(r.forms?.issues          || []),
      ...(r.ecommerce?.issues      || []),
      ...(r.performance?.issues    || []),  // already merged desktop+mobile by normalisePerformance
    ];
    return issues.filter(i => i.type === 'critical').map(i => ({ page: r.label, ...i }));
  });

  if (allCriticals.length > 0) {
    console.log('');
    printSeparator('─');
    console.log('  🔴  CRITICAL ISSUES ACROSS ALL PAGES:');
    printSeparator('─');
    for (const c of allCriticals.slice(0, 10)) {
      console.log(`  [${c.page.slice(0, 20).padEnd(20)}] [${c.code}] ${c.message.slice(0, 50)}`);
    }
    if (allCriticals.length > 10) console.log(`  ... and ${allCriticals.length - 10} more`);
  }

  // ── Navigation broken-link cross-page summary ──────────────────────────────
  //
  // nav + footer links are site-wide (same element on every page).
  // We deduplicate by URL so a broken nav link counts only once no matter
  // how many pages were audited.
  //
  // internal + external broken links are page-specific and counted as-is.

  const brokenNavUrls  = new Set();
  const brokenFootUrls = new Set();
  let   brokenIntCount = 0;
  let   brokenExtCount = 0;

  for (const r of allResults) {
    const details = r.navigation?.details ?? {};

    const isBroken = (l) =>
      l._broken ||
      (!l.ok && l.status !== 'timeout' && ![401, 403, 429].includes(l.status));

    (details.nav     ?? []).filter(isBroken).forEach(l => brokenNavUrls.add(l.url || l.href));
    (details.footer  ?? []).filter(isBroken).forEach(l => brokenFootUrls.add(l.url || l.href));
    brokenIntCount += (details.internal ?? []).filter(isBroken).length;
    brokenExtCount += (details.external ?? []).filter(isBroken).length;
  }

  const totalUniqueBroken = brokenNavUrls.size + brokenFootUrls.size + brokenIntCount + brokenExtCount;

  if (totalUniqueBroken > 0) {
    console.log('');
    printSeparator('─');
    console.log('  🔗  BROKEN LINKS SUMMARY (deduplicated):');
    printSeparator('─');
    if (brokenNavUrls.size  > 0) console.log(`  Nav links (site-wide, unique)  : ${brokenNavUrls.size}`);
    if (brokenFootUrls.size > 0) console.log(`  Footer links (site-wide, unique): ${brokenFootUrls.size}`);
    if (brokenIntCount      > 0) console.log(`  Internal links (page-specific)  : ${brokenIntCount}`);
    if (brokenExtCount      > 0) console.log(`  External links (page-specific)  : ${brokenExtCount}`);
    console.log(`  ──────────────────────────────────────────────`);
    console.log(`  Total unique broken              : ${totalUniqueBroken}`);
  }

  printSeparator('═', 60);
  console.log('');
}

// ─── Write results to JSON file ───────────────────────────────────────────────

function writeResultsFile(allResults, inputUrl, totalMs) {
  const scored       = allResults.filter(r => r.overallScore != null);
  const averageScore = scored.length > 0
    ? Math.round(scored.reduce((s, r) => s + r.overallScore, 0) / scored.length)
    : null;

  const output = {
    auditedUrl:   inputUrl,
    auditedAt:    new Date().toISOString(),
    totalTimeMs:  totalMs,
    pagesAudited: allResults.length,
    averageScore,
    pages:        allResults,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n💾  Results saved to ${OUTPUT_FILE}\n`);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

(async () => {
  const inputUrl = process.argv[2];

  if (!inputUrl) {
    console.error('\n❌  Usage: node auditor.js <url>');
    console.error('   Examples:');
    console.error('     node auditor.js https://stripe.com          ← full site audit (10 pages)');
    console.error('     node auditor.js https://stripe.com/pricing  ← single page audit\n');
    process.exit(1);
  }

  const auditStart = Date.now();
  const homepage   = getOrigin(inputUrl);
  const singlePage = !isHomepage(inputUrl);

  console.log('\n' + '═'.repeat(60));
  console.log('  🔍  SITE AUDIT');
  console.log('═'.repeat(60));
  console.log(`  URL    : ${inputUrl}`);
  console.log(`  Mode   : ${singlePage ? 'Single page (slug detected)' : `Full site (homepage → crawl ${CRAWL_LIMIT} pages)`}`);
  console.log(`  Layers : Health • UI • Navigation • Forms • Ecommerce • Performance`);
  console.log('═'.repeat(60) + '\n');

  const browser = await chromium.launch({ headless: true });

  try {
    // ── Determine pages to audit ─────────────────────────────────────────────
    let pagesToAudit = [];

    if (singlePage) {
      pagesToAudit = [{ url: inputUrl, label: 'Specified Page' }];
    } else {
      console.log(`🕸  Crawling site to find top ${CRAWL_LIMIT} pages...\n`);
      try {
        const crawlResult = await fetchImportantPages(inputUrl, { auditLimit: CRAWL_LIMIT });
        pagesToAudit = (crawlResult.pagesShortlistedForAudit || []).map(p => ({
          url:   p.url,
          label: p.category ? `${p.category} (rank ${p.rank})` : `Page ${p.rank}`,
        }));
        console.log(`\n✅ Crawl complete — ${pagesToAudit.length} pages shortlisted\n`);
        pagesToAudit.forEach((p, i) => console.log(`   ${String(i + 1).padStart(2)}. ${p.url}`));
        console.log('');
      } catch (err) {
        console.warn(`⚠️  Crawl failed: ${err.message} — falling back to homepage only`);
        pagesToAudit = [{ url: inputUrl, label: 'Homepage (crawl failed)' }];
      }
    }

    // ── Audit each page ──────────────────────────────────────────────────────
    const allResults = [];

    for (let i = 0; i < pagesToAudit.length; i++) {
      const { url, label } = pagesToAudit[i];
      console.log(`\n${'█'.repeat(60)}`);
      console.log(`  PAGE ${i + 1}/${pagesToAudit.length}: ${label}`);
      console.log(`  ${url}`);
      console.log('█'.repeat(60));

      const pageResult = await auditPage(browser, url, homepage, label);
      allResults.push(pageResult);
      printPageSummary(pageResult);

      // Polite pause between pages
      if (i < pagesToAudit.length - 1) await sleep(1000);
    }

    // ── Final summary + write output ─────────────────────────────────────────
    const totalMs = Date.now() - auditStart;
    printAuditSummary(allResults, totalMs);
    writeResultsFile(allResults, inputUrl, totalMs);

  } finally {
    await browser.close();
  }
})();