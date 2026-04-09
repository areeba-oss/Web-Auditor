'use strict';

/**
 * ecommerceCheck.js — Layer 5 audit: Ecommerce Flow Testing
 *
 * FIXES in this version:
 *  [A1] Don't clearCookies before ATC — clears nonces/sessions; instead navigate cart on the SAME page
 *  [A2] Price detection on cart page — broadened to catch subtotal, total, and inline prices
 *  [A3] Qty detection — catches +/- stepper buttons, number inputs, select dropdowns
 *  [A4] Checkout "requires login" — only flags when there's a login WALL, not guest-checkout forms
 *  [A5] Product listing price detection — wider regex + currency symbol scan
 *  [A6] Cart line-item detection — 3-pass fallback (specific → tr rows → any repeated container)
 *  [A7] ATC network verification — POST to /cart/add or wc-ajax=add_to_cart is definitive proof
 *  [A8] Cart page pass — if server API confirms items > 0, pass even if DOM selectors miss
 *  [A9] Checkout requires login — only penalise if it's a hard block, not optional account creation
 *  [B1] Network filter tightened — only match actual cart API endpoints, not plugin JS files
 *  [B2] Timeout raised — 60s nav timeout, 90s main audit timeout for slow/CDN-protected sites
 *  [B3] Cart page navigated on same page object (same session/cookies) as ATC click
 */

const INTERACTION_WAIT = 2500;
const NAV_TIMEOUT      = 60_000;   // [B2] raised from 25s — slow sites need more time
const FETCH_TIMEOUT    = 10_000;   // [B2] raised from 8s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Utilities ────────────────────────────────────────────────────────────────

async function takeScreenshot(page) {
  try {
    return await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, encoding: 'base64' });
  } catch { return null; }
}

async function isReachable(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; audit-bot/1.0)' },
      });
      if (method === 'HEAD' && res.status === 405) continue;
      return res.ok || res.status === 301 || res.status === 302;
    } catch { /* try next */ }
  }
  return false;
}

const WEIGHTS = {
  productListing: 20,
  productDetail:  20,
  addToCart:      25,
  cartPage:       20,
  checkout:       15,
};

// ─── DOM-based ecommerce detection ───────────────────────────────────────────

async function detectEcommerceDOM(page) {
  return page.evaluate(() => {
    const signals = [];
    const generator = document.querySelector('meta[name="generator"]')?.content || '';
    if (/shopify/i.test(generator))     signals.push({ type: 'platform', value: 'Shopify',     weight: 10 });
    if (/woocommerce/i.test(generator)) signals.push({ type: 'platform', value: 'WooCommerce', weight: 10 });
    if (/magento/i.test(generator))     signals.push({ type: 'platform', value: 'Magento',     weight: 10 });
    if (/bigcommerce/i.test(generator)) signals.push({ type: 'platform', value: 'BigCommerce', weight: 10 });

    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent || '');
        const types = [].concat(data['@type'] || []);
        if (types.some(t => /product|offer|store/i.test(t)))
          signals.push({ type: 'structured-data', value: types.join(','), weight: 8 });
      } catch {}
    }

    const cartEls = document.querySelectorAll(
      '[class*="cart"],[id*="cart"],[data-cart],[aria-label*="cart" i],' +
      '[class*="basket"],[id*="basket"],[class*="bag"],[data-testid*="cart"]'
    );
    if (cartEls.length) signals.push({ type: 'cart-element', value: `${cartEls.length} found`, weight: 6 });

    const priceEls = document.querySelectorAll(
      '[class*="price"],[itemprop="price"],[class*="Price"],[data-price],.price,#price,[class*="amount"]'
    );
    if (priceEls.length) signals.push({ type: 'price-elements', value: `${priceEls.length} found`, weight: 5 });

    const atcBtns = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'))
      .filter(el => /add.{0,10}cart|buy.{0,5}now|shop.now|add.to.bag/i
        .test(el.innerText || el.value || el.getAttribute('aria-label') || ''));
    if (atcBtns.length) signals.push({ type: 'atc-button', value: `${atcBtns.length} found`, weight: 7 });

    const productGrids = document.querySelectorAll(
      '[class*="product-grid"],[class*="ProductGrid"],[class*="products-grid"],' +
      '[class*="product-list"],[class*="ProductList"],[data-product-id],.products,' +
      '#products,[class*="product-item"],[class*="ProductItem"],' +
      'ul.products,ul.products li.product'
    );
    if (productGrids.length) signals.push({ type: 'product-grid', value: `${productGrids.length} found`, weight: 6 });

    const checkoutLinks = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => /checkout|proceed.to.pay|place.order/i.test(a.href + (a.innerText || '')));
    if (checkoutLinks.length)
      signals.push({ type: 'checkout-link', value: checkoutLinks[0]?.href?.slice(0, 80), weight: 7 });

    const allSrcs = [
      ...Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
      ...Array.from(document.querySelectorAll('link[href]')).map(l => l.href),
    ].join(' ');
    if (/cdn\.shopify/i.test(allSrcs))        signals.push({ type: 'cdn', value: 'Shopify CDN',  weight: 9 });
    if (/woocommerce/i.test(allSrcs))         signals.push({ type: 'cdn', value: 'WooCommerce',  weight: 9 });
    if (/static\.bigcommerce/i.test(allSrcs)) signals.push({ type: 'cdn', value: 'BigCommerce',  weight: 9 });

    const path = location.pathname.toLowerCase();
    if (/\/shop|\/store|\/products?|\/collections?/.test(path))
      signals.push({ type: 'url-path', value: path, weight: 4 });

    const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
    const platform    = signals.find(s => s.type === 'platform')?.value ||
                        signals.find(s => s.type === 'cdn')?.value?.split(' ')[0] || null;

    return { isEcommerce: totalWeight >= 8, confidence: totalWeight >= 15 ? 'high' : totalWeight >= 8 ? 'medium' : 'low', domScore: totalWeight, signals, platform };
  });
}

// ─── Product listing URL discovery ───────────────────────────────────────────

async function findProductListingUrl(page, origin) {

  const commonPaths = [
    '/shop', '/store', '/products', '/collections/all', '/collections',
    '/catalog', '/shop/all', '/all-products', '/our-products',
  ];
  for (const p of commonPaths) {
    const candidate = `${origin}${p}`;
    if (await isReachable(candidate)) return candidate;
  }

  return page.evaluate((origin) => {
    const navEls = document.querySelectorAll('nav a[href], header a[href], [class*="nav"] a[href], [class*="menu"] a[href]');
    for (const a of navEls) {
      const href = a.href;
      if (!href.startsWith(origin)) continue;
      const text = (a.innerText || '').toLowerCase().trim();
      const path = new URL(href).pathname.toLowerCase();
      if (
        /shop|store|products|collection|catalog|buy/i.test(text) ||
        /^\/shop|^\/store|^\/products|^\/collections/.test(path)
      ) return href;
    }
    return null;
  }, origin);
}

// ─── Step 1: Product listing audit ───────────────────────────────────────────

