'use strict';
require('dotenv').config();
const { chromium } = require('playwright-core');

const url = process.argv[2] || 'https://stripe.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

  const debug = await page.evaluate(() => {
    const info = {};

    // 1. What top-level structural elements exist?
    info.hasHeader   = !!document.querySelector('header');
    info.hasBanner   = !!document.querySelector('[role="banner"]');
    info.navCount    = document.querySelectorAll('nav').length;
    info.navRoleCount = document.querySelectorAll('[role="navigation"]').length;

    // 2. Header details
    const header = document.querySelector('header') || document.querySelector('[role="banner"]');
    if (header) {
      const navsInHeader = Array.from(header.querySelectorAll('nav'));
      info.navsInsideHeader = navsInHeader.length;
      info.headerTag = header.tagName;
      info.headerClasses = header.className?.slice(0, 80);
      info.headerDirectChildTags = Array.from(header.children).map(c => c.tagName).join(', ');
      info.headerLinksTotal = header.querySelectorAll('a[href]').length;

      // What do each nav contain?
      info.navsDetail = navsInHeader.map((n, i) => ({
        index: i,
        classes: n.className?.slice(0, 60),
        linkCount: n.querySelectorAll('a[href]').length,
        firstFewLinks: Array.from(n.querySelectorAll('a[href]')).slice(0, 4).map(a => a.innerText?.trim().slice(0, 30)),
      }));
    } else {
      info.navsInsideHeader = 0;
    }

    // 3. All nav elements on page
    info.allNavs = Array.from(document.querySelectorAll('nav')).map((n, i) => ({
      index: i,
      classes: n.className?.slice(0, 60),
      id: n.id,
      linkCount: n.querySelectorAll('a[href]').length,
      insideHeader: !!(document.querySelector('header')?.contains(n)),
    }));

    // 4. Any custom header-like elements (data attributes, aria)
    const customHeader = document.querySelector('[data-testid*="header"], [data-testid*="nav"], [class*="GlobalNav"], [class*="SiteHeader"], [class*="TopBar"]');
    info.customHeaderEl = customHeader ? customHeader.tagName + '.' + customHeader.className?.slice(0, 60) : null;

    return info;
  });

  console.log('\n🔍 Header/Nav DOM Debug for:', url, '\n');
  console.log('Structural elements:');
  console.log('  <header> found     :', debug.hasHeader);
  console.log('  role=banner found  :', debug.hasBanner);
  console.log('  Total <nav> count  :', debug.navCount);
  console.log('  role=navigation    :', debug.navRoleCount);
  console.log('  Custom header el   :', debug.customHeaderEl);
  console.log('');
  console.log('Header details:');
  console.log('  Tag                :', debug.headerTag);
  console.log('  Classes            :', debug.headerClasses);
  console.log('  Direct children    :', debug.headerDirectChildTags);
  console.log('  <nav> inside header:', debug.navsInsideHeader);
  console.log('  Total <a> in header:', debug.headerLinksTotal);
  console.log('');

  if (debug.navsDetail?.length > 0) {
    console.log('Navs inside header:');
    for (const n of debug.navsDetail) {
      console.log(`  nav[${n.index}] classes: "${n.classes}"`);
      console.log(`           links: ${n.linkCount}  first: ${n.firstFewLinks?.join(' | ')}`);
    }
    console.log('');
  }

  console.log('All <nav> elements on page:');
  for (const n of debug.allNavs) {
    console.log(`  nav[${n.index}] links:${n.linkCount}  inHeader:${n.insideHeader}  id:"${n.id}"  classes:"${n.classes}"`);
  }

  await browser.close();
})();