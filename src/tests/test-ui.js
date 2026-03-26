'use strict';

/**
 * test-ui.js — Quick test for uiLayoutCheck (Layer 2)
 * Usage:   node test-ui.js <url>
 * Example: node test-ui.js https://stripe.com
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditUILayout } = require('../audits/uiLayoutCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-ui.js <url>');
  process.exit(1);
}

const homepageUrl = (() => {
  try { const u = new URL(url); return u.origin; } catch { return url; }
})();

(async () => {
  const start = Date.now();
  console.log(`\n🖼  UI & Layout Audit: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const r = await auditUILayout(context, url, homepageUrl);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const banner =
      r.overallStatus === 'healthy'  ? '✅ HEALTHY' :
      r.overallStatus === 'warning'  ? '⚠️  WARNING' : '🔴 CRITICAL';

    console.log(`\n${banner}  (Score: ${r.score}/100)  —  ${elapsed}s\n`);

    // ── 1. Header ─────────────────────────────────────────────────────────────
    console.log('── 1. HEADER ─────────────────────────────────────────');
    for (const [bp, info] of Object.entries(r.details?.header ?? {})) {
      const icon = info?.visible ? '✅' : '❌';
      const desc = info?.description ? `  "${info.description.slice(0, 60)}"` : '';
      console.log(`   ${bp.padEnd(8)} ${icon}${desc}`);
    }

    // ── 2. Footer ─────────────────────────────────────────────────────────────
    console.log('\n── 2. FOOTER ─────────────────────────────────────────');
    for (const [bp, info] of Object.entries(r.details?.footer ?? {})) {
      const icon = info?.visible ? '✅' : '❌';
      const desc = info?.description ? `  "${info.description.slice(0, 70)}"` : '';
      console.log(`   ${bp.padEnd(8)} ${icon}${desc}`);
    }

    // ── 3. CTA Buttons ────────────────────────────────────────────────────────
    // ctas shape from AI: { found: bool, count: number, examples: string[] }
    console.log('\n── 3. CTA BUTTONS ────────────────────────────────────');
    for (const [bp, ctas] of Object.entries(r.details?.cta ?? {})) {
      if (!ctas || !ctas.found) {
        console.log(`   ${bp.padEnd(8)} ❌  None found`);
      } else {
        const examples = (ctas.examples ?? []).slice(0, 3).map((e) => `"${e}"`).join(', ');
        console.log(`   ${bp.padEnd(8)} ✅  ${ctas.count ?? '?'} found — ${examples}`);
      }
    }

    // ── 4. Logo ───────────────────────────────────────────────────────────────
    console.log('\n── 4. LOGO ───────────────────────────────────────────');
    const logo = r.details?.logo;
    if (logo) {
      console.log(`   Visible      : ${logo.visible    ? '✅' : '❌'}${logo.description ? '  "' + logo.description.slice(0, 60) + '"' : ''}`);
      console.log(`   Clickable    : ${logo.linkFound  ? '✅' : '❌'}  (DOM link found)`);
      console.log(`   Links home   : ${logo.linksToHome ? '✅' : '❌'}${logo.href ? '  (' + logo.href.slice(0, 70) + ')' : ''}`);
    }

    // ── 5. Responsiveness ─────────────────────────────────────────────────────
    console.log('\n── 5. RESPONSIVENESS ─────────────────────────────────');

    const overflow  = r.details?.overflow;
    const mobileNav = r.details?.mobileNav;

    console.log(`   Overflow     : ${overflow?.hasOverflow
      ? '❌  Horizontal scroll at: ' + overflow.breakpoints.join(', ')
      : '✅  No horizontal overflow'}`);

    console.log(`   Mobile nav   : ${mobileNav?.hamburgerVisible
      ? '✅  Hamburger/toggle detected'
      : '⚠️   No hamburger detected — nav may be inaccessible on mobile'}`);

    // Per-breakpoint summary table
    console.log('\n   Breakpoint   Header   Footer   CTA      Overflow  MobileNav');
    console.log('   ──────────────────────────────────────────────────────────');
    for (const bp of (r.breakpointResults ?? [])) {
      const h  = bp.ai?.header?.visible            ? '✅' : '❌';
      const f  = bp.ai?.footer?.visible             ? '✅' : '❌';
      const c  = bp.ai?.ctas?.found                ? `✅ ${bp.ai.ctas.count ?? '?'}` : '❌ 0';
      const ov = bp.domOverflow                     ? '❌' : '✅';
      const mn = bp.breakpoint === 'mobile'
        ? (bp.ai?.mobileNav?.hamburgerVisible       ? '✅' : '❌')
        : '—';
      console.log(`   ${bp.breakpoint.padEnd(12)} ${h}       ${f}       ${c.padEnd(6)}   ${ov}        ${mn}`);
    }

    // ── Issues ────────────────────────────────────────────────────────────────
    if (r.issues?.length > 0) {
      console.log('\n── ISSUES ────────────────────────────────────────────');
      for (const issue of r.issues) {
        const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
        console.log(`   ${icon} [${issue.code}] ${issue.message}`);
      }
    } else {
      console.log('\n── ISSUES ────────────────────────────────────────────');
      console.log('   ✅  No issues found');
    }

    console.log('\n──────────────────────────────────────────────────────\n');

  } finally {
    await browser.close();
  }
})();