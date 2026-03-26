'use strict';

/**
 * test-perf.js — Quick test for performanceCheck (Layer 6)
 * Usage:   node test-perf.js <url>
 * Example: node test-perf.js https://stripe.com
 */

require('dotenv').config();
const { auditPerformance } = require('../audits/performanceCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-perf.js <url>');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ratingIcon(r) {
  if (r === 'good')              return '✅';
  if (r === 'needs-improvement') return '⚠️ ';
  if (r === 'poor')              return '❌';
  return '— ';
}

function categoryIcon(c) {
  if (!c) return '— ';
  if (c === 'FAST')    return '✅';
  if (c === 'AVERAGE') return '⚠️ ';
  return '❌';
}

function fmt(ms) {
  if (ms == null) return '—  ';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function statusBanner(r) {
  if (r.overallStatus === 'healthy') return '✅ HEALTHY';
  if (r.overallStatus === 'warning') return '⚠️  WARNING';
  return '🔴 CRITICAL';
}

// ─── Print one device result ──────────────────────────────────────────────────

function printResult(r) {
  const isMobile    = r.label === 'Mobile';
  const deviceLabel = isMobile
    ? `📱 MOBILE  (${r.viewport})`
    : `🖥️  DESKTOP (${r.viewport})`;

  console.log(`\n${'═'.repeat(58)}`);
  console.log(` ${deviceLabel}`);
  console.log(`${'═'.repeat(58)}`);
  console.log(` ${statusBanner(r)}  (Score: ${r.score}/100)`);
  console.log(` Data source: Google PageSpeed Insights API (Lighthouse)`);
  console.log(`${'═'.repeat(58)}\n`);

  if (!r.lab) {
    console.log('❌  No data collected\n');
    for (const issue of r.issues ?? []) {
      console.log(`   🔴 [${issue.code}] ${issue.message}`);
    }
    return;
  }

  const m = r.lab;

  // ── Lab data (Lighthouse) ──────────────────────────────────────────────────
  console.log('── LAB DATA  (Lighthouse) ────────────────────────────');
  console.log('   Metric                   Value      Rating   Threshold');
  console.log('   ──────────────────────────────────────────────────────');
  console.log(`   FCP  First Contentful Paint  ${fmt(m.fcp).padEnd(9)} ${ratingIcon(m.fcpRating)}  good < 1.8s`);
  console.log(`   LCP  Largest Content Paint   ${fmt(m.lcp).padEnd(9)} ${ratingIcon(m.lcpRating)}  good < 2.5s`);
  console.log(`   CLS  Layout Shift            ${(m.cls != null ? m.cls.toFixed(3) : '—').padEnd(9)} ${ratingIcon(m.clsRating)}  good < 0.1`);
  console.log(`   TBT  Total Blocking Time     ${fmt(m.tbt).padEnd(9)} ${ratingIcon(m.tbtRating)}  good < 200ms`);
  console.log(`   SI   Speed Index             ${fmt(m.si).padEnd(9)} ${ratingIcon(m.siRating)}  good < 3.4s`);
  console.log(`   TTI  Time to Interactive     ${fmt(m.tti).padEnd(9)} ${ratingIcon(m.ttiRating)}  good < 3.8s`);
  if (m.ttfb != null) {
    console.log(`   TTFB Server Response Time   ${fmt(m.ttfb).padEnd(9)} ℹ️     good < 800ms`);
  }
  console.log('');

  // ── Field data (CrUX real users) ──────────────────────────────────────────
  if (r.field) {
    const f = r.field;
    const overall = f.overallCategory
      ? `${categoryIcon(f.overallCategory)} ${f.overallCategory}`
      : '— No data';

    console.log('── FIELD DATA  (Real users — 28 day p75) ─────────────');
    console.log(`   Overall CWV Assessment   ${overall}`);
    console.log('   Metric                   p75        Rating');
    console.log('   ──────────────────────────────────────────────────────');
    if (f.fcp?.p75  != null) console.log(`   FCP                      ${fmt(f.fcp.p75).padEnd(9)}  ${categoryIcon(f.fcp.category)}`);
    if (f.lcp?.p75  != null) console.log(`   LCP                      ${fmt(f.lcp.p75).padEnd(9)}  ${categoryIcon(f.lcp.category)}`);
    if (f.cls?.p75  != null) console.log(`   CLS                      ${f.cls.p75.toFixed(3).padEnd(9)}  ${categoryIcon(f.cls.category)}`);
    if (f.inp?.p75  != null) console.log(`   INP                      ${fmt(f.inp.p75).padEnd(9)}  ${categoryIcon(f.inp.category)}`);
    if (f.ttfb?.p75 != null) console.log(`   TTFB                     ${fmt(f.ttfb.p75).padEnd(9)}  ${categoryIcon(f.ttfb.category)}`);
    console.log('');
  } else {
    console.log('── FIELD DATA ────────────────────────────────────────');
    console.log('   ℹ️  No real-user data available for this URL');
    console.log('');
  }

  // ── Issues / Opportunities ─────────────────────────────────────────────────
  console.log('── ISSUES & OPPORTUNITIES ────────────────────────────');
  if (r.issues?.length > 0) {
    for (const issue of r.issues) {
      const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
      console.log(`   ${icon} [${issue.code}] ${issue.message}`);
    }
  } else {
    console.log('   ✅  All performance metrics within good range');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const start = Date.now();
  console.log(`\n⚡ Performance Audit: ${url}`);
  console.log(`   Source: Google PageSpeed Insights API\n`);

  try {
    // Note: no browser/context needed anymore — PSI API handles everything
    const result  = await auditPerformance(null, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`   ⏱  Total audit time: ${elapsed}s`);

    printResult(result.desktop);
    printResult(result.mobile);

    console.log(`\n${'═'.repeat(58)}`);
    console.log(' 📊 SUMMARY');
    console.log(`${'═'.repeat(58)}`);
    console.log(`   🖥️  Desktop   ${String(result.desktop.score).padStart(3)}/100   ${statusBanner(result.desktop)}`);
    console.log(`   📱 Mobile    ${String(result.mobile.score).padStart(3)}/100   ${statusBanner(result.mobile)}`);
    console.log(`${'═'.repeat(58)}\n`);

  } catch (err) {
    console.error('❌  Audit failed:', err.message);
    process.exit(1);
  }
})();