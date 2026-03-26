'use strict';

/**
 * test-ecommerce.js — Quick test for ecommerceCheck (Layer 5)
 * Usage:   node test-ecommerce.js <url>
 * Example: node test-ecommerce.js https://demo.shopify.com
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditEcommerce } = require('../audits/ecommerceCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-ecommerce.js <url>');
  process.exit(1);
}

(async () => {
  const start = Date.now();
  console.log(`\n🛒 Ecommerce Audit: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const r = await auditEcommerce(context, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // ── Not an ecommerce site ──────────────────────────────────────────────
    if (!r.isEcommerce) {
      console.log(`\nℹ️  NOT ECOMMERCE  —  ${elapsed}s`);
      console.log(`   Site does not appear to sell products directly.`);
      if (r.issues?.[0]?.message) console.log(`   ${r.issues[0].message}`);
      console.log('');
      return;
    }

    // ── Status banner ──────────────────────────────────────────────────────
    const banner =
      r.overallStatus === 'healthy'  ? '✅ HEALTHY' :
      r.overallStatus === 'warning'  ? '⚠️  WARNING' : '🔴 CRITICAL';

    const platformStr = r.platform ? `  |  Platform: ${r.platform}` : '';
    const confStr     = `  |  Detection: ${r.confidence} confidence (${r.detectionMethod})`;

    console.log(`\n${banner}  (Score: ${r.score}/100)  —  ${elapsed}s`);
    console.log(`Ecommerce confirmed${platformStr}${confStr}\n`);

    // ── Funnel table ───────────────────────────────────────────────────────
    console.log('── PURCHASE FUNNEL ───────────────────────────────────');
    console.log('   Step              Status   Detail');
    console.log('   ──────────────────────────────────────────────────');

    const steps = [
      { label: '1. Product Listing',  step: r.productListing, weight: 20 },
      { label: '2. Product Detail',   step: r.productDetail,  weight: 20 },
      { label: '3. Add to Cart',      step: r.addToCart,      weight: 25 },
      { label: '4. Cart Page',        step: r.cartPage,       weight: 20 },
      { label: '5. Checkout Access',  step: r.checkout,       weight: 15 },
    ];

    for (const { label, step, weight } of steps) {
      const icon   = !step.tested ? '—  ' : step.passed ? '✅' : '❌';
      const status = !step.tested ? 'skipped' : step.passed ? `pass (+${weight}pts)` : `FAIL (0pts)`;
      const detail = (step.detail || '').slice(0, 65);
      console.log(`   ${label.padEnd(20)} ${icon}  ${status.padEnd(14)} ${detail}`);
    }

    // ── Per-step breakdown ─────────────────────────────────────────────────

    // 1. Product listing
    console.log(`\n── 1. PRODUCT LISTING ────────────────────────────────`);
    if (!r.productListing.tested) {
      console.log(`   ⚠️  Not tested — could not find a product listing URL`);
    } else {
      const pl = r.productListing;
      console.log(`   URL       : ${(pl.url || '—').slice(0, 80)}`);
      console.log(`   Status    : ${pl.passed ? '✅ Pass' : '❌ Fail'}`);
      console.log(`   Products  : ${pl.productCount} found  |  images:${pl.hasImages ? '✅' : '❌'}  prices:${pl.hasPrices ? '✅' : '❌'}  links:${pl.hasProductLinks ? '✅' : '❌'}`);
      if (pl.sampleProductUrl) console.log(`   Sample    : ${pl.sampleProductUrl.slice(0, 80)}`);
      if (pl.detail) console.log(`   Detail    : ${pl.detail}`);
    }

    // 2. Product detail
    console.log(`\n── 2. PRODUCT DETAIL ─────────────────────────────────`);
    if (!r.productDetail.tested) {
      console.log(`   ⚠️  Not tested — no product URL available`);
    } else {
      const pd = r.productDetail;
      console.log(`   URL       : ${(pd.url || '—').slice(0, 80)}`);
      console.log(`   Status    : ${pd.passed ? '✅ Pass' : '❌ Fail'}`);
      console.log(`   Elements  : title:${pd.hasProductTitle ? '✅' : '❌'}  price:${pd.hasPrice ? '✅' : '❌'}  images:${pd.hasImages ? '✅' : '❌'}  ATC btn:${pd.hasAddToCartBtn ? '✅' : '❌'}`);
      if (pd.detail) console.log(`   Detail    : ${pd.detail}`);
    }

    // 3. Add to cart
    console.log(`\n── 3. ADD TO CART ────────────────────────────────────`);
    if (!r.addToCart.tested) {
      console.log(`   ⚠️  Not tested — product detail audit failed`);
    } else {
      const atc = r.addToCart;
      console.log(`   Status    : ${atc.passed ? '✅ Cart updated' : '❌ No cart update detected'}`);
      if (atc.method)   console.log(`   Method    : ${atc.method}`);
      if (atc.cartCountBefore !== null) {
        console.log(`   Cart count: ${atc.cartCountBefore} → ${atc.cartCountAfter ?? '?'}`);
      }
      if (atc.detail)   console.log(`   Detail    : ${atc.detail}`);
    }

    // 4. Cart page
    console.log(`\n── 4. CART PAGE ──────────────────────────────────────`);
    if (!r.cartPage.tested) {
      console.log(`   ⚠️  Not tested — cart navigation failed`);
    } else {
      const cp = r.cartPage;
      console.log(`   URL       : ${(cp.url || '—').slice(0, 80)}`);
      console.log(`   Status    : ${cp.passed ? '✅ Pass' : '❌ Fail'}`);
      console.log(`   Elements  : items:${cp.hasItem ? '✅' : '❌'}  price:${cp.hasPrice ? '✅' : '❌'}  qty ctrl:${cp.hasQuantityControl ? '✅' : '❌'}  remove:${cp.hasRemoveOption ? '✅' : '❌'}`);
      if (cp.detail) console.log(`   Detail    : ${cp.detail}`);
    }

    // 5. Checkout
    console.log(`\n── 5. CHECKOUT ───────────────────────────────────────`);
    if (!r.checkout.tested) {
      console.log(`   ⚠️  Not tested — cart page not reachable`);
    } else {
      const co = r.checkout;
      console.log(`   URL       : ${(co.url || '—').slice(0, 80)}`);
      console.log(`   Status    : ${co.passed ? '✅ Accessible' : '❌ Not accessible'}`);
      if (co.requiresLogin) console.log(`   ℹ️  Requires login/account to proceed`);
      if (co.detail) console.log(`   Detail    : ${co.detail}`);
    }

    // ── AI observations ────────────────────────────────────────────────────
    if (r.aiAnalysis?.generalObservations) {
      console.log(`\n── AI OBSERVATIONS ───────────────────────────────────`);
      console.log(`   💡 ${r.aiAnalysis.generalObservations.slice(0, 140)}`);
    }

    // ── Issues ────────────────────────────────────────────────────────────
    const nonInfoIssues = (r.issues || []).filter(i => i.type !== 'info');
    if (r.issues?.length > 0) {
      console.log(`\n── ISSUES ────────────────────────────────────────────`);
      for (const issue of r.issues) {
        const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
        console.log(`   ${icon} [${issue.code}] ${issue.message}`);
      }
    } else {
      console.log(`\n── ISSUES ────────────────────────────────────────────`);
      console.log(`   ✅  No issues found — full purchase funnel working`);
    }

    console.log(`\n──────────────────────────────────────────────────────\n`);

  } finally {
    await browser.close();
  }
})();