'use strict';

/**
 * test-health.js — Quick test for basicHealthCheck (Layer 1)
 * Usage:  node test-health.js <url>
 * Example: node test-health.js https://example.com
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditPageHealth } = require('../audits/basicHealthCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-health.js <url>');
  process.exit(1);
}

(async () => {
  const start = Date.now();
  console.log(`\n🏥 Health Check: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const r = await auditPageHealth(context, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // ── Status banner ──────────────────────────────────────────────────────
    const banner = r.overallStatus === 'healthy' ? '✅ HEALTHY'
                 : r.overallStatus === 'warning' ? '⚠️  WARNING'
                 : '🔴 CRITICAL';

    console.log(`${banner}  (Score: ${r.score}/100)  —  ${elapsed}s\n`);

    // ── 1. HTTP Status ─────────────────────────────────────────────────────
    console.log('── 1. HTTP STATUS ───────────────────────────────────');
    console.log(`   Status  : ${r.httpStatus ?? 'N/A'}  ${r.httpOk ? '✅' : '❌'}`);
    if (r.wasRedirected) {
      console.log(`   Redirect: ${url}`);
      console.log(`         → ${r.redirectedTo}`);
    }

    // ── 2. Blank Screen ────────────────────────────────────────────────────
    console.log('\n── 2. BLANK SCREEN / LAYOUT ────────────────────────');
    console.log(`   Blank   : ${r.blankScreen ? '❌ YES — ' + r.blankScreenReason : '✅ No'}`);
    console.log(`   Title   : "${r.pageTitle ?? '—'}"`);
    console.log(`   Body text length  : ${r.bodyTextLength} chars`);
    console.log(`   Visible elements  : ${r.visibleElementCount}`);

    // ── 3. Console Errors ──────────────────────────────────────────────────
    console.log('\n── 3. CONSOLE ERRORS & WARNINGS ────────────────────');
    if (r.significantErrors.length === 0) {
      console.log('   Errors  : ✅ None');
    } else {
      console.log(`   Errors  : ❌ ${r.significantErrors.length} significant JS error(s)`);
      r.significantErrors.slice(0, 5).forEach((e, i) => {
        console.log(`     ${i + 1}. ${e.slice(0, 120)}`);
      });
    }

    if (r.significantWarnings.length > 0) {
      console.log(`   Warnings: ⚠️  ${r.significantWarnings.length}`);
      r.significantWarnings.slice(0, 3).forEach((w, i) => {
        console.log(`     ${i + 1}. ${w.slice(0, 120)}`);
      });
    } else {
      console.log('   Warnings: ✅ None');
    }

    console.log(`   Noise filtered : ${r.filteredNoise.length} (analytics/trackers — ignored)`);

    // ── 4. Network Failures ────────────────────────────────────────────────
    console.log('\n── 4. NETWORK FAILURES ─────────────────────────────');
    if (r.criticalFailures.length > 0) {
      console.log(`   Critical: ❌ ${r.criticalFailures.length} (JS/CSS/API failed)`);
      r.criticalFailures.slice(0, 5).forEach((f, i) => {
        console.log(`     ${i + 1}. ${f.url?.slice(0, 100)}`);
        console.log(`        Error: ${f.errorText}`);
      });
    } else {
      console.log('   Critical: ✅ None');
    }

    if (r.failedRequests.length > 0) {
      console.log(`   Other   : ⚠️  ${r.failedRequests.length} non-critical failed`);
    } else {
      console.log('   Other   : ✅ None');
    }

    console.log(`   Blocked (trackers): ${r.blockedRequests.length}`);

    // ── All issues summary ─────────────────────────────────────────────────
    if (r.issues.length > 0) {
      console.log('\n── ISSUES SUMMARY ──────────────────────────────────');
      for (const issue of r.issues) {
        const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
        console.log(`   ${icon} [${issue.code}] ${issue.message}`);
        if (issue.detail) {
          (Array.isArray(issue.detail) ? issue.detail : [issue.detail])
            .slice(0, 2)
            .forEach((d) => console.log(`       └─ ${typeof d === 'string' ? d.slice(0, 100) : JSON.stringify(d).slice(0, 100)}`));
        }
      }
    }

    console.log('\n────────────────────────────────────────────────────\n');

  } finally {
    await browser.close();
  }
})();