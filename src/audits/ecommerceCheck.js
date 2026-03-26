'use strict';

/**
 * ecommerceCheck.js — Layer 5 audit: Ecommerce Flow Testing
 */

const sharp = require('sharp');

const AI_MODEL        = 'claude-haiku-4-5-20251001';
const MAX_TOKENS      = 1400;
const MAX_IMG_HEIGHT  = 7800;
const INTERACTION_WAIT = 1200;
const NAV_TIMEOUT     = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) { try { return JSON.parse(block[1].trim()); } catch {} }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error(`Non-JSON: ${text.slice(0, 150)}`);
}

async function resizeIfNeeded(buffer) {
  const meta = await sharp(buffer).metadata();
  if ((meta.height ?? 0) > MAX_IMG_HEIGHT) {
    return sharp(buffer).resize({ height: MAX_IMG_HEIGHT, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
  }
  return buffer;
}

async function takeScreenshot(page) {
  let buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false });
  buf = await resizeIfNeeded(buf);
  return buf.toString('base64');
}

const WEIGHTS = {
  productListing: 20,
  productDetail:  20,
  addToCart:      25,
  cartPage:       20,
  checkout:       15,
};

async function detectEcommerceDOM(page) {
  return page.evaluate(() => {
    const signals = [];
    const doc = document;
    const generator = doc.querySelector('meta[name="generator"]')?.content || '';
    if (/shopify/i.test(generator))     signals.push({ type: 'platform', value: 'Shopify',     weight: 10 });
    if (/woocommerce/i.test(generator)) signals.push({ type: 'platform', value: 'WooCommerce', weight: 10 });
    if (/magento/i.test(generator))     signals.push({ type: 'platform', value: 'Magento',     weight: 10 });
    if (/bigcommerce/i.test(generator)) signals.push({ type: 'platform', value: 'BigCommerce', weight: 10 });
    const jsonLds = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (const el of jsonLds) {
      try {
        const data = JSON.parse(el.textContent || '');
        const types = [].concat(data['@type'] || []);
        if (types.some(t => /product|offer|store/i.test(t)))
          signals.push({ type: 'structured-data', value: types.join(','), weight: 8 });
      } catch {}
    }
    const cartEls = doc.querySelectorAll('[class*="cart"],[id*="cart"],[data-cart],[aria-label*="cart" i],[class*="basket"],[id*="basket"],[class*="bag"],[data-testid*="cart"]');
    if (cartEls.length > 0) signals.push({ type: 'cart-element', value: `${cartEls.length} found`, weight: 6 });
    const priceEls = doc.querySelectorAll('[class*="price"],[itemprop="price"],[class*="Price"],[data-price],.price,#price,[class*="amount"]');
    if (priceEls.length > 0) signals.push({ type: 'price-elements', value: `${priceEls.length} found`, weight: 5 });
    const atcBtns = Array.from(doc.querySelectorAll('button,[role="button"],input[type="submit"]'))
      .filter(el => /add.{0,10}cart|buy.{0,5}now|shop.now|add.to.bag/i.test(el.innerText || el.value || el.getAttribute('aria-label') || ''));
    if (atcBtns.length > 0) signals.push({ type: 'atc-button', value: `${atcBtns.length} found`, weight: 7 });
    const productGrids = doc.querySelectorAll('[class*="product-grid"],[class*="ProductGrid"],[class*="products-grid"],[class*="product-list"],[class*="ProductList"],[data-product-id],.products,#products,[class*="product-item"],[class*="ProductItem"]');
    if (productGrids.length > 0) signals.push({ type: 'product-grid', value: `${productGrids.length} found`, weight: 6 });
    const checkoutLinks = Array.from(doc.querySelectorAll('a[href]'))
      .filter(a => /checkout|proceed.to.pay|place.order/i.test(a.href + (a.innerText || '')));
    if (checkoutLinks.length > 0) signals.push({ type: 'checkout-link', value: checkoutLinks[0]?.href?.slice(0, 80), weight: 7 });
    const scripts = Array.from(doc.querySelectorAll('script[src]')).map(s => s.src);
    const links   = Array.from(doc.querySelectorAll('link[href]')).map(l => l.href);
    const allSrcs = [...scripts, ...links].join(' ');
    if (/cdn\.shopify/i.test(allSrcs))        signals.push({ type: 'cdn', value: 'Shopify CDN',  weight: 9 });
    if (/woocommerce/i.test(allSrcs))         signals.push({ type: 'cdn', value: 'WooCommerce',  weight: 9 });
    if (/static\.bigcommerce/i.test(allSrcs)) signals.push({ type: 'cdn', value: 'BigCommerce',  weight: 9 });
    const path = location.pathname.toLowerCase();
    if (/\/shop|\/store|\/products?|\/collections?/.test(path))
      signals.push({ type: 'url-path', value: path, weight: 4 });
    const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
    const platform = signals.find(s => s.type === 'platform')?.value || signals.find(s => s.type === 'cdn')?.value?.split(' ')[0] || null;
    const hasAtcBtn = signals.some(s => s.type === 'atc-button');
    const hasGrid   = signals.some(s => s.type === 'product-grid');
    const currentType = hasAtcBtn ? 'product-detail' : hasGrid ? 'product-listing' : /cart/i.test(path) ? 'cart' : /checkout/i.test(path) ? 'checkout' : 'unknown';
    return { isEcommerce: totalWeight >= 8, confidence: totalWeight >= 15 ? 'high' : totalWeight >= 8 ? 'medium' : 'low', domScore: totalWeight, signals, platform, currentPageType: currentType };
  });
}