async function auditProductListing(context, listingUrl) {
  const result = {
    tested: false, passed: false, url: listingUrl,
    productCount: 0, hasImages: false, hasPrices: false, hasProductLinks: false,
    sampleProductUrl: null, detail: null, screenshot: null,
  };

  if (!listingUrl) { result.detail = 'No product listing URL found'; return result; }

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(listingUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    if (!res?.ok()) { result.detail = `HTTP ${res?.status()} on listing page`; return result; }

    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 6000 }); } catch {}
    await sleep(1000);

    result.tested     = true;
    result.screenshot = await takeScreenshot(page);

    const domCheck = await page.evaluate(() => {
      // Pass 1: specific product-item selectors
      const specificSelectors = [
        'ul.products li.product',
        'ul.products > li',
        '[class*="product-item"]',
        '[class*="ProductItem"]',
        '[class*="product-card"]',
        '[class*="ProductCard"]',
        '[class*="product-grid"] > *',
        '[class*="products"] > li',
        '[data-product-id]',
        '[itemtype*="Product"]',
        '.product-item',
        '.product-card',
        'li.product',
        'article.product',
        '.wc-block-grid__product',
        '[class*="wc-block-grid__product"]',
      ];
      let productEls = [];
      let detectionPass = 'none';
      for (const sel of specificSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length >= 1) { productEls = Array.from(els); detectionPass = 'specific'; break; }
      }

      // Pass 2: price-anchor
      if (productEls.length === 0) {
        const priceParents = Array.from(
          document.querySelectorAll('[class*="price"],[itemprop="price"],[data-price],.amount')
        )
          .map(el => el.closest('li, article, [class*="item"], [class*="card"], [class*="product"]'))
          .filter(Boolean)
          .filter((el, i, arr) => arr.indexOf(el) === i);
        if (priceParents.length >= 1) { productEls = priceParents; detectionPass = 'price-anchor'; }
      }

      // Pass 3: generic repeated li/article with image + link
      if (productEls.length === 0) {
        const candidates = Array.from(
          document.querySelectorAll('ul > li, .grid > div, .row > div, article')
        ).filter(el => {
          const inNav = !!el.closest('nav, header, footer');
          return !inNav && el.querySelector('img') && el.querySelector('a');
        });
        if (candidates.length >= 2) { productEls = candidates; detectionPass = 'generic'; }
      }

      const withImages = productEls.filter(el =>
        el.querySelector('img, picture, [class*="thumb"], [class*="Thumb"]')).length;

      // [A5] Broadened price detection — catches more currency formats and text patterns
      const PRICE_RE = /[\$£€¥₹₩₽][\s]?\d|Rs\.?\s?\d|PKR\s?\d|\d+[\.,]\d{2}\s*(?:USD|GBP|EUR|PKR)|^\d+\.\d{2}$/;
      const withPrices = productEls.filter(el => {
        if (el.querySelector('[class*="price"],[itemprop="price"],[data-price],.amount,[class*="Price"],[class*="cost"],[class*="Cost"]')) return true;
        const text = (el.innerText || '').trim();
        return PRICE_RE.test(text);
      }).length;

      const PRODUCT_PATH  = /\/(products?|items?|p|pd|detail|sku)\/[^/?#]+/i;
      const CATEGORY_PATH = /\/(product-category|tag|category|categories|collections?\/(?!all$))\//i;
      const SKIP_PATH     = /\/(cart|checkout|account|login|logout|wishlist|search|#)/i;

      function getElHref(el) {
        if (el.tagName === 'A' && el.href) return el.href;
        const child = el.querySelector('a[href]');
        if (child) return child.href;
        const parent = el.closest('a[href]');
        return parent ? parent.href : null;
      }

      const listingOrigin = location.origin;
      const listingPath   = location.pathname;

      const allProductHrefs = productEls
        .map(el => getElHref(el))
        .filter(href => {
          if (!href) return false;
          if (SKIP_PATH.test(href)) return false;
          try {
            const u = new URL(href);
            if (u.pathname === '/' || u.pathname === listingPath) return false;
            if (u.origin !== listingOrigin) return false;
          } catch { return false; }
          return true;
        });

      const bestProductLink =
        allProductHrefs.find(href => PRODUCT_PATH.test(href) && !CATEGORY_PATH.test(href)) ||
        allProductHrefs.find(href => !CATEGORY_PATH.test(href)) ||
        null;

      const allPageProductLink = !bestProductLink
        ? Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .find(href => {
              if (!href?.startsWith(location.origin)) return false;
              if (CATEGORY_PATH.test(href) || SKIP_PATH.test(href)) return false;
              if (href === location.href) return false;
              try { const u = new URL(href); if (u.pathname === '/') return false; } catch {}
              return PRODUCT_PATH.test(href);
            }) || null
        : null;

      return {
        productCount:  productEls.length,
        withImages,
        withPrices,
        withLinks:     allProductHrefs.filter(Boolean).length,
        sampleLink:    bestProductLink || allPageProductLink || null,
        detectionPass,
      };
    });

    result.productCount     = domCheck.productCount;
    result.hasImages        = domCheck.withImages > 0;
    result.hasPrices        = domCheck.withPrices > 0;
    result.hasProductLinks  = domCheck.withLinks > 0;

    result.sampleProductUrl = domCheck.sampleLink;

    result.passed = result.productCount > 0 &&
      (domCheck.withImages > 0 || domCheck.withPrices > 0 || domCheck.withLinks > 0);

    result.detail = result.passed
      ? `${result.productCount} products found via [${domCheck.detectionPass}] ` +
        `(${domCheck.withImages} w/images, ${domCheck.withPrices} w/prices, ${domCheck.withLinks} w/links)`
      : result.productCount === 0
        ? `Listing page loaded but no product elements detected (tried 3 passes)`
        : `Products found but missing images AND prices AND links`;

  } catch (err) {
    result.detail = `Listing audit error: ${err.message.slice(0, 100)}`;
  } finally {
    await page.close();
  }
  return result;
}

// ─── Step 2: Product detail audit ────────────────────────────────────────────

