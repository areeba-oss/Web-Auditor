'use strict';

/**
 * test-crawl.js — Quick test for fetchImportantPages
 * Usage: node test-crawl.js <url>
 * Example: node test-crawl.js https://example.com
 */

require('dotenv').config();
const { fetchImportantPages } = require('../utilities/fetchAllPages');

const url = process.argv[2];

if (!url) {
  console.error('❌  Usage: node test-crawl.js <url>');
  console.error('    Example: node test-crawl.js https://stripe.com');
  process.exit(1);
}

(async () => {
  const start = Date.now();
  console.log(`\n🚀 Testing fetchImportantPages on: ${url}\n`);

  try {
    const { pages, pagesShortlistedForAudit, selectionStrategy, stats } = await fetchImportantPages(url);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // Group by tier for display
    const byTier = { 1: [], 2: [], 3: [] };
    for (const [pageUrl, meta] of pages) {
      byTier[meta.tier].push({ url: pageUrl, ...meta });
    }

    // Print results
    if (byTier[1].length) {
      console.log('📌 TIER 1 — Core Pages:');
      for (const p of byTier[1]) {
        console.log(`   [${p.category.padEnd(14)}] ${p.url}`);
      }
    }

    if (byTier[2].length) {
      console.log('\n🔧 TIER 2 — Service Sub-Pages:');
      for (const p of byTier[2]) {
        console.log(`   [${p.category.padEnd(14)}] ${p.url}`);
        console.log(`                    ↳ via ${p.discoveredVia}`);
      }
    }

    if (byTier[3].length) {
      console.log('\n📎 TIER 3 — Extras:');
      for (const p of byTier[3]) {
        console.log(`   [${p.category.padEnd(14)}] ${p.url}`);
      }
    }

    // ── Shortlisted pages for audit ─────────────────────────────────────────
    if (pagesShortlistedForAudit?.length) {
      console.log('\n🎯 SHORTLISTED FOR AUDIT:');
      console.log(`   Strategy: ${selectionStrategy}`);
      console.log('');
      for (const p of pagesShortlistedForAudit) {
        const icon = p.auditPriority === 'critical' ? '🔴' : p.auditPriority === 'high' ? '🟠' : '🟡';
        console.log(`   ${String(p.rank).padStart(2)}. ${icon} ${p.url}`);
        console.log(`       ${p.auditReason}`);
      }
    }

    console.log('\n────────────────────────────────────────────────');
    console.log(`  Total discovered : ${pages.size}`);
    console.log(`  Shortlisted      : ${pagesShortlistedForAudit?.length ?? 0}`);
    console.log(`  Tier 1           : ${byTier[1].length}`);
    console.log(`  Tier 2           : ${byTier[2].length}`);
    console.log(`  Tier 3           : ${byTier[3].length}`);
    console.log(`  Raw links        : ${stats.rawLinksFound}`);
    console.log(`  AI calls         : ${stats.aiCalls}`);
    console.log(`  Errors           : ${stats.errors}`);
    console.log(`  Time taken       : ${elapsed}s`);
    console.log('────────────────────────────────────────────────\n');

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();