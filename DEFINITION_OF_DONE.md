# Web Auditor - Ticket Summary

## What the tool achieves today
- Audits a website from a URL through CLI or API.
- Can run as full-site crawl from homepage or as a single-page audit for a deep link.
- Checks these layers: Health, UI/Layout, Navigation, Forms, Ecommerce, and Performance.
- Produces results JSON, report JSON, HTML report, and PDF-ready output.
- Uses Playwright for browser-driven checks and PSI/Lighthouse for performance metrics.

## Main limitation
- Ecommerce detection depends on finding a listing/hub page first.
- The crawler uses common ecommerce slugs and site patterns like products, shop, store, catalog, collections, and similar paths.
- If no listing page is detected, the ecommerce funnel does not continue to product detail, add-to-cart, cart, or checkout testing.
- So ecommerce coverage is only as good as the site structure and slug discovery.

## Other limitations
- Crawl scope is limited, so it is not a full site mirror of every page.
- Deep authenticated flows are not fully supported.
- Captcha-heavy or anti-bot protected flows can become inconclusive.
- It is not a complete accessibility, security, or SEO scanner.

## Short ticket description
Web Auditor can currently crawl a site, audit key UX/health/navigation/forms/performance layers, and generate downloadable reports. Ecommerce testing works only when a listing page is detected from common slug patterns, because the funnel starts from that listing page and cannot continue if discovery fails.