async function auditProductDetail(context, productUrl) {
  const result = {
    tested: false, passed: false, url: productUrl,
    hasProductTitle: false, hasPrice: false, hasImages: false,
    hasAddToCartBtn: false, addToCartSelector: null,
    isOutOfStock: false,
    detail: null, screenshot: null,
  };

  if (!productUrl) { result.detail = 'No product URL to test'; return result; }

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(productUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    if (!res?.ok()) { result.detail = `HTTP ${res?.status()} on product page`; return result; }

    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 6000 }); } catch {}
    await sleep(500);

    result.tested     = true;
    result.screenshot = await takeScreenshot(page);

    const domCheck = await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      }

      const h1 = document.querySelector('h1');
      const hasTitle = !!(h1 && h1.innerText?.trim().length > 2 && isVisible(h1));

      const priceEl = document.querySelector(
        '[class*="price"]:not([class*="compare"]):not([class*="Compare"]):not([class*="was"]),' +
        '[itemprop="price"],[data-price],.price,[class*="Price"]:not([class*="Compare"])'
      );
      const hasPrice = !!(priceEl && isVisible(priceEl) && priceEl.innerText?.trim());

      const imgEls = Array.from(document.querySelectorAll(
        '[class*="product"] img,[class*="Product"] img,[class*="gallery"] img,' +
        '[data-product-image],img[class*="zoom"],img[class*="main"],.product-image img'
      )).filter(isVisible);

      const bodyText = (document.body?.innerText || '').toLowerCase();
      const isOutOfStock =
        /\bsold.?out\b|\bout.?of.?stock\b|\bunavailable\b|\bno.?longer.?available\b/i.test(bodyText);

      const atcSelectors = [
        '[data-add-to-cart]',
        '[data-action="add-to-cart"]',
        'form[action*="cart"] button[type="submit"]:not([disabled])',
        'form[action*="cart"] input[type="submit"]:not([disabled])',
        'button[class*="add"][class*="cart"]:not([disabled])',
        'button[class*="AddToCart"]:not([disabled])',
        'button[class*="add-to-cart"]:not([disabled])',
        'button[class*="addToCart"]:not([disabled])',
        'button[class*="add_to_cart"]:not([disabled])',
        '[id*="add-to-cart"]:not([disabled])',
        '[id*="addToCart"]:not([disabled])',
        '#add-to-cart:not([disabled])',
        'button[name="add"]:not([disabled])',
        'input[name="add"]:not([disabled])',
      ];

      let atcBtn = null, atcSelector = null;
      for (const sel of atcSelectors) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          const btnText = (el.innerText || el.value || '').trim().toLowerCase();
          if (/sold.?out|unavailable|notify|out.?of.?stock/i.test(btnText)) continue;
          atcBtn = el; atcSelector = sel; break;
        }
      }

      if (!atcBtn) {
        const btns = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'));
        atcBtn = btns.find(b => {
          if (!isVisible(b)) return false;
          const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
          if (/sold.?out|unavailable|notify|out.?of.?stock/i.test(t)) return false;
          return /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now|in.{0,5}cart/i.test(t);
        });
        if (atcBtn) atcSelector = `[data-atc-text-match]`;
      }

      return {
        hasTitle, titleText: h1?.innerText?.trim().slice(0, 60) || null,
        hasPrice, priceText: priceEl?.innerText?.trim().slice(0, 20) || null,
        hasImages: imgEls.length > 0, imageCount: imgEls.length,
        hasAtcBtn: !!atcBtn, atcSelector,
        atcText: (atcBtn?.innerText || atcBtn?.value || '').trim().slice(0, 40),
        isOutOfStock,
      };
    });

    result.hasProductTitle   = domCheck.hasTitle;
    result.hasPrice          = domCheck.hasPrice;
    result.hasImages         = domCheck.hasImages;
    result.hasAddToCartBtn   = domCheck.hasAtcBtn;
    result.addToCartSelector = domCheck.atcSelector;
    result.isOutOfStock      = domCheck.isOutOfStock;

    const currentUrl    = page.url();
    const isCategoryUrl = /\/(product-category|category|categories|collections?\/(?![\w-]+-\d|all$))/i.test(productUrl);
    const isHomepage    = new URL(currentUrl).pathname === '/';

    result.isCategoryPage = isCategoryUrl || isHomepage;
    result.siteType       = domCheck.hasAtcBtn ? 'transactional'
                          : domCheck.hasPrice   ? 'price-visible'
                          : domCheck.hasImages  ? 'catalog-style'
                          : 'unknown';
    result.passed = !result.isCategoryPage && result.hasProductTitle;

    const parts = [];
    if (isCategoryUrl)          parts.push(`⚠️  URL looks like a category page`);
    if (isHomepage)             parts.push(`⚠️  URL redirected to homepage`);
    if (domCheck.titleText)     parts.push(`Title: "${domCheck.titleText}"`);
    if (domCheck.priceText)     parts.push(`Price: ${domCheck.priceText}`);
    if (domCheck.hasImages)     parts.push(`${domCheck.imageCount} image(s)`);
    if (domCheck.isOutOfStock)  parts.push(`⚠️  Out of stock`);
    if (domCheck.atcText)       parts.push(`ATC: "${domCheck.atcText}"`);
    else if (!domCheck.hasAtcBtn) parts.push(`No ATC btn (${result.siteType})`);
    result.detail = parts.join(' | ') || 'Product detail page loaded';

  } catch (err) {
    result.detail = `Product detail error: ${err.message.slice(0, 100)}`;
  } finally {
    await page.close();
  }
  return result;
}

// ─── Steps 3-5: Add to cart → Cart page → Checkout ───────────────────────────

