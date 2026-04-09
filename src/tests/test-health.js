'use strict';

/**
 * test-health.js — Quick test for basicHealthCheck (Layer 1)
 *
 * Usage:   node test-health.js <url>
 * Example: node test-health.js https://example.com
 *
 * RAW MODE — real Chrome UA, no bot detection, no filtering.
 * Results match what you see in Chrome DevTools.
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditPageHealth } = require('../audits/basicHealthCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-health.js <url>');
  process.exit(1);
}

// ── Chrome path — override via CHROME_PATH env var ──────────────────────────
const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ── Real Chrome User-Agent ───────────────────────────────────────────────────
// Matches a standard Windows Chrome install.
// To get YOUR exact UA: open Chrome → chrome://version → copy "User Agent"
// Then set it via env: CHROME_USER_AGENT="Mozilla/5.0 ..."
const CHROME_USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

(async () => {
  const start = Date.now();
  console.log(`\n🏥 Health Check: ${url}`);
  console.log(`   UA: ${CHROME_USER_AGENT}\n`);

  const browser = await chromium.launch({
    headless: false,           // headed = closest to real browser behaviour
    executablePath: CHROME_PATH,
    args: [
      '--disable-blink-features=AutomationControlled', // hides automation flag
      '--no-sandbox',
      '--disable-infobars',
    ],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'Asia/Karachi',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  try {
    const r = await auditPageHealth(context, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // ── Status banner ──────────────────────────────────────────────────────
    const banner =
      r.overallStatus === 'healthy' ? '✅ HEALTHY'
    : r.overallStatus === 'warning' ? '⚠️  WARNING'
    :                                  '🔴 CRITICAL';

    console.log(`${banner}  (Score: ${r.score}/100)  —  ${elapsed}s\n`);

    if (r.skipped) {
      console.log('── SKIP REASON ─────────────────────────────────────');
      console.log(`   ${r.skipReason || 'Health check skipped'}`);
      if (r.issues?.length) {
        for (const issue of r.issues) {
          console.log(`   ℹ️  [${issue.code}] ${issue.message}`);
        }
      }
      console.log('\n────────────────────────────────────────────────────\n');
      return;
    }

    // ── 1. HTTP Status ─────────────────────────────────────────────────────
    console.log('── 1. HTTP STATUS ───────────────────────────────────');
    console.log(`   Status  : ${r.httpStatus ?? 'N/A'}  ${r.httpOk ? '✅' : '❌'}`);
    if (r.wasRedirected) {
      console.log(`   Redirect: ${url}`);
      console.log(`         →  ${r.redirectedTo}`);
    }

    // ── 2. Blank Screen ────────────────────────────────────────────────────
    console.log('\n── 2. BLANK SCREEN / LAYOUT ────────────────────────');
    console.log(`   Blank   : ${r.blankScreen ? '❌ YES — ' + r.blankScreenReason : '✅ No'}`);
    console.log(`   Title   : "${r.pageTitle ?? '—'}"`);
    console.log(`   Body text length  : ${r.bodyTextLength} chars`);
    console.log(`   Visible elements  : ${r.visibleElementCount}`);

    // ── 3. Console Errors ──────────────────────────────────────────────────
    console.log('\n── 3. CONSOLE ERRORS & WARNINGS (RAW) ──────────────');
    console.log(`   Raw console: ${r.rawConsoleErrorCount ?? 0} error(s), ${r.rawConsoleWarningCount ?? 0} warning(s)`);

    if (r.significantErrors.length === 0) {
      console.log('   Errors  : ✅ None');
    } else {
      console.log(`   Errors  : ❌ ${r.significantErrors.length} error(s)`);
      r.significantErrors.slice(0, 10).forEach((e, i) => {
        console.log(`     ${i + 1}. ${e.slice(0, 140)}`);
      });
      if (r.significantErrors.length > 10) {
        console.log(`     ... and ${r.significantErrors.length - 10} more`);
      }
    }

    if (r.significantWarnings.length > 0) {
      console.log(`   Warnings: ⚠️  ${r.significantWarnings.length}`);
      r.significantWarnings.slice(0, 5).forEach((w, i) => {
        console.log(`     ${i + 1}. ${w.slice(0, 140)}`);
      });
    } else {
      console.log('   Warnings: ✅ None');
    }

    // ── 4. Network Failures ────────────────────────────────────────────────
    console.log('\n── 4. NETWORK FAILURES (RAW) ───────────────────────');

    if (r.criticalFailures.length > 0) {
      console.log(`   Critical: ❌ ${r.criticalFailures.length} (JS/CSS/API failed)`);
      r.criticalFailures.slice(0, 10).forEach((f, i) => {
        console.log(`     ${i + 1}. [${f.source ?? '?'}] ${f.url?.slice(0, 100)}`);
        console.log(`        Error: ${f.errorText}`);
        if (f.method) console.log(`        Method: ${f.method}  Type: ${f.resourceType}`);
      });
      if (r.criticalFailures.length > 10) {
        console.log(`     ... and ${r.criticalFailures.length - 10} more`);
      }
    } else {
      console.log('   Critical: ✅ None');
    }

    const nonCritical = r.failedRequests.filter(
      (f) => !r.criticalFailures.some((c) => c.url === f.url)
    );
    if (nonCritical.length > 0) {
      console.log(`   Other   : ⚠️  ${nonCritical.length} non-critical failed`);
      nonCritical.slice(0, 5).forEach((f, i) => {
        console.log(`     ${i + 1}. [${f.source ?? '?'}] ${f.url?.slice(0, 100)}`);
        console.log(`        Error: ${f.errorText}`);
      });
    } else {
      console.log('   Other   : ✅ None');
    }

    // ── All issues summary ─────────────────────────────────────────────────
    if (r.issues.length > 0) {
      console.log('\n── ISSUES SUMMARY ──────────────────────────────────');
      for (const issue of r.issues) {
        const icon =
          issue.type === 'critical' ? '🔴'
        : issue.type === 'warning'  ? '🟠'
        :                             'ℹ️ ';
        console.log(`   ${icon} [${issue.code}] ${issue.message}`);
        if (issue.detail) {
          (Array.isArray(issue.detail) ? issue.detail : [issue.detail])
            .slice(0, 3)
            .forEach((d) =>
              console.log(`       └─ ${typeof d === 'string' ? d.slice(0, 120) : JSON.stringify(d).slice(0, 120)}`)
            );
        }
      }
    }

    console.log('\n────────────────────────────────────────────────────\n');

  } finally {
    await browser.close();
  }
})();