async function detectWithAI(page, url, domResult, screenshotB64) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const snapshot = await page.evaluate(() => {
    const parts = [`URL: ${location.href}`, `TITLE: ${document.title}`];
    document.querySelectorAll('h1,h2,h3').forEach(h => parts.push(`${h.tagName}: ${h.innerText?.trim().slice(0, 80)}`));
    document.querySelectorAll('button,[role="button"],a').forEach(el => { const t = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60); if (t) parts.push(`BTN/LINK: ${t}`); });
    document.querySelectorAll('[class*="price"],[itemprop="price"],[data-price]').forEach(el => { const t = el.innerText?.trim().slice(0, 40); if (t) parts.push(`PRICE: ${t}`); });
    return parts.slice(0, 60).join('\n');
  });
  const system = `You are an ecommerce audit expert. Analyze the provided screenshot and page snapshot.
Return ONLY valid JSON — no markdown, no extra text.
{"isEcommerce":true,"confidence":"high|medium|low","platform":"Shopify|WooCommerce|Magento|BigCommerce|custom|null","currentPageType":"home|product-listing|product-detail|cart|checkout|other","productListingUrl":"full URL or null","sampleProductUrls":["up to 3 product URLs"],"addToCartSelector":"CSS selector or null","cartUrl":"URL or null","checkoutUrl":"URL or null","reasoning":"one sentence"}
Rules: isEcommerce true only if site sells products with buy flow. SaaS/service/lead-gen = NOT ecommerce.`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: [
        { type: 'text', text: `DOM signals: ${JSON.stringify(domResult.signals.slice(0, 8))}\n\nPage snapshot:\n${snapshot}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotB64 } },
        { type: 'text', text: 'Is this an ecommerce site? Identify the shopping flow entry points.' },
      ]}] }),
    });
    if (res.status === 429) { await sleep(8000); return null; }
    if (!res.ok) return null;
    return parseJSON((await res.json()).content?.[0]?.text || '');
  } catch { return null; }
}

async function findProductListingUrl(page, origin, aiHints = {}) {
  if (aiHints.productListingUrl) return aiHints.productListingUrl;
  const commonPaths = ['/shop', '/store', '/products', '/collections', '/collections/all', '/catalog'];
  for (const p of commonPaths) {
    const candidate = `${origin}${p}`;
    try { const res = await fetch(candidate, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) }); if (res.ok) return candidate; } catch {}
  }
  const domLink = await page.evaluate((origin) => {
    const navEls = document.querySelectorAll('nav a[href], header a[href], [class*="nav"] a[href]');
    for (const a of navEls) {
      const href = a.href;
      if (!href.startsWith(origin)) continue;
      const text = (a.innerText || '').toLowerCase().trim();
      const path = new URL(href).pathname.toLowerCase();
      if (/shop|store|products|collection|catalog|buy/i.test(text) || /^\/shop|^\/store|^\/products|^\/collections/.test(path)) return href;
    }
    return null;
  }, origin);
  return domLink;
}

async function auditProductListing(context, listingUrl, aiHints = {}) {
  const result = { tested: false, passed: false, url: listingUrl, productCount: 0, hasImages: false, hasPrices: false, hasProductLinks: false, sampleProductUrl: null, detail: null, screenshot: null };
  if (!listingUrl) { result.detail = 'No product listing URL found'; return result; }
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(listingUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    if (!res?.ok()) { result.detail = `HTTP ${res?.status()} on listing page`; return result; }
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
    result.tested = true;
    result.screenshot = await takeScreenshot(page);
    const domCheck = await page.evaluate(() => {
      const productSelectors = ['[class*="product-item"]','[class*="ProductItem"]','[class*="product-card"]','[class*="ProductCard"]','[class*="product-grid"] > *','[class*="products"] > li','[data-product-id]','[itemtype*="Product"]','.product','.product-item','.product-card'];
      let productEls = [];
      for (const sel of productSelectors) { const els = document.querySelectorAll(sel); if (els.length > 0) { productEls = Array.from(els); break; } }
      if (productEls.length === 0) productEls = Array.from(document.querySelectorAll('[class*="price"]')).map(el => el.closest('li, article, div[class*="item"]')).filter(Boolean);
      const withImages = productEls.filter(el => el.querySelector('img, svg, [class*="thumb"], [class*="Thumb"]')).length;
      const withPrices = productEls.filter(el => el.querySelector('[class*="price"],[itemprop="price"],[data-price]') || /\$|€|£|¥|\d+\.\d{2}/.test(el.innerText || '')).length;
      const PRODUCT_PATH  = /\/(products?|items?|p)\/[^/?#]+/i;
      const CATEGORY_PATH = /\/(product-category|tag|category|categories)\//i;
      const SKIP_PATH     = /\/(cart|checkout|account|login|logout|wishlist|search|filter|#)/i;
      function getElHref(el) { if (el.tagName === 'A' && el.href) return el.href; const child = el.querySelector('a[href]'); if (child) return child.href; const parent = el.closest('a[href]'); if (parent) return parent.href; return null; }
      const allProductHrefs = productEls.map(el => getElHref(el)).filter(href => href && !SKIP_PATH.test(href) && href !== location.href);
      const bestProductLink = allProductHrefs.find(href => PRODUCT_PATH.test(href) && !CATEGORY_PATH.test(href)) || allProductHrefs.find(href => !CATEGORY_PATH.test(href)) || null;
      const allPageProductLink = !bestProductLink ? (() => { const allAnchors = Array.from(document.querySelectorAll('a[href]')); return allAnchors.map(a => a.href).find(href => href && href.startsWith(location.origin) && PRODUCT_PATH.test(href) && !CATEGORY_PATH.test(href) && !SKIP_PATH.test(href) && href !== location.href) || null; })() : null;
      return { productCount: productEls.length, withImages, withPrices, withLinks: allProductHrefs.filter(Boolean).length, sampleLink: bestProductLink || allPageProductLink || null };
    });
    result.productCount = domCheck.productCount;
    result.hasImages = domCheck.withImages > 0;
    result.hasPrices = domCheck.withPrices > 0;
    result.hasProductLinks = domCheck.withLinks > 0;
    const CATEGORY_PATH_RE = /\/(product-category|tag|category|categories)\//i;
    const aiProductUrl = (aiHints.sampleProductUrls || []).find(u => u && !CATEGORY_PATH_RE.test(u));
    result.sampleProductUrl = aiProductUrl || domCheck.sampleLink;
    result.passed = result.productCount > 0 && (domCheck.withImages > 0 || domCheck.withPrices > 0 || domCheck.withLinks > 0);
    result.detail = result.passed ? `${result.productCount} products found (${domCheck.withImages} w/ images, ${domCheck.withPrices} w/ prices)` : `Listing page loaded but ${result.productCount === 0 ? 'no product elements detected' : 'products found but missing both images and prices'}`;
  } catch (err) { result.detail = `Listing audit failed: ${err.message.slice(0, 80)}`; } finally { await page.close(); }
  return result;
}

async function auditProductDetail(context, productUrl) {
  const result = { tested: false, passed: false, url: productUrl, hasProductTitle: false, hasPrice: false, hasImages: false, hasAddToCartBtn: false, addToCartSelector: null, detail: null, screenshot: null };
  if (!productUrl) { result.detail = 'No product URL to test'; return result; }
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(productUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    if (!res?.ok()) { result.detail = `HTTP ${res?.status()} on product page`; return result; }
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
    result.tested = true;
    result.screenshot = await takeScreenshot(page);
    const domCheck = await page.evaluate(() => {
      function isVisible(el) { if (!el) return false; const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
      const h1 = document.querySelector('h1');
      const hasTitle = !!(h1 && h1.innerText?.trim().length > 2 && isVisible(h1));
      const priceEl = document.querySelector('[class*="price"]:not([class*="compare"]),[itemprop="price"],[data-price],.price,[class*="Price"]:not([class*="Compare"])');
      const hasPrice = !!(priceEl && isVisible(priceEl) && priceEl.innerText?.trim());
      const imgEls = Array.from(document.querySelectorAll('[class*="product"] img,[class*="Product"] img,[class*="gallery"] img,[data-product-image],.product-image img')).filter(isVisible);
      const atcSelectors = ['[data-add-to-cart]','[data-action="add-to-cart"]','form[action*="cart"] button[type="submit"]','button[class*="add"][class*="cart"]','button[class*="AddToCart"]','button[class*="add-to-cart"]','[id*="add-to-cart"]','#add-to-cart'];
      let atcBtn = null, atcSelector = null;
      for (const sel of atcSelectors) { const el = document.querySelector(sel); if (el && isVisible(el)) { atcBtn = el; atcSelector = sel; break; } }
      if (!atcBtn) { const btns = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')); atcBtn = btns.find(b => { const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim(); return isVisible(b) && /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now/i.test(t); }); if (atcBtn) atcSelector = `button:contains("${(atcBtn.innerText||'').trim().slice(0,20)}")`; }
      return { hasTitle, titleText: h1?.innerText?.trim().slice(0, 60) || null, hasPrice, priceText: priceEl?.innerText?.trim().slice(0, 20) || null, hasImages: imgEls.length > 0, imageCount: imgEls.length, hasAtcBtn: !!atcBtn, atcSelector, atcText: (atcBtn?.innerText || atcBtn?.value || '').trim().slice(0, 40) };
    });
    result.hasProductTitle = domCheck.hasTitle;
    result.hasPrice = domCheck.hasPrice;
    result.hasImages = domCheck.hasImages;
    result.hasAddToCartBtn = domCheck.hasAtcBtn;
    result.addToCartSelector = domCheck.atcSelector;
    const isCategoryUrl = /\/(product-category|category|categories|collections?\/(?![\w-]+-\d|all$))/i.test(productUrl);
    result.isCategoryPage = isCategoryUrl;
    result.siteType = domCheck.hasAtcBtn ? 'transactional' : domCheck.hasPrice ? 'price-visible' : domCheck.hasImages ? 'catalog-style' : 'unknown';
    result.passed = !isCategoryUrl && result.hasProductTitle;
    const parts = [];
    if (isCategoryUrl)        parts.push(`⚠️ URL appears to be a category page, not a product`);
    if (domCheck.titleText)   parts.push(`Title: "${domCheck.titleText}"`);
    if (domCheck.priceText)   parts.push(`Price: ${domCheck.priceText}`);
    if (domCheck.hasImages)   parts.push(`${domCheck.imageCount} image(s)`);
    if (domCheck.atcText)     parts.push(`ATC: "${domCheck.atcText}"`);
    else if (!domCheck.hasAtcBtn) parts.push(`No ATC btn (${result.siteType})`);
    result.detail = parts.join(' | ') || 'Product detail page loaded';
  } catch (err) { result.detail = `Product detail audit failed: ${err.message.slice(0, 80)}`; } finally { await page.close(); }
  return result;
}

// ─── Step 5+6: Add to cart → Cart page → Checkout ─────────────────────────────

async function auditCartFlow(context, productUrl, productDetail, origin) {
  const result = {
    addToCart: { tested: false, passed: false, cartCountBefore: null, cartCountAfter: null, cartUpdated: false, method: null, detail: null, screenshot: null },
    cartPage:  { tested: false, passed: false, url: null, hasItem: false, hasPrice: false, hasQuantityControl: false, hasRemoveOption: false, detail: null, screenshot: null },
    checkout:  { tested: false, passed: false, url: null, reachable: false, requiresLogin: false, detail: null, screenshot: null },
  };

  if (!productUrl) { result.addToCart.detail = 'No product URL to test'; return result; }

  const hasAtcBtn = productDetail.hasAddToCartBtn;
  if (!hasAtcBtn) {
    result.addToCart.tested = true;
    result.addToCart.passed = false;
    result.addToCart.detail = `No Add-to-Cart button found — site appears to be ${productDetail.siteType || 'catalog-style'} (inquiry/contact flow)`;
  }

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(productUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

    let cartCountBefore = null;

    if (hasAtcBtn) {

      // ── Get cart count BEFORE ──────────────────────────────────────────────
      cartCountBefore = await page.evaluate(() => {
        const countEl = document.querySelector('[class*="cart-count"],[class*="CartCount"],[class*="cart-qty"],[data-cart-count],[data-item-count],.cart-count,#cart-count,[aria-label*="cart" i] [class*="count"],[class*="cart"] [class*="badge"]');
        return countEl ? (parseInt(countEl.innerText) || 0) : null;
      });
      result.addToCart.cartCountBefore = cartCountBefore;
      result.addToCart.tested = true;

      // ── Auto-select required variant options ───────────────────────────────
      const variantsSelected = await page.evaluate(() => {
        let selected = 0;
        for (const sel of Array.from(document.querySelectorAll('form select,[class*="product"] select,[class*="variation"] select'))) {
          const firstReal = Array.from(sel.options).find(o => o.value && o.value !== '' && !/choose|select|pick/i.test(o.text));
          if (firstReal && sel.value !== firstReal.value) { sel.value = firstReal.value; sel.dispatchEvent(new Event('change', { bubbles: true })); selected++; }
        }
        for (const group of document.querySelectorAll('[class*="swatch"],[class*="variant-option"],[class*="VariantOption"],[class*="product-option"],[data-option-name]')) {
          const inputs = Array.from(group.querySelectorAll('input[type="radio"]'));
          if (inputs.length > 0 && !inputs.some(i => i.checked)) { const first = inputs.find(i => !i.disabled); if (first) { first.checked = true; first.dispatchEvent(new Event('change', { bubbles: true })); selected++; } }
        }
        return selected;
      });
      if (variantsSelected > 0) await sleep(600);

      // ── AJAX cart detection: set up BEFORE clicking ATC ───────────────────
      //
      // Three complementary signals are collected simultaneously:
      //   1. Network interception  — catches XHR/fetch to cart API endpoints
      //   2. DOM MutationObserver  — watches cart-related DOM attribute/text changes
      //   3. Cart API poll         — calls /cart.js or WooCommerce fragments after click
      //      to verify server-side state (most reliable for Shopify/WooCommerce)
      //
      // This catches silent AJAX carts that produce NO visible badge/drawer/toast change.

      const ajaxCartSignals = { requestFired: false, responsedOk: false, url: null, itemCount: null, source: null };

      // Signal 1: Network — intercept all requests and flag cart API calls
      await page.route('**/*', (route) => {
        const reqUrl = route.request().url().toLowerCase();
        const method = route.request().method().toUpperCase();
        const isCartApi =
          /\/cart\/add|\/cart\/update|add[_-]to[_-]cart|add_item|cart\.js|cart\/items/i.test(reqUrl) ||
          (/(?:POST|PUT)/.test(method) && /cart|basket|bag/i.test(reqUrl));
        if (isCartApi) {
          ajaxCartSignals.requestFired = true;
          ajaxCartSignals.url = reqUrl.slice(0, 100);
        }
        route.continue();
      });

      // Signal 2: DOM MutationObserver — injected before click, watches cart DOM
      await page.evaluate(() => {
        window.__ajaxCartMutations = 0;
        window.__ajaxCartObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            const target = m.target;
            const nodeStr =
              (target.className || '') +
              (target.id || '') +
              (target.getAttribute?.('data-cart-count') || '') +
              (target.getAttribute?.('aria-label') || '');
            // Cart-related attribute or subtree change
            if (/cart|basket|bag|item.?count|qty/i.test(nodeStr)) {
              window.__ajaxCartMutations++;
            }
            // Text change inside a cart badge (e.g. "0" → "1")
            if (m.type === 'characterData') {
              const parent = m.target.parentElement;
              if (/cart|count|badge|qty/i.test((parent?.className || '') + (parent?.id || ''))) {
                window.__ajaxCartMutations++;
              }
            }
          }
        });
        window.__ajaxCartObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cart-count', 'data-item-count', 'aria-label', 'data-count'],
          characterData: true,
        });
      });

      // ── Click ATC ─────────────────────────────────────────────────────────
      const clicked = await clickAddToCartButton(page, productDetail.addToCartSelector);
      if (!clicked) {
        try { await page.unroute('**/*'); } catch {}
        result.addToCart.detail = 'ATC button found in DOM but could not be clicked';
        return result;
      }

      await sleep(INTERACTION_WAIT);

      // Disconnect observer and collect mutations count
      const ajaxMutationCount = await page.evaluate(() => {
        window.__ajaxCartObserver?.disconnect();
        return window.__ajaxCartMutations || 0;
      });

      // Signal 3: Cart API poll — verify server-side cart state
      // Only fires if a cart request was detected (avoids unnecessary calls)
      if (ajaxCartSignals.requestFired) {
        try {
          const cartApiCheck = await page.evaluate(async (origin) => {
            const endpoints = [
              `${origin}/cart.js`,                              // Shopify
              `${origin}/cart.json`,                            // Shopify alt
              `${origin}/?wc-ajax=get_refreshed_fragments`,     // WooCommerce
            ];
            for (const ep of endpoints) {
              try {
                const r = await fetch(ep, { credentials: 'include' });
                if (!r.ok) continue;
                const data = await r.json();
                // Shopify: { item_count: N, items: [...] }
                const itemCount = data?.item_count ?? data?.items?.length ?? null;
                if (itemCount !== null) return { verified: itemCount > 0, itemCount, source: ep };
                // WooCommerce: has cart_hash key when cart is non-empty
                if (data?.cart_hash) return { verified: true, itemCount: null, source: ep };
              } catch {}
            }
            return null;
          }, origin);

          if (cartApiCheck?.verified) {
            ajaxCartSignals.responsedOk = true;
            ajaxCartSignals.itemCount   = cartApiCheck.itemCount;
            ajaxCartSignals.source      = cartApiCheck.source;
          }
        } catch {}
      }

      // Done — stop intercepting network
      try { await page.unroute('**/*'); } catch {}

      result.addToCart.screenshot = await takeScreenshot(page);

      // ── Detect cart update — Methods 1-7, ordered by reliability ──────────

      // Method 1: Cart badge count incremented
      const cartCountAfter = await page.evaluate(() => {
        const countEl = document.querySelector('[class*="cart-count"],[class*="CartCount"],[class*="cart-qty"],[data-cart-count],[data-item-count],.cart-count,#cart-count,[aria-label*="cart" i] [class*="count"],[class*="cart"] [class*="badge"]');
        return countEl ? (parseInt(countEl.innerText) || 0) : null;
      });
      result.addToCart.cartCountAfter = cartCountAfter;
      if (cartCountBefore !== null && cartCountAfter !== null && cartCountAfter > cartCountBefore) {
        result.addToCart.cartUpdated = true;
        result.addToCart.method = 'cart-count-increment';
      }

      // Method 2: Cart drawer / mini-cart appeared
      if (!result.addToCart.cartUpdated) {
        const drawerVisible = await page.evaluate(() => {
          function isVisible(el) { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0; }
          const drawer = document.querySelector('[class*="cart-drawer"],[class*="CartDrawer"],[class*="mini-cart"],[class*="MiniCart"],[class*="cart-sidebar"],[id*="cart-drawer"],[class*="cart-flyout"],[class*="slide-cart"]');
          return !!(drawer && isVisible(drawer));
        });
        if (drawerVisible) { result.addToCart.cartUpdated = true; result.addToCart.method = 'cart-drawer-opened'; }
      }

      // Method 3: Page redirected to cart URL
      if (!result.addToCart.cartUpdated) {
        const currentUrl = page.url();
        if (/\/cart|\/basket|\/bag/i.test(currentUrl) && currentUrl !== productUrl) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method = 'redirected-to-cart';
        }
      }

      // Method 4: Success toast / notification appeared
      if (!result.addToCart.cartUpdated) {
        const toastVisible = await page.evaluate(() => {
          function isVisible(el) { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
          const toasts = Array.from(document.querySelectorAll('[class*="toast"],[class*="notification"],[role="alert"],[class*="snackbar"],[class*="success"],[class*="added"],[class*="confirmation"]')).filter(isVisible);
          return toasts.some(t => /added|cart|success/i.test(t.innerText || ''));
        });
        if (toastVisible) { result.addToCart.cartUpdated = true; result.addToCart.method = 'success-notification'; }
      }

      // Method 5 (AJAX): Network request fired + server-side cart API confirms item added
      // Most reliable AJAX check — cart.js / WooCommerce fragments explicitly return item count
      if (!result.addToCart.cartUpdated && ajaxCartSignals.requestFired && ajaxCartSignals.responsedOk) {
        result.addToCart.cartUpdated = true;
        result.addToCart.method = `ajax-verified (${ajaxCartSignals.source?.split('/').pop() || 'cart-api'}, ${ajaxCartSignals.itemCount ?? '?'} items)`;
      }

      // Method 6 (AJAX): Network request fired + DOM cart mutations detected
      // Catches headless / custom carts with no public API endpoint but DOM updates
      if (!result.addToCart.cartUpdated && ajaxCartSignals.requestFired && ajaxMutationCount > 0) {
        result.addToCart.cartUpdated = true;
        result.addToCart.method = `ajax-dom-mutation (${ajaxMutationCount} cart DOM change${ajaxMutationCount > 1 ? 's' : ''})`;
      }

      // Method 7 (AJAX): Network request fired, no other feedback yet
      // Lowest confidence — a recognisable cart endpoint was called without error;
      // real items will appear on the cart page in the next step
      if (!result.addToCart.cartUpdated && ajaxCartSignals.requestFired) {
        result.addToCart.cartUpdated = true;
        result.addToCart.method = 'ajax-request-fired (no DOM feedback — will verify on cart page)';
      }

      result.addToCart.passed = result.addToCart.cartUpdated;
      result.addToCart.detail = result.addToCart.passed
        ? `Cart updated via: ${result.addToCart.method}`
        : 'No cart update detected (no AJAX request, no DOM change, no badge/drawer/toast)';

    } // end if (hasAtcBtn)

    // ── Navigate to cart page ─────────────────────────────────────────────────
    let cartUrl = null;
    try {
      const cartRes = await page.goto(`${origin}/cart`, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      const finalPath = new URL(page.url()).pathname.toLowerCase();
      if (cartRes?.ok() && /^\/cart$|^\/cart\//.test(finalPath)) cartUrl = page.url();
    } catch {}

    if (!cartUrl) {
      const found = await findCartUrl(page, origin);
      if (found) {
        await page.goto(found, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        if (/cart|basket|bag/.test(new URL(page.url()).pathname.toLowerCase())) cartUrl = page.url();
      }
    }

    if (cartUrl || /cart|basket|bag/.test(new URL(page.url()).pathname.toLowerCase())) {
      try { await page.waitForFunction(() => document.body.innerText.trim().length > 50, { timeout: 5000 }); } catch {}
      await sleep(500);
      result.cartPage.tested = true;
      result.cartPage.url = page.url();
      result.cartPage.screenshot = await takeScreenshot(page);

      const cartDOM = await page.evaluate(() => {
        function isVisible(el) { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; }
        const lineItems = document.querySelectorAll('[class*="cart-item"],[class*="CartItem"],[class*="line-item"],[class*="LineItem"],[class*="cart-product"],[data-cart-item]');
        const cartBody = document.querySelector('[class*="cart"]');
        const hasItemFallback = !!(cartBody && /\$|€|£/.test(cartBody.innerText || ''));
        const priceInCart = document.querySelector('[class*="price"],[class*="total"],[class*="subtotal"]');
        const qtyControl = document.querySelector('input[type="number"][min],[class*="quantity"],[class*="Quantity"],[data-quantity],[class*="qty"]');
        const removeBtn = Array.from(document.querySelectorAll('button,a,[role="button"]')).find(el => isVisible(el) && /remove|delete|trash|×/i.test(el.innerText || el.getAttribute('aria-label') || ''));
        const checkoutCandidates = Array.from(document.querySelectorAll('button[name="checkout"],button[name="go_to_checkout"],input[name="checkout"],[data-testid*="checkout"],a[href*="/checkout"],a[href*="checkout.shopify"],button,a[href],input[type="submit"]'));
        const checkoutBtn = checkoutCandidates.find(el => {
          if (!isVisible(el)) return false;
          const text = (el.innerText || el.value || '').trim().toLowerCase();
          const href = (el.getAttribute('href') || '').toLowerCase();
          const name = (el.getAttribute('name') || '').toLowerCase();
          if (name === 'checkout' || name === 'go_to_checkout') return true;
          if (/\/checkout|checkout\.shopify/.test(href)) return true;
          return /^checkout$|^proceed to checkout|^go to checkout|place.?order|pay now|complete order/i.test(text);
        });
        let checkoutUrl = null;
        if (checkoutBtn) {
          if (checkoutBtn.tagName === 'A' && checkoutBtn.href) checkoutUrl = checkoutBtn.href;
          else { const form = checkoutBtn.closest('form'); checkoutUrl = form?.action?.includes('checkout') ? form.action : 'button:/checkout'; }
        }
        return { hasItem: lineItems.length > 0 || hasItemFallback, lineItemCount: lineItems.length, hasPrice: !!(priceInCart && isVisible(priceInCart) && priceInCart.innerText?.trim()), hasQty: !!(qtyControl && isVisible(qtyControl)), hasRemove: !!removeBtn, checkoutUrl, cartIsEmpty: /empty|no item|your cart is empty/i.test(document.body?.innerText || '') };
      });

      result.cartPage.hasItem = cartDOM.hasItem;
      result.cartPage.hasPrice = cartDOM.hasPrice;
      result.cartPage.hasQuantityControl = cartDOM.hasQty;
      result.cartPage.hasRemoveOption = cartDOM.hasRemove;

      const finalCartPath = new URL(result.cartPage.url).pathname.toLowerCase();
      const isActualCartPage = /cart|basket|bag|checkout/.test(finalCartPath);
      result.cartPage.passed = (isActualCartPage && !cartDOM.cartIsEmpty) || cartDOM.hasItem || (cartDOM.hasPrice && isActualCartPage);
      result.cartPage.detail = !isActualCartPage
        ? `Page loaded but URL (${finalCartPath}) doesn't look like a cart`
        : cartDOM.cartIsEmpty && !cartDOM.hasItem
          ? 'Cart page loaded but appears empty — ATC may not have persisted'
          : `${cartDOM.lineItemCount} item(s) in cart | price:${cartDOM.hasPrice ? '✅' : '❌'} qty:${cartDOM.hasQty ? '✅' : '❌'} remove:${cartDOM.hasRemove ? '✅' : '❌'}`;

      // ── Checkout access ────────────────────────────────────────────────────
      const checkoutHref = cartDOM.checkoutUrl;
      const resolvedCheckoutHref = checkoutHref?.startsWith('button:') ? `${origin}${checkoutHref.replace('button:', '')}` : checkoutHref;

      if (resolvedCheckoutHref && resolvedCheckoutHref !== 'button') {
        result.checkout.tested = true;
        result.checkout.url = resolvedCheckoutHref;
        try {
          const checkoutRes = await page.goto(resolvedCheckoutHref, { waitUntil: 'load', timeout: NAV_TIMEOUT });
          const checkoutStatus = checkoutRes?.status() ?? null;
          result.checkout.screenshot = await takeScreenshot(page);
          const checkoutDOM = await page.evaluate((httpStatus) => {
            const bodyText = document.body?.innerText?.toLowerCase() || '';
            return {
              isCheckout: /shipping|billing|payment|order summary|place order|your order/i.test(bodyText) || /checkout/i.test(location.pathname),
              requiresLogin: /sign in|log in|login required|create account/i.test(bodyText) && !!document.querySelector('input[type="email"],input[type="password"]'),
              isError: httpStatus >= 400 || /\b404\b|\bnot found\b|\bserver error\b/i.test(bodyText.slice(0, 200)),
            };
          }, checkoutStatus);
          result.checkout.reachable = !checkoutDOM.isError && (checkoutDOM.isCheckout || checkoutStatus < 400);
          result.checkout.requiresLogin = checkoutDOM.requiresLogin;
          result.checkout.passed = result.checkout.reachable;
          result.checkout.detail = checkoutDOM.requiresLogin ? `Checkout reachable but requires login (${page.url().slice(0, 60)})` : result.checkout.reachable ? `Checkout page accessible (HTTP ${checkoutStatus})` : `Checkout not accessible — HTTP ${checkoutStatus}`;
        } catch (err) { result.checkout.detail = `Checkout navigation failed: ${err.message.slice(0, 60)}`; }
      } else if (checkoutHref === 'button') {
        result.checkout.tested = true; result.checkout.passed = true; result.checkout.reachable = true;
        result.checkout.detail = 'Checkout button present in cart (JS-triggered, not a direct link)';
      } else {
        result.checkout.detail = 'No checkout button/link found on cart page';
      }
    } else {
      result.cartPage.detail = 'Could not locate cart page URL';
      result.checkout.detail = 'Skipped — cart page not found';
    }

  } catch (err) {
    result.addToCart.detail = result.addToCart.detail || `Cart flow error: ${err.message.slice(0, 80)}`;
  } finally {
    await page.close();
  }

  return result;
}