async function auditCartFlow(context, productUrl, productDetail, origin) {
  const result = {
    addToCart: {
      tested: false, passed: false,
      cartCountBefore: null, cartCountAfter: null,
      cartUpdated: false, method: null,
      detail: null, screenshot: null,
    },
    cartPage: {
      tested: false, passed: false, url: null,
      hasItem: false, hasPrice: false,
      hasQuantityControl: false, hasRemoveOption: false,
      lineItemCount: 0,
      detail: null, screenshot: null,
    },
    checkout: {
      tested: false, passed: false, url: null,
      reachable: false, requiresLogin: false,
      detail: null, screenshot: null,
    },
  };

  if (!productUrl) {
    result.addToCart.detail = 'No product URL to test';
    return result;
  }

  const hasAtcBtn = productDetail.hasAddToCartBtn;

  if (!hasAtcBtn) {
    result.addToCart.tested = true;
    result.addToCart.passed = false;
    result.addToCart.detail = `No Add-to-Cart button found — site type: ${productDetail.siteType || 'catalog-style'}`;
  }

  // [B3] Do NOT clearCookies — WooCommerce/Shopify use session cookies & nonces for ATC.
  // Clearing them before ATC breaks the add-to-cart request entirely.
  // We reuse the same page object for ATC → cart navigation so the session persists.

  const page = await context.newPage();
  const cdpSession = await page.context().newCDPSession(page);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(productUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 6000 }); } catch {}

    // ─── ADD TO CART PHASE ────────────────────────────────────────────────────

    if (hasAtcBtn) {
      const cartCountBefore = await page.evaluate(() => {
        const CART_BADGE_SELECTORS = [
          '[data-cart-count]','[data-item-count]','[data-cart-item-count]',
          '.cart-count','#cart-count','[class*="cart-count"]','[class*="CartCount"]','[class*="cart-qty"]',
        ];
        for (const sel of CART_BADGE_SELECTORS) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const attrVal = el.getAttribute('data-cart-count') || el.getAttribute('data-item-count') || el.getAttribute('data-cart-item-count');
          const raw    = attrVal ?? el.innerText;
          const parsed = parseInt((raw || '').replace(/\D/g, ''), 10);
          if (!isNaN(parsed) && parsed >= 0 && parsed < 1000) return parsed;
        }
        return null;
      });
      result.addToCart.cartCountBefore = cartCountBefore;
      result.addToCart.tested = true;

      // Auto-select variants
      const variantsSelected = await page.evaluate(() => {
        let selected = 0;
        for (const sel of document.querySelectorAll('form select,[class*="product"] select,[class*="variation"] select')) {
          const firstReal = Array.from(sel.options)
            .find(o => o.value && o.value !== '' && !/choose|select|pick/i.test(o.text));
          if (firstReal && sel.value !== firstReal.value) {
            sel.value = firstReal.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            selected++;
          }
        }
        for (const group of document.querySelectorAll('[class*="swatch"],[class*="variant-option"],[class*="VariantOption"],[class*="product-option"],[data-option-name]')) {
          const inputs = Array.from(group.querySelectorAll('input[type="radio"]'));
          if (inputs.length > 0 && !inputs.some(i => i.checked)) {
            const first = inputs.find(i => !i.disabled);
            if (first) { first.checked = true; first.dispatchEvent(new Event('change', { bubbles: true })); selected++; }
          }
        }
        return selected;
      });
      if (variantsSelected > 0) await sleep(700);

      // [B1] CDP network monitoring — only first-party cart endpoints.
      // Third-party conversion pixels often fire after ATC and are not cart traffic.
      const firstPartyOrigin = origin;
      const isRelevantCartRequest = (requestUrl, method) => {
        try {
          const parsed = new URL(requestUrl);
          if (parsed.origin !== firstPartyOrigin) return false;

          const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
          if (/^\/cart\/(add|update|change|items)(\?|$)/.test(path)) return true;
          if (/^\/cart\.(js|json)(\?|$)/.test(path)) return true;
          if (/^\/\?wc-ajax=/.test(path) && /add_to_cart|get_refreshed_fragments|update_order_review/.test(path)) return true;
          if (/^\/cart(\?|$)/.test(path) && method === 'POST') return true;
          if (/^\/basket\/(add|update|change|items)(\?|$)/.test(path)) return true;
          return false;
        } catch {
          return false;
        }
      };
      const isRelevantCartResponse = (responseUrl) => {
        try {
          const parsed = new URL(responseUrl);
          if (parsed.origin !== firstPartyOrigin) return false;
          const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
          return (
            /^\/cart\/(add|update|change|items)(\?|$)/.test(path) ||
            /^\/cart\.(js|json)(\?|$)/.test(path) ||
            /^\/\?wc-ajax=/.test(path) ||
            /^\/cart(\?|$)/.test(path) ||
            /^\/basket\/(add|update|change|items)(\?|$)/.test(path)
          );
        } catch {
          return false;
        }
      };

      const networkLog = { cartRequests: [], cartResponses: [], atcPostConfirmed: false, atcPostSucceeded: false };
      await cdpSession.send('Network.enable');
      cdpSession.on('Network.requestWillBeSent', ({ request }) => {
        const url = request.url;
        if (isRelevantCartRequest(url, request.method)) {
          networkLog.cartRequests.push({ url: url.slice(0, 120), method: request.method });
          // [A7] Track definitive ATC POST requests
          if (request.method === 'POST' && /\/cart\/add|wc-ajax=add_to_cart/i.test(url)) {
            networkLog.atcPostConfirmed = true;
          }
          console.log(`      🔌 Cart request: [${request.method}] ${url.slice(0, 80)}`);
        }
      });
      cdpSession.on('Network.responseReceived', ({ response }) => {
        const url = response.url;
        if (isRelevantCartResponse(url)) {
          networkLog.cartResponses.push({ url: url.slice(0, 120), status: response.status });
          // [A7] A 200 response to the ATC POST is definitive proof
          if (response.status === 200 && /\/cart\/add|wc-ajax=add_to_cart/i.test(url)) {
            networkLog.atcPostSucceeded = true;
          }
          console.log(`      ✅ Cart response: ${response.status} ${url.slice(0, 80)}`);
        }
      });

      // MutationObserver
      await page.evaluate(() => {
        window.__atcMutations   = 0;
        window.__atcMutationLog = [];
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            const target  = m.target;
            const nodeStr = [
              target.className || '', target.id || '',
              target.getAttribute?.('data-cart-count') || '',
              target.getAttribute?.('data-item-count')  || '',
              target.getAttribute?.('aria-label')        || '',
              target.getAttribute?.('data-count')        || '',
            ].join(' ');
            if (/cart|basket|bag|item.?count|qty|badge/i.test(nodeStr)) {
              window.__atcMutations++;
              window.__atcMutationLog.push(nodeStr.trim().slice(0, 60));
            }
            if (m.type === 'characterData') {
              const parent = m.target.parentElement;
              const pStr   = (parent?.className || '') + ' ' + (parent?.id || '');
              if (/cart|count|badge|qty/i.test(pStr)) {
                window.__atcMutations++;
                window.__atcMutationLog.push(`charData:${m.target.data}`);
              }
            }
          }
        });
        window.__atcObserver = observer;
        observer.observe(document.body, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['data-cart-count','data-item-count','aria-label','data-count','class'],
          characterData: true,
        });
      });

      const clicked = await clickAddToCartButton(page, productDetail.addToCartSelector);
      if (!clicked) {
        result.addToCart.detail = 'ATC button found in DOM audit but could not be clicked';
      } else {
        await sleep(INTERACTION_WAIT);

        const { mutations, mutationLog } = await page.evaluate(() => {
          window.__atcObserver?.disconnect();
          return { mutations: window.__atcMutations || 0, mutationLog: window.__atcMutationLog || [] };
        });
        console.log(`      🧬 DOM mutations after ATC click: ${mutations} (${mutationLog.slice(0, 3).join(', ')})`);

        // Server-side cart verification
        let serverVerified = false, serverItemCount = null, serverSource = null;
        try {
          const apiCheck = await page.evaluate(async (origin) => {
            const endpoints = [
              `${origin}/cart.js`, `${origin}/cart.json`,
              `${origin}/?wc-ajax=get_refreshed_fragments`, `${origin}/api/cart`,
            ];
            for (const ep of endpoints) {
              try {
                const r = await fetch(ep, { credentials: 'include', signal: AbortSignal.timeout(5000) });
                if (!r.ok) continue;
                const data = await r.json();
                const itemCount = data?.item_count ?? data?.items?.length ?? null;
                if (itemCount !== null) return { verified: itemCount > 0, itemCount, source: ep };
                if (data?.cart_hash || data?.data?.cart_hash) return { verified: true, itemCount: null, source: ep };
              } catch {}
            }
            return null;
          }, origin);

          if (apiCheck) {
            serverVerified  = apiCheck.verified;
            serverItemCount = apiCheck.itemCount;
            serverSource    = apiCheck.source;
            console.log(`      📦 Cart API: verified=${serverVerified} items=${serverItemCount} via ${serverSource}`);
          }
        } catch {}

        result.addToCart.screenshot = await takeScreenshot(page);

        const cartCountAfter = await page.evaluate(() => {
          const CART_BADGE_SELECTORS = [
            '[data-cart-count]','[data-item-count]','[data-cart-item-count]',
            '.cart-count','#cart-count','[class*="cart-count"]','[class*="CartCount"]','[class*="cart-qty"]',
          ];
          for (const sel of CART_BADGE_SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const attrVal = el.getAttribute('data-cart-count') || el.getAttribute('data-item-count') || el.getAttribute('data-cart-item-count');
            const raw    = attrVal ?? el.innerText;
            const parsed = parseInt((raw || '').replace(/\D/g, ''), 10);
            if (!isNaN(parsed) && parsed >= 0 && parsed < 1000) return parsed;
          }
          return null;
        });
        result.addToCart.cartCountAfter = cartCountAfter;

        // Detection cascade — ordered most reliable to least

        // [A7] MOST RELIABLE: Network POST to cart/add returned 200
        if (!result.addToCart.cartUpdated && networkLog.atcPostSucceeded) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method      = 'network-post-200 (/cart/add or wc-ajax confirmed)';
        }

        if (!result.addToCart.cartUpdated && cartCountBefore !== null && cartCountAfter !== null && cartCountAfter > cartCountBefore) {
          const delta = cartCountAfter - cartCountBefore;
          if (delta <= 50) {
            result.addToCart.cartUpdated = true;
            result.addToCart.method      = `cart-badge-increment (${cartCountBefore}→${cartCountAfter})`;
          }
        }

        if (!result.addToCart.cartUpdated) {
          const drawerVisible = await page.evaluate(() => {
            function vis(el) {
              const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
            }
            const el = document.querySelector(
              '[class*="cart-drawer"],[class*="CartDrawer"],[class*="mini-cart"],' +
              '[class*="MiniCart"],[class*="cart-sidebar"],[id*="cart-drawer"],' +
              '[class*="cart-flyout"],[class*="slide-cart"],[class*="offcanvas-cart"],' +
              '[class*="drawer"][class*="cart"],[id*="miniCart"],[id*="mini-cart"]'
            );
            return !!(el && vis(el));
          });
          if (drawerVisible) { result.addToCart.cartUpdated = true; result.addToCart.method = 'cart-drawer-opened'; }
        }

        if (!result.addToCart.cartUpdated) {
          const currentUrl = page.url();
          if (/\/cart|\/basket|\/bag/i.test(currentUrl) && currentUrl !== productUrl) {
            result.addToCart.cartUpdated = true;
            result.addToCart.method      = 'redirected-to-cart';
          }
        }

        if (!result.addToCart.cartUpdated) {
          const toastVisible = await page.evaluate(() => {
            function vis(el) {
              const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
            }
            const toasts = Array.from(document.querySelectorAll(
              '[class*="toast"],[class*="notification"],[role="alert"],[class*="snackbar"],' +
              '[class*="success"],[class*="added"],[class*="confirmation"],[class*="message"]'
            )).filter(vis);
            return toasts.some(t => /added|cart|success|item/i.test(t.innerText || ''));
          });
          if (toastVisible) { result.addToCart.cartUpdated = true; result.addToCart.method = 'success-toast-notification'; }
        }

        if (!result.addToCart.cartUpdated && serverVerified) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method      = `server-api-verified (${serverSource?.split('/').pop() || 'cart-api'}, ${serverItemCount ?? '?'} items)`;
        }

        if (!result.addToCart.cartUpdated && networkLog.cartRequests.length > 0 && mutations > 0) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method      = `ajax-request+dom-mutation (${mutations} mutation${mutations > 1 ? 's' : ''})`;
        }

        if (!result.addToCart.cartUpdated && networkLog.cartRequests.length > 0) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method      = `ajax-request-fired (${networkLog.cartRequests[0]?.method} ${networkLog.cartRequests[0]?.url.slice(0, 60)}) — verifying on cart page`;
        }

        if (!result.addToCart.cartUpdated && mutations >= 2) {
          result.addToCart.cartUpdated = true;
          result.addToCart.method      = `dom-mutations-only (${mutations} cart-related changes)`;
        }

        result.addToCart.passed = result.addToCart.cartUpdated;
        result.addToCart.detail = result.addToCart.passed
          ? `Cart updated via: ${result.addToCart.method}`
          : `No cart update detected — badge: ${cartCountBefore}→${cartCountAfter}, network: ${networkLog.cartRequests.length} requests, mutations: ${mutations}, server: ${serverVerified}`;

        console.log(`      ATC result: ${result.addToCart.passed ? '✅' : '❌'} ${result.addToCart.detail}`);
      }
    }

    try { await cdpSession.send('Network.disable'); } catch {}

    // ─── CART PAGE PHASE ──────────────────────────────────────────────────────
    // [B3] Navigate to cart on the SAME page so session cookies/nonces are preserved.
    // Opening a new page loses the WooCommerce/Shopify session and shows an empty cart.

    await sleep(500); // brief settle before navigating away from product page

    let cartUrl = null;
    const cartPaths = ['/cart', '/basket', '/bag'];
    for (const p of cartPaths) {
      try {
        const res       = await page.goto(`${origin}${p}`, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        const finalPath = new URL(page.url()).pathname.toLowerCase();
        if (res?.ok() && /\/(cart|basket|bag)(\/|$)/.test(finalPath)) {
          cartUrl = page.url();
          break;
        }
      } catch {}
    }

    const isOnCartPage = cartUrl || /cart|basket|bag/.test(new URL(page.url()).pathname.toLowerCase());

    if (isOnCartPage) {
      try { await page.waitForFunction(() => document.body.innerText.trim().length > 50, { timeout: 6000 }); } catch {}
      await sleep(800);

      result.cartPage.tested     = true;
      result.cartPage.url        = page.url();
      result.cartPage.screenshot = await takeScreenshot(page);

      const cartDOM = await page.evaluate(() => {
        function vis(el) {
          const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        }

        // [A6] 3-pass line-item detection
        const lineItemSelectors = [
          // Pass 1: most specific
          '[class*="cart-item"]', '[class*="CartItem"]',
          '[class*="line-item"]', '[class*="LineItem"]',
          '[class*="cart-product"]', '[data-cart-item]',
          '[class*="cart-entry"]', '[class*="CartEntry"]',
          'tr.cart_item', '.woocommerce-cart-form tr',
          '[class*="cart-row"]', 'li[class*="mini_cart_item"]',
          // Pass 2: WooCommerce/generic table rows with product data
          'table.shop_table tbody tr',
          // Pass 3: any repeated container with a price or product name inside it
        ];
        let lineItems = [];
        for (const sel of lineItemSelectors) {
          const els = Array.from(document.querySelectorAll(sel)).filter(el => {
            // Must be visible and not a header/footer row
            if (!vis(el)) return false;
            const tag = el.tagName.toLowerCase();
            if (tag === 'tr') {
              const cells = el.querySelectorAll('td');
              return cells.length >= 2; // a real product row has multiple cells
            }
            return true;
          });
          if (els.length > 0) { lineItems = els; break; }
        }

        // Pass 3 fallback: look for repeated containers that have both an image and a price-like text
        if (lineItems.length === 0) {
          const PRICE_RE = /[\$£€¥₹₩₽][\s]?\d|\d+[\.,]\d{2}/;
          const candidates = Array.from(document.querySelectorAll(
            'ul > li, ol > li, [class*="items"] > *, [class*="cart"] > *'
          )).filter(el => {
            if (!vis(el)) return false;
            if (el.closest('nav, header, footer')) return false;
            const hasImg   = !!el.querySelector('img');
            const hasPrice = PRICE_RE.test(el.innerText || '');
            const hasLink  = !!el.querySelector('a');
            return (hasImg || hasLink) && hasPrice;
          });
          if (candidates.length > 0) lineItems = candidates;
        }

        // [A2] Broadened price detection for cart page — subtotal/total/inline item prices
        const priceSelectors = [
          '[class*="price"]', '[class*="total"]', '[class*="subtotal"]',
          '[class*="cart-total"]', '[class*="order-total"]', '[data-cart-total]',
          '[class*="Price"]', '[class*="Total"]', '[class*="Subtotal"]',
          '[class*="amount"]', '[class*="Amount"]',
          '.woocommerce-Price-amount', 'bdi', 'ins .amount',
        ];
        let hasPriceEl = false;
        for (const sel of priceSelectors) {
          const el = document.querySelector(sel);
          if (el && vis(el) && el.innerText?.trim()) { hasPriceEl = true; break; }
        }
        // Also scan raw text for currency symbols
        if (!hasPriceEl) {
          const PRICE_RE = /[\$£€¥₹₩₽][\s]?\d{1,6}|\d{1,6}[\.,]\d{2}/;
          hasPriceEl = PRICE_RE.test(document.body?.innerText || '');
        }

        // [A3] Broadened qty detection — number inputs, stepper buttons, select dropdowns, text fields with qty label
        let hasQtyControl = false;
        const qtyInputSelectors = [
          'input[type="number"][min]',
          'input[name="quantity"]', 'input[name="updates[]"]',
          'input[class*="quantity"]', 'input[class*="qty"]',
          'input[class*="Quantity"]', 'input[class*="Qty"]',
          'select[name*="quantity"]', 'select[class*="quantity"]',
          '[data-quantity]', '[class*="quantity"]', '[class*="Quantity"]',
          '[class*="qty"]', '[class*="Qty"]',
        ];
        for (const sel of qtyInputSelectors) {
          const el = document.querySelector(sel);
          if (el && vis(el)) { hasQtyControl = true; break; }
        }

        // Also check for +/- stepper buttons (very common in modern themes)
        if (!hasQtyControl) {
          const stepperBtns = Array.from(document.querySelectorAll('button')).filter(b => {
            if (!vis(b)) return false;
            const text = (b.innerText || b.getAttribute('aria-label') || '').trim();
            const cls  = b.className || '';
            return /^[+\-]$|increase|decrease|increment|decrement|plus|minus/i.test(text + cls);
          });
          if (stepperBtns.length >= 1) hasQtyControl = true;
        }

        const removeBtn = Array.from(document.querySelectorAll('button,a,[role="button"]'))
          .find(el => vis(el) && /remove|delete|trash|×|✕/i
            .test(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || ''));

        // Checkout button detection
        const checkoutCandidates = Array.from(document.querySelectorAll(
          'button[name="checkout"],button[name="go_to_checkout"],' +
          'input[name="checkout"],[data-testid*="checkout"],' +
          'a[href*="/checkout"],a[href*="checkout.shopify"],' +
          'button,a[href],input[type="submit"]'
        ));
        const checkoutBtn = checkoutCandidates.find(el => {
          if (!vis(el)) return false;
          const text = (el.innerText || el.value || '').trim().toLowerCase();
          const href  = (el.getAttribute('href') || '').toLowerCase();
          const name  = (el.getAttribute('name') || '').toLowerCase();
          if (name === 'checkout' || name === 'go_to_checkout') return true;
          if (/\/checkout|checkout\.shopify/.test(href)) return true;
          return /^checkout$|proceed.?to.?checkout|go.?to.?checkout|place.?order|pay.?now|complete.?order/i.test(text);
        });

        let checkoutHref = null;
        if (checkoutBtn) {
          if (checkoutBtn.tagName === 'A' && checkoutBtn.href) {
            checkoutHref = checkoutBtn.href;
          } else {
            const form = checkoutBtn.closest('form');
            checkoutHref = form?.action?.includes('checkout') ? form.action : 'button:/checkout';
          }
        }

        const cartIsEmpty = /empty|no item|your cart is empty|nothing in/i
          .test(document.body?.innerText || '');

        return {
          lineItemCount: lineItems.length,
          hasPrice:      hasPriceEl,
          hasQty:        hasQtyControl,
          hasRemove:     !!removeBtn,
          checkoutHref,
          cartIsEmpty,
        };
      });

      result.cartPage.hasItem            = cartDOM.lineItemCount > 0;
      result.cartPage.lineItemCount      = cartDOM.lineItemCount;
      result.cartPage.hasPrice           = cartDOM.hasPrice;
      result.cartPage.hasQuantityControl = cartDOM.hasQty;
      result.cartPage.hasRemoveOption    = cartDOM.hasRemove;

      // [A8] If server API confirmed items exist but DOM missed them, still pass
      let serverConfirmedItems = 0;
      try {
        const apiResult = await page.evaluate(async (origin) => {
          const endpoints = [`${origin}/cart.js`, `${origin}/cart.json`];
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep, { credentials: 'include', signal: AbortSignal.timeout(5000) });
              if (!r.ok) continue;
              const data = await r.json();
              const itemCount = data?.item_count ?? data?.items?.length ?? null;
              if (itemCount !== null) return itemCount;
            } catch {}
          }
          return 0;
        }, origin);
        serverConfirmedItems = apiResult || 0;
      } catch {}

      result.cartPage.passed =
        (!cartDOM.cartIsEmpty && cartDOM.lineItemCount > 0) ||
        serverConfirmedItems > 0;  // [A8] server API is authoritative

      if (serverConfirmedItems > 0 && cartDOM.lineItemCount === 0) {
        // Server says there ARE items — DOM selectors missed them
        result.cartPage.hasItem       = true;
        result.cartPage.lineItemCount = serverConfirmedItems;
        result.cartPage.detail        = `${serverConfirmedItems} item(s) confirmed via cart API | price:${cartDOM.hasPrice ? '✅' : '❌'} qty:${cartDOM.hasQty ? '✅' : '❌'} remove:${!!cartDOM.hasRemove ? '✅' : '❌'}`;
      } else {
        result.cartPage.detail = cartDOM.cartIsEmpty
          ? 'Cart page loaded but appears empty — ATC may not have persisted'
          : cartDOM.lineItemCount === 0
            ? 'Cart page loaded but no line-item elements detected'
            : `${cartDOM.lineItemCount} line-item(s) | price:${cartDOM.hasPrice ? '✅' : '❌'} qty:${cartDOM.hasQty ? '✅' : '❌'} remove:${cartDOM.hasRemove ? '✅' : '❌'}`;
      }

      console.log(`      Cart page: ${result.cartPage.passed ? '✅' : '❌'} ${result.cartPage.detail}`);

      // ─── CHECKOUT PHASE ───────────────────────────────────────────────────

      const rawCheckoutHref  = cartDOM.checkoutHref;
      const resolvedCheckout = rawCheckoutHref?.startsWith('button:')
        ? `${origin}${rawCheckoutHref.replace('button:', '')}`
        : rawCheckoutHref;

      if (resolvedCheckout && resolvedCheckout !== 'button') {
        result.checkout.tested = true;
        result.checkout.url    = resolvedCheckout;

        try {
          const checkoutRes = await page.goto(resolvedCheckout, { waitUntil: 'load', timeout: NAV_TIMEOUT });
          const finalUrl   = page.url();
          const httpStatus = checkoutRes?.status() ?? 0;
          const finalPath  = new URL(finalUrl).pathname.toLowerCase();

          result.checkout.screenshot = await takeScreenshot(page);

          const checkoutDOM = await page.evaluate((httpStatus) => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const isCheckoutPage =
              /checkout/i.test(location.pathname) ||
              /shipping|billing|payment|order summary|place order|your order|review your order/i.test(bodyText);

            // [A4] Only flag "requires login" if it's a hard wall:
            // — page has ONLY login/register fields and NO checkout form fields (shipping/billing/payment)
            // — guest checkout is NOT available
            const hasCheckoutFields = !!(
              document.querySelector('input[name*="address"], input[name*="zip"], input[name*="postal"], input[name*="phone"], input[name*="first_name"], input[name*="firstname"], input[id*="shipping"], input[id*="billing"]')
            );
            const hasGuestOption = /guest|continue without|no account|shop as guest/i.test(bodyText);
            const hasLoginWall   = (
              /sign in|log in|login required|create account/i.test(bodyText) &&
              !!document.querySelector('input[type="email"],input[type="password"]') &&
              !hasCheckoutFields &&  // no checkout form fields present
              !hasGuestOption        // no guest checkout option
            );

            const isError =
              httpStatus >= 400 ||
              /\b404\b|\bnot found\b|\bserver error\b|\b500\b/i.test(bodyText.slice(0, 300));

            return { isCheckoutPage, requiresLogin: hasLoginWall, isError };
          }, httpStatus);

          const finalUrlHasCheckout = /checkout|payment|billing|shipping/i.test(finalPath);

          result.checkout.reachable     = !checkoutDOM.isError &&
                                          (checkoutDOM.isCheckoutPage || finalUrlHasCheckout || httpStatus < 400);
          result.checkout.requiresLogin = checkoutDOM.requiresLogin;
          result.checkout.passed        = result.checkout.reachable;

          result.checkout.detail = checkoutDOM.requiresLogin
            ? `Checkout reachable but requires login — no guest option (${finalUrl.slice(0, 70)})`
            : result.checkout.reachable
              ? `Checkout accessible — HTTP ${httpStatus}, final URL: ${finalUrl.slice(0, 70)}`
              : `Checkout not accessible — HTTP ${httpStatus}, URL: ${finalUrl.slice(0, 70)}`;

        } catch (err) {
          result.checkout.detail = `Checkout navigation failed: ${err.message.slice(0, 80)}`;
        }

      } else if (rawCheckoutHref?.startsWith('button:')) {
        result.checkout.tested    = true;
        result.checkout.passed    = true;
        result.checkout.reachable = true;
        result.checkout.detail    = 'Checkout button present on cart page (JS-triggered)';
      } else {
        result.checkout.detail = 'No checkout button/link found on cart page';
      }

      console.log(`      Checkout: ${result.checkout.passed ? '✅' : '❌'} ${result.checkout.detail}`);

    } else {
      result.cartPage.detail = 'Could not locate cart page';
      result.checkout.detail = 'Skipped — cart page not found';
    }

  } catch (err) {
    result.addToCart.detail = result.addToCart.detail || `Cart flow error: ${err.message.slice(0, 100)}`;
    console.error(`      ❌ Cart flow exception: ${err.message}`);
  } finally {
    try { await cdpSession.detach(); } catch {}
    await page.close();
  }

  return result;
}

