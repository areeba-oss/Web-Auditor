'use strict';

/**
 * test-nav.js — Quick test for navigationLinksCheck (Layer 3)
 * Usage:   node test-nav.js <url>
 * Example: node test-nav.js https://stripe.com
 */

require('dotenv').config();
const fs = require('fs');
const { chromium } = require('playwright-core');
const { auditNavigationLinks } = require('../audits/navigationLinksCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-nav.js <url>');
  process.exit(1);
}

const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const HEADLESS = String(process.env.NAV_HEADLESS || '').toLowerCase() === 'true';

(async () => {
  const start = Date.now();
  console.log(`\n🔗 Navigation & Links Audit: ${url}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const r = await auditNavigationLinks(context, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const BOT_BLOCKED = new Set([401, 403, 429]);
    function isSocialHost(linkUrl = '') {
      try {
        const host = new URL(linkUrl).hostname.toLowerCase();
        return (
          host.includes('facebook.com') ||
          host.includes('instagram.com') ||
          host === 'x.com' ||
          host.endsWith('.x.com') ||
          host.includes('twitter.com') ||
          host.includes('linkedin.com') ||
          host.includes('tiktok.com') ||
          host.includes('youtube.com') ||
          host.includes('youtu.be') ||
          host.includes('pinterest.com')
        );
      } catch {
        return false;
      }
    }
    const isBotBlocked = (l) => BOT_BLOCKED.has(l?.status) || (l?.status === 400 && isSocialHost(l?.url || ''));

    // ── Write raw results ─────────────────────────────────────────────────── ← added
    const outPath = 'raw.json';                                                // ← added
    fs.writeFileSync(outPath, JSON.stringify(r, null, 2), 'utf8');             // ← added
    console.log(`📄  Raw results saved → ${outPath}`);

    const banner =
      r.overallStatus === 'healthy' ? '✅ HEALTHY' :
        r.overallStatus === 'warning' ? '⚠️  WARNING' : '🔴 CRITICAL';

    console.log(`\n${banner}  (Score: ${r.score}/100)  —  ${elapsed}s\n`);

    // ── Summary table ─────────────────────────────────────────────────────────
    console.log('── SUMMARY ───────────────────────────────────────────');
    console.log('   Region      Total   Broken   Timeout   Redirected');
    console.log('   ──────────────────────────────────────────────────');

    for (const [region, s] of Object.entries(r.summary ?? {})) {
      const details = r.details?.[region] ?? [];
      const redirected = details.filter((l) => l.ok && l.redirected).length;
      const broken = s.broken ?? 0;
      const timeout = s.timedOut ?? 0;
      const total = s.total ?? 0;

      const brokenStr = broken > 0 ? `❌ ${broken}` : `✅ 0`;
      const timeoutStr = timeout > 0 ? `⚠️  ${timeout}` : `✅ 0`;
      const redirStr = redirected > 0 ? `ℹ️  ${redirected}` : '—';

      console.log(`   ${region.padEnd(11)} ${String(total).padEnd(7)} ${brokenStr.padEnd(9)}  ${timeoutStr.padEnd(9)}  ${redirStr}`);
    }

    // ── 1. Nav links ─────────────────────────────────────────────────────────
    const nav = r.details?.nav ?? [];
    const navButtons = r.details?.navButtons ?? [];

    // Total nav items = links + JS-dropdown buttons
    const navTotal = nav.length + navButtons.length;
    console.log(`\n── 1. NAV LINKS  (${navTotal} items: ${nav.length} links + ${navButtons.length} JS-dropdown buttons) ──`);

    // Show JS-dropdown buttons (can't be HEAD-checked)
    if (navButtons.length > 0) {
      console.log(`   ℹ️  JS dropdown triggers (no href — not checkable):`);
      for (const b of navButtons.slice(0, 8)) {
        console.log(`      ≡  "${b.text}"`);
      }
    }

    if (nav.length === 0) {
      console.log('   ⚠️  No checkable nav links found');
    } else {
      for (const link of nav.slice(0, 12)) {
        const icon = link.status === 'js-anchor'
          ? '🧩'
          : !link.ok
          ? (link.status === 'timeout' ? '⏱ ' : (isBotBlocked(link) ? `🛡️ [${link.status}]` : `❌ [${link.status}]`))
          : (link.redirected ? 'ℹ️ ' : '✅');
        const text = link.text ? ` "${link.text.slice(0, 30)}"` : '';
        console.log(`   ${icon}  ${link.url.slice(0, 80)}${text}`);
        if (link.redirected) console.log(`         ↳ redirects to ${link.finalUrl?.slice(0, 80)}`);
      }
      if (nav.length > 12) console.log(`   ... and ${nav.length - 12} more`);
    }

    // ── 2. Internal links ─────────────────────────────────────────────────────
    const internal = r.details?.internal ?? [];
    const intBroken = internal.filter((l) => !l.ok && l.status !== 'timeout' && !isBotBlocked(l));
    const intBotBlocked = internal.filter((l) => isBotBlocked(l));
    console.log(`\n── 2. INTERNAL LINKS  (${internal.length} checked) ────────────`);

    if (intBroken.length === 0) {
      console.log('   ✅  All internal links working');
    } else {
      console.log(`   ❌  ${intBroken.length} broken:`);
      for (const link of intBroken.slice(0, 8)) {
        const text = link.text ? ` — "${link.text.slice(0, 30)}"` : '';
        console.log(`      [${link.status}] ${link.url.slice(0, 90)}${text}`);
      }
      if (intBroken.length > 8) console.log(`      ... and ${intBroken.length - 8} more`);
    }

    if (intBotBlocked.length > 0) {
      const statusBreakdown = intBotBlocked.reduce((acc, l) => {
        const key = String(l.status);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      console.log(`   ℹ️  Bot-blocked (not counted as broken): ${Object.entries(statusBreakdown).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
    }

    const intRedirects = internal.filter((l) => l.ok && l.redirected);
    if (intRedirects.length > 0) {
      console.log(`\n   ℹ️  ${intRedirects.length} internal redirect(s):`);
      for (const link of intRedirects.slice(0, 3)) {
        console.log(`      ${link.url.slice(0, 70)} → ${link.finalUrl?.slice(0, 70)}`);
      }
    }

    // ── 3. External links ─────────────────────────────────────────────────────
    const external = r.details?.external ?? [];
    const extBroken = external.filter((l) => !l.ok && l.status !== 'timeout' && !isBotBlocked(l));
    const extBotBlocked = external.filter((l) => isBotBlocked(l));
    console.log(`\n── 3. EXTERNAL LINKS  (${external.length} checked) ────────────`);

    if (external.length === 0) {
      console.log('   ℹ️  No external links found');
    } else if (extBroken.length === 0) {
      console.log('   ✅  All external links working');
      // Show a few passing ones
      for (const link of external.slice(0, 4)) {
        const text = link.text ? ` "${link.text.slice(0, 25)}"` : '';
        console.log(`      ✅ ${link.url.slice(0, 70)}${text}`);
      }
      if (external.length > 4) console.log(`      ... and ${external.length - 4} more`);
    } else {
      console.log(`   ❌  ${extBroken.length} broken:`);
      for (const link of extBroken.slice(0, 5)) {
        console.log(`      [${link.status}] ${link.url.slice(0, 90)}`);
      }
    }

    if (extBotBlocked.length > 0) {
      const statusBreakdown = extBotBlocked.reduce((acc, l) => {
        const key = String(l.status);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      console.log(`   ℹ️  Bot-blocked (not counted as broken): ${Object.entries(statusBreakdown).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
    }

    // ── 4. Footer links ───────────────────────────────────────────────────────
    const footer = r.details?.footer ?? [];
    const footBroken = footer.filter((l) => !l.ok && l.status !== 'timeout' && !isBotBlocked(l));
    const footBotBlocked = footer.filter((l) => isBotBlocked(l));
    console.log(`\n── 4. FOOTER LINKS  (${footer.length} found) ──────────────────`);

    if (footer.length === 0) {
      console.log('   ⚠️  No footer links found');
    } else if (footBroken.length === 0) {
      console.log(`   ✅  All footer links working`);
      for (const link of footer.slice(0, 6)) {
        const text = link.text ? ` "${link.text.slice(0, 30)}"` : '';
        console.log(`      ✅ ${link.url.slice(0, 80)}${text}`);
      }
      if (footer.length > 6) console.log(`      ... and ${footer.length - 6} more`);
    } else {
      console.log(`   ❌  ${footBroken.length} broken:`);
      for (const link of footBroken.slice(0, 5)) {
        const text = link.text ? ` — "${link.text.slice(0, 25)}"` : '';
        console.log(`      [${link.status}] ${link.url.slice(0, 80)}${text}`);
      }
    }

    if (footBotBlocked.length > 0) {
      const statusBreakdown = footBotBlocked.reduce((acc, l) => {
        const key = String(l.status);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      console.log(`   ℹ️  Bot-blocked (not counted as broken): ${Object.entries(statusBreakdown).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
    }

    // ── Issues ────────────────────────────────────────────────────────────────
    if (r.issues?.length > 0) {
      console.log('\n── ISSUES ────────────────────────────────────────────');
      for (const issue of r.issues) {
        const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
        console.log(`   ${icon} [${issue.code}] ${issue.message}`);
        if (issue.detail) {
          for (const d of issue.detail.slice(0, 3)) {
            console.log(`       └─ ${d.slice(0, 100)}`);
          }
        }
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