// ─── Click ATC button ─────────────────────────────────────────────────────────

async function clickAddToCartButton(page, selectorHint) {
  if (selectorHint) {
    try { const el = await page.$(selectorHint); if (el && await el.isVisible()) { await el.click({ timeout: 5000 }); return true; } } catch {}
  }
  for (const sel of ['[data-add-to-cart]','[data-action="add-to-cart"]','form[action*="cart"] button[type="submit"]','button[class*="add"][class*="cart"]','button[class*="AddToCart"]','button[class*="add-to-cart"]','[id*="add-to-cart"]','#add-to-cart']) {
    try { const el = await page.$(sel); if (el && await el.isVisible()) { await el.click({ timeout: 5000 }); return true; } } catch {}
  }
  return page.evaluate(() => {
    const atcBtn = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).find(b => {
      const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
      const r = b.getBoundingClientRect(); const s = window.getComputedStyle(b);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now/i.test(t);
    });
    if (atcBtn) { atcBtn.click(); return true; } return false;
  });
}

async function drillForProductUrl(context, categoryUrl, origin) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(categoryUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
    return page.evaluate((origin) => {
      const PRODUCT_PATH = /\/(products?|items?|p)\/[^/?#]+/i;
      const SKIP = /\/(cart|checkout|account|login|wishlist|category|categories)\//i;
      function getHref(el) { if (el.tagName === 'A' && el.href) return el.href; const c = el.querySelector('a[href]'); if (c) return c.href; const p = el.closest('a[href]'); return p ? p.href : null; }
      for (const sel of ['[class*="product-item"]','[class*="ProductItem"]','[class*="product-card"]','.product','li.product','article.product','[data-product-id]'])
        for (const el of Array.from(document.querySelectorAll(sel))) { const href = getHref(el); if (href && href.startsWith(origin) && PRODUCT_PATH.test(href) && !SKIP.test(href)) return href; }
      for (const a of Array.from(document.querySelectorAll('a[href]'))) { const href = a.href; if (href && href.startsWith(origin) && PRODUCT_PATH.test(href) && !SKIP.test(href) && href !== location.href) return href; }
      return null;
    }, origin);
  } catch { return null; } finally { await page.close(); }
}

async function findCartUrl(page, origin) {
  const domCartLink = await page.evaluate((origin) => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => { try { return new URL(a.href); } catch { return null; } })
      .filter(u => u && u.origin === origin).find(u => /^\/cart$|^\/cart\/|^\/basket$|^\/basket\/|^\/bag$/i.test(u.pathname))?.href || null;
  }, origin);
  if (domCartLink) return domCartLink;
  for (const p of ['/cart', '/basket', '/bag', '/shopping-cart']) {
    const candidate = `${origin}${p}`;
    try {
      const res = await fetch(candidate, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; audit-bot/1.0)' } });
      if (!res.ok) continue;
      const finalPath = new URL(res.url || candidate).pathname.toLowerCase();
      if (/^\/cart$|^\/cart\/|^\/basket$|^\/bag$/i.test(finalPath)) return res.url || candidate;
    } catch {}
  }
  return null;
}

async function analyzeCartFlowWithAI(screenshots, flowSteps) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !screenshots.length) return null;
  const system = `You are a QA engineer reviewing ecommerce flow screenshots. Return ONLY valid JSON — no markdown.
{"productListing":{"loaded":true,"hasProducts":true,"productCount":"visible count or 'many'","detail":"..."},"productDetail":{"loaded":true,"hasAtcButton":true,"hasPrice":true,"detail":"..."},"addToCart":{"cartUpdated":true,"method":"count-change|drawer|redirect|notification|ajax","detail":"..."},"cartPage":{"loaded":true,"hasItems":true,"hasCheckoutButton":true,"detail":"..."},"generalObservations":"other UX issues or null"}`;
  const content = [{ type: 'text', text: `Flow steps tested: ${flowSteps.join(', ')}` }];
  for (const [label, b64] of screenshots) { content.push({ type: 'text', text: `📸 ${label}:` }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }); }
  content.push({ type: 'text', text: 'Assess each ecommerce flow step from the screenshots.' });
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: AI_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content }] }) });
    if (res.status === 429) { await sleep(8000); return null; }
    if (!res.ok) return null;
    return parseJSON((await res.json()).content?.[0]?.text || '');
  } catch { return null; }
}

function calculateScore(steps) {
  const hasAtcBtn = steps.productDetail?.hasAddToCartBtn;
  if (!hasAtcBtn) {
    let score = 0;
    if (steps.productListing?.passed) score += WEIGHTS.productListing;
    if (steps.productDetail?.passed)  score += WEIGHTS.productDetail;
    if (steps.cartPage?.passed)       score += WEIGHTS.cartPage + 12;
    if (steps.checkout?.passed)       score += WEIGHTS.checkout + 13;
    return score;
  }
  let score = 0;
  if (steps.productListing?.passed) score += WEIGHTS.productListing;
  if (steps.productDetail?.passed)  score += WEIGHTS.productDetail;
  if (steps.addToCart?.passed)      score += WEIGHTS.addToCart;
  if (steps.cartPage?.passed)       score += WEIGHTS.cartPage;
  if (steps.checkout?.passed)       score += WEIGHTS.checkout;
  return score;
}

async function auditEcommerce(context, url, timeout = 25_000) {
  const page = await context.newPage();
  const result = { url, isEcommerce: false, platform: null, confidence: 'low', detectionMethod: null, productListing: { tested: false, passed: false, detail: 'Not tested' }, productDetail: { tested: false, passed: false, detail: 'Not tested' }, addToCart: { tested: false, passed: false, detail: 'Not tested' }, cartPage: { tested: false, passed: false, detail: 'Not tested' }, checkout: { tested: false, passed: false, detail: 'Not tested' }, aiAnalysis: null, overallStatus: 'healthy', score: null, issues: [] };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    if (!response?.ok()) { result.issues.push({ type: 'critical', code: 'PAGE_LOAD_FAILED', message: `HTTP ${response?.status()}` }); result.overallStatus = 'critical'; return result; }
    try { await page.waitForFunction(() => document.body?.innerText?.trim().length > 100, { timeout: 5000 }); } catch {}
    console.log(`   🔍 Detecting ecommerce signals...`);
    const domDetection = await detectEcommerceDOM(page);
    const homepageShot = await takeScreenshot(page);
    const aiDetection  = await detectWithAI(page, url, domDetection, homepageShot);
    result.isEcommerce    = (aiDetection?.isEcommerce === true && aiDetection?.confidence !== 'low') || domDetection.isEcommerce;
    result.platform       = aiDetection?.platform || domDetection.platform;
    result.confidence     = aiDetection?.confidence || domDetection.confidence;
    result.detectionMethod = aiDetection ? 'ai+dom' : 'dom-only';
    console.log(`   ${result.isEcommerce ? '🛒' : '❌'} Ecommerce: ${result.isEcommerce} | Platform: ${result.platform || 'unknown'} | Confidence: ${result.confidence}`);
    if (!result.isEcommerce) { result.issues.push({ type: 'info', code: 'NOT_ECOMMERCE', message: `Site does not appear to be ecommerce (DOM score: ${domDetection.domScore}, AI: ${aiDetection?.reasoning || 'n/a'})` }); result.overallStatus = 'healthy'; result.score = null; return result; }
    const origin = new URL(url).origin;
    console.log(`   📦 Step 1: Product listing...`);
    const listingUrl = await findProductListingUrl(page, origin, aiDetection || {});
    result.productListing = await auditProductListing(context, listingUrl, aiDetection || {});
    console.log(`      ${result.productListing.passed ? '✅' : '❌'} ${result.productListing.detail}`);
    console.log(`   🏷  Step 2: Product detail...`);
    let productUrl = result.productListing.sampleProductUrl || aiDetection?.sampleProductUrls?.[0] || null;
    result.productDetail = await auditProductDetail(context, productUrl);
    if (result.productDetail.isCategoryPage && productUrl) {
      console.log(`      ↪ Category page detected — drilling for a real product URL...`);
      const deepProductUrl = await drillForProductUrl(context, productUrl, origin);
      if (deepProductUrl && deepProductUrl !== productUrl) { productUrl = deepProductUrl; result.productDetail = await auditProductDetail(context, productUrl); }
    }
    console.log(`      ${result.productDetail.passed ? '✅' : '❌'} ${result.productDetail.detail}`);
    console.log(`   🛒 Steps 3-5: Add to cart → Cart → Checkout...`);
    const cartFlow = await auditCartFlow(context, productUrl, result.productDetail, origin);
    result.addToCart = cartFlow.addToCart;
    result.cartPage  = cartFlow.cartPage;
    result.checkout  = cartFlow.checkout;
    console.log(`      ATC:${result.addToCart.passed ? '✅' : '❌'} Cart:${result.cartPage.passed ? '✅' : '❌'} Checkout:${result.checkout.passed ? '✅' : '❌'}`);
    const screenshots = [['Homepage', homepageShot], result.productListing.screenshot && ['Product Listing', result.productListing.screenshot], result.productDetail.screenshot && ['Product Detail', result.productDetail.screenshot], result.addToCart.screenshot && ['After Add to Cart', result.addToCart.screenshot], result.cartPage.screenshot && ['Cart Page', result.cartPage.screenshot], result.checkout.screenshot && ['Checkout Page', result.checkout.screenshot]].filter(Boolean);
    const flowStepsTested = ['detection','product-listing','product-detail','add-to-cart','cart','checkout'].filter((s, i) => [true, result.productListing.tested, result.productDetail.tested, result.addToCart.tested, result.cartPage.tested, result.checkout.tested][i]);
    try {
      result.aiAnalysis = await analyzeCartFlowWithAI(screenshots, flowStepsTested);
      const ai = result.aiAnalysis;
      if (ai?.addToCart && !result.addToCart.passed && ai.addToCart.cartUpdated) { result.addToCart.passed = true; result.addToCart.method = `ai-detected: ${ai.addToCart.method}`; }
      if (ai?.cartPage && !result.cartPage.passed && ai.cartPage.loaded) { result.cartPage.passed = true; result.cartPage.detail = `AI confirmed: ${ai.cartPage.detail}`; }
    } catch (err) { console.warn(`      ⚠️  AI vision failed: ${err.message.slice(0, 60)}`); }
    result.score = calculateScore(result);
    if (!result.productListing.passed) result.issues.push({ type: 'critical', code: 'PRODUCT_LISTING_FAILED', message: `Product listing: ${result.productListing.detail}` });
    if (!result.productDetail.passed)  result.issues.push({ type: result.productDetail.tested ? 'critical' : 'warning', code: 'PRODUCT_DETAIL_FAILED', message: `Product detail: ${result.productDetail.detail}` });
    if (!result.addToCart.passed)      result.issues.push({ type: !result.productDetail?.hasAddToCartBtn ? 'info' : 'critical', code: !result.productDetail?.hasAddToCartBtn ? 'NO_ATC_BUTTON' : 'ADD_TO_CART_FAILED', message: `Add to cart: ${result.addToCart.detail}` });
    if (!result.cartPage.passed)       result.issues.push({ type: 'critical', code: 'CART_PAGE_FAILED', message: `Cart page: ${result.cartPage.detail || (result.cartPage.tested ? 'Cart page loaded but no items or price found' : 'Could not reach cart page')}` });
    if (!result.checkout.passed)       result.issues.push({ type: result.checkout.tested ? 'critical' : 'warning', code: 'CHECKOUT_FAILED', message: `Checkout: ${result.checkout.detail || (result.cartPage.tested ? 'No checkout button found on cart page' : 'Skipped — cart page was not reachable')}` });
    if (result.checkout.requiresLogin) result.issues.push({ type: 'info', code: 'CHECKOUT_REQUIRES_LOGIN', message: 'Checkout requires account creation/login — may reduce conversions' });
    const criticals = result.issues.filter(i => i.type === 'critical');
    const warnings  = result.issues.filter(i => i.type === 'warning');
    result.overallStatus = criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy';
  } catch (err) {
    result.overallStatus = 'critical'; result.score = 0;
    result.issues.push({ type: 'critical', code: 'AUDIT_FATAL', message: `Ecommerce audit crashed: ${err.message}` });
    result.fatalError = err.message;
  } finally { await page.close(); }
  return result;
}

module.exports = { auditEcommerce };