// ─── Click ATC button ─────────────────────────────────────────────────────────

async function clickAddToCartButton(page, selectorHint) {
  if (selectorHint && selectorHint !== '[data-atc-text-match]') {
    try {
      const el = await page.$(selectorHint);
      if (el && await el.isVisible()) {
        await el.click({ timeout: 5000 });
        console.log(`      🖱  ATC clicked via hint: ${selectorHint}`);
        return true;
      }
    } catch {}
  }

  const selectors = [
    '[data-add-to-cart]', '[data-action="add-to-cart"]',
    'form[action*="cart"] button[type="submit"]:not([disabled])',
    'form[action*="cart"] input[type="submit"]:not([disabled])',
    'button[class*="add"][class*="cart"]:not([disabled])',
    'button[class*="AddToCart"]:not([disabled])',
    'button[class*="add-to-cart"]:not([disabled])',
    'button[class*="addToCart"]:not([disabled])',
    'button[class*="add_to_cart"]:not([disabled])',
    '[id*="add-to-cart"]:not([disabled])', '[id*="addToCart"]:not([disabled])',
    '#add-to-cart:not([disabled])', 'button[name="add"]:not([disabled])',
    'input[name="add"]:not([disabled])',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        const text = await el.evaluate(e => (e.innerText || e.value || '').trim());
        if (/sold.?out|unavailable|notify|out.?of.?stock/i.test(text)) continue;
        await el.click({ timeout: 5000 });
        console.log(`      🖱  ATC clicked via selector: ${sel}`);
        return true;
      }
    } catch {}
  }

  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'))
      .find(b => {
        const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
        const r = b.getBoundingClientRect(), s = window.getComputedStyle(b);
        if (r.width === 0 || r.height === 0 || s.display === 'none') return false;
        if (/sold.?out|unavailable|notify|out.?of.?stock/i.test(t)) return false;
        return /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now|in.{0,5}cart/i.test(t);
      });
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (clicked) console.log(`      🖱  ATC clicked via text-match`);
  return clicked;
}

// ─── Drill into category URL to find real product URL ────────────────────────

async function drillForProductUrl(context, categoryUrl, origin) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(categoryUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 6000 }); } catch {}

    return page.evaluate((origin) => {
      const PRODUCT_PATH = /\/(products?|items?|p|pd|detail|sku)\/[^/?#]+/i;
      const SKIP         = /\/(cart|checkout|account|login|wishlist|category|categories)\//i;

      function getHref(el) {
        if (el.tagName === 'A' && el.href) return el.href;
        const c = el.querySelector('a[href]');
        if (c) return c.href;
        const p = el.closest('a[href]');
        return p ? p.href : null;
      }

      for (const sel of [
        'ul.products li.product', '[class*="product-item"]', '[class*="ProductItem"]',
        '[class*="product-card"]', '.product', 'li.product', 'article.product', '[data-product-id]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const href = getHref(el);
          if (href && href.startsWith(origin) && PRODUCT_PATH.test(href) && !SKIP.test(href) &&
              new URL(href).pathname !== '/') return href;
        }
      }

      for (const a of document.querySelectorAll('a[href]')) {
        if (a.href?.startsWith(origin) && PRODUCT_PATH.test(a.href) && !SKIP.test(a.href) &&
            a.href !== location.href && new URL(a.href).pathname !== '/') return a.href;
      }
      return null;
    }, origin);
  } catch { return null; } finally { await page.close(); }
}

// ─── Cart URL discovery ───────────────────────────────────────────────────────

async function findCartUrl(page, origin) {
  const domLink = await page.evaluate((origin) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => { try { return new URL(a.href); } catch { return null; } })
      .filter(u => u && u.origin === origin)
      .find(u => /^\/cart(\/|$)|^\/basket(\/|$)|^\/bag(\/|$)/i.test(u.pathname))
      ?.href || null;
  }, origin);
  if (domLink) return domLink;

  for (const p of ['/cart', '/basket', '/bag', '/shopping-cart']) {
    const candidate = `${origin}${p}`;
    if (await isReachable(candidate)) return candidate;
  }
  return null;
}

// ─── Score calculation ────────────────────────────────────────────────────────

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
  if (steps.checkout?.passed) {
    // [A9] Only penalise if it's a hard login wall (no guest option)
    score += steps.checkout.requiresLogin ? 10 : WEIGHTS.checkout;
  }
  return score;
}

// ─── In-stock product finder ──────────────────────────────────────────────────

async function findInStockProductUrl(context, listingUrl, candidateUrl, origin) {
  if (!candidateUrl) return candidateUrl;

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(candidateUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    if (!res?.ok()) return candidateUrl;
    try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

    const { isOutOfStock, atcExists } = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const isOutOfStock = /\bsold.?out\b|\bout.?of.?stock\b|\bunavailable\b/i.test(bodyText);
      const atcExists = !!Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'))
        .find(b => {
          const t = (b.innerText || b.value || '').trim();
          return /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now/i.test(t) && !/sold.?out|unavailable|notify/i.test(t);
        });
      return { isOutOfStock, atcExists };
    });

    if (!isOutOfStock && atcExists) return candidateUrl;
    console.log(`      ⚠️  Candidate product is out of stock or has no ATC — scanning listing for in-stock product...`);
  } finally { await page.close(); }

  const listingPage = await context.newPage();
  try {
    await listingPage.setViewportSize({ width: 1440, height: 900 });
    await listingPage.goto(listingUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await listingPage.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
    await sleep(500);

    const allLinks = await listingPage.evaluate((origin) => {
      const PRODUCT_PATH = /\/(products?|items?|p|pd|detail|sku)\/[^/?#]+/i;
      const SKIP         = /\/(cart|checkout|account|login|wishlist|category|categories)\//i;
      return Array.from(new Set(
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(href => href?.startsWith(origin) && PRODUCT_PATH.test(href) && !SKIP.test(href))
      )).slice(0, 10);
    }, origin);

    for (const link of allLinks) {
      if (link === candidateUrl) continue;
      const testPage = await context.newPage();
      try {
        await testPage.goto(link, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        try { await testPage.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
        const { isOutOfStock, atcExists } = await testPage.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const isOutOfStock = /\bsold.?out\b|\bout.?of.?stock\b|\bunavailable\b/i.test(bodyText);
          const atcExists = !!Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'))
            .find(b => {
              const t = (b.innerText || b.value || '').trim();
              return /add.{0,10}cart|add.{0,10}bag|buy.{0,5}now/i.test(t) && !/sold.?out|unavailable|notify/i.test(t);
            });
          return { isOutOfStock, atcExists };
        });
        if (!isOutOfStock && atcExists) {
          console.log(`      ✅ Found in-stock alternative: ${link}`);
          return link;
        }
      } finally { await testPage.close(); }
    }
  } finally { await listingPage.close(); }

  return candidateUrl;
}

// ─── Main audit entry point ───────────────────────────────────────────────────

async function auditEcommerce(context, url, timeout = 90_000) {  // [B2] raised from 30s
  const page = await context.newPage();
  const result = {
    url, isEcommerce: false, platform: null, confidence: 'low',
    detectionMethod: 'dom-only',
    productListing: { tested: false, passed: false, detail: 'Not tested' },
    productDetail:  { tested: false, passed: false, detail: 'Not tested' },
    addToCart:      { tested: false, passed: false, detail: 'Not tested' },
    cartPage:       { tested: false, passed: false, detail: 'Not tested' },
    checkout:       { tested: false, passed: false, detail: 'Not tested' },
    overallStatus: 'healthy', score: null, issues: [],
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout });
    } catch (navErr) {
      const msg    = navErr.message || '';
      const reason = msg.includes('Timeout')     ? `Timeout after ${timeout/1000}s — site may be slow or blocking bots`
                   : msg.includes('ERR_ABORTED') ? `Navigation aborted — check URL (missing https?)`
                   : msg.includes('ERR_NAME')    ? `DNS lookup failed — domain may not exist`
                   : `Navigation error: ${msg.slice(0, 120)}`;
      throw new Error(reason);
    }

    if (!response?.ok()) {
      result.issues.push({ type: 'critical', code: 'PAGE_LOAD_FAILED', message: `HTTP ${response?.status()}` });
      result.overallStatus = 'critical';
      return result;
    }

    try { await page.waitForFunction(() => document.body?.innerText?.trim().length > 100, { timeout: 6000 }); } catch {}

    console.log(`   🔍 Detecting ecommerce signals...`);
    const domDetection = await detectEcommerceDOM(page);

    result.isEcommerce = domDetection.isEcommerce;
    result.platform    = domDetection.platform;
    result.confidence  = domDetection.confidence;

    console.log(
      `   ${result.isEcommerce ? '🛒' : '❌'} Ecommerce: ${result.isEcommerce} | ` +
      `Platform: ${result.platform || 'unknown'} | Confidence: ${result.confidence} | ` +
      `DOM score: ${domDetection.domScore}`
    );

    if (!result.isEcommerce) {
      result.issues.push({ type: 'info', code: 'NOT_ECOMMERCE',
        message: `Not ecommerce (DOM score: ${domDetection.domScore})` });
      result.overallStatus = 'healthy';
      result.score         = null;
      return result;
    }

    const origin = new URL(url).origin;

    console.log(`   📦 Step 1: Product listing...`);
    const listingUrl      = await findProductListingUrl(page, origin);
    result.productListing = await auditProductListing(context, listingUrl);
    console.log(`      ${result.productListing.passed ? '✅' : '❌'} ${result.productListing.detail}`);

    console.log(`   🏷  Step 2: Product detail...`);
    let productUrl       = result.productListing.sampleProductUrl || null;
    result.productDetail = await auditProductDetail(context, productUrl);

    if (result.productDetail.isCategoryPage && productUrl) {
      console.log(`      ↪ Category/homepage — drilling for real product URL...`);
      const deep = await drillForProductUrl(context, productUrl, origin);
      if (deep && deep !== productUrl) {
        productUrl           = deep;
        result.productDetail = await auditProductDetail(context, productUrl);
      }
    }

    if (result.productDetail.isOutOfStock && listingUrl && productUrl) {
      console.log(`      ↪ Product is out of stock — searching for in-stock alternative...`);
      const inStockUrl = await findInStockProductUrl(context, listingUrl, productUrl, origin);
      if (inStockUrl && inStockUrl !== productUrl) {
        productUrl           = inStockUrl;
        result.productDetail = await auditProductDetail(context, productUrl);
      }
    }

    console.log(`      ${result.productDetail.passed ? '✅' : '❌'} ${result.productDetail.detail}`);

    console.log(`   🛒 Steps 3-5: Add to cart → Cart page → Checkout...`);
    const cartFlow   = await auditCartFlow(context, productUrl, result.productDetail, origin);
    result.addToCart = cartFlow.addToCart;
    result.cartPage  = cartFlow.cartPage;
    result.checkout  = cartFlow.checkout;

    result.score = calculateScore(result);

    if (!result.productListing.passed)
      result.issues.push({ type: 'critical', code: 'PRODUCT_LISTING_FAILED',
        message: `Product listing: ${result.productListing.detail}` });
    if (!result.productDetail.passed)
      result.issues.push({ type: result.productDetail.tested ? 'critical' : 'warning',
        code: 'PRODUCT_DETAIL_FAILED', message: `Product detail: ${result.productDetail.detail}` });
    if (!result.addToCart.passed)
      result.issues.push({
        type: !result.productDetail?.hasAddToCartBtn ? 'info' : 'critical',
        code: !result.productDetail?.hasAddToCartBtn ? 'NO_ATC_BUTTON' : 'ADD_TO_CART_FAILED',
        message: `Add to cart: ${result.addToCart.detail}`,
      });
    if (!result.cartPage.passed)
      result.issues.push({ type: 'critical', code: 'CART_PAGE_FAILED',
        message: `Cart page: ${result.cartPage.detail || 'Cart page empty or unreachable'}` });
    if (!result.checkout.passed)
      result.issues.push({ type: result.checkout.tested ? 'critical' : 'warning',
        code: 'CHECKOUT_FAILED',
        message: `Checkout: ${result.checkout.detail || 'No checkout button found'}` });
    if (result.checkout.requiresLogin)
      result.issues.push({ type: 'info', code: 'CHECKOUT_REQUIRES_LOGIN',
        message: 'Checkout requires login — no guest option available (may reduce conversions)' });
    if (result.productDetail.isOutOfStock && result.productDetail.passed)
      result.issues.push({ type: 'warning', code: 'PRODUCT_OUT_OF_STOCK',
        message: 'Tested product was out of stock — no in-stock alternative found on listing' });

    const criticals = result.issues.filter(i => i.type === 'critical');
    const warnings  = result.issues.filter(i => i.type === 'warning');
    result.overallStatus = criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy';

  } catch (err) {
    result.overallStatus = 'critical';
    result.score         = 0;
    result.issues.push({ type: 'critical', code: 'AUDIT_FATAL', message: `Fatal: ${err.message}` });
    result.fatalError    = err.message;
    console.error(`   ❌ Ecommerce audit fatal: ${err.message}`);
  } finally {
    await page.close();
  }

  return result;
}

module.exports = { auditEcommerce };