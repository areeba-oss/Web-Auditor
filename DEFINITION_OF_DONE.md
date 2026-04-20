# Web Auditor - Ticket Summary

## What the tool achieves today
- Audits a website from URL via CLI and API.
- Supports both homepage crawl mode and single deep-link mode.
- Runs six layers: Health, UI/Layout, Navigation, Forms, Ecommerce, Performance.
- Produces raw audit results plus report JSON and HTML/PDF-ready output.
- Uses Playwright-driven checks for browser/flow layers and PSI (Lighthouse data source) for performance.

## Definition of Done (current scope)
This ticket is considered done when all points below are true:

- Input handling: Tool accepts a valid URL and starts audit from CLI/API without manual code changes.
- Crawl behavior: Homepage mode shortlists a bounded set of important internal pages; deep-link mode audits only that target page.
- Layer coverage: All six layers execute in sequence and return structured result objects (or structured failure state).
- Output artifacts: Run generates machine-readable JSON plus report JSON/HTML artifacts for downstream sharing/export.
- Scoring/status: Each layer reports score, status (`healthy`/`warning`/`critical`), and issue list.
- Graceful failure: If one check is inconclusive or blocked, audit still completes with partial findings instead of hard crashing the whole run.
- Reporting: Final report reflects available evidence with clear limitations and does not claim unsupported capabilities.

## Main limitation
- Ecommerce testing still depends on finding a product listing/hub page first.
- Discovery relies on common ecommerce slugs/patterns such as products, shop, store, catalog, collections.
- If listing discovery fails, funnel progression to detail, add-to-cart, cart, and checkout cannot be reliably executed.
- So ecommerce confidence is tightly coupled to discoverability and site URL/IA conventions.

## Layer-wise limitations (deep dive)

### Crawl and page discovery limitations
- Crawl shortlist is intentionally capped (not full-site exhaustive crawling).
- Hard skip rules intentionally ignore many URL types (pagination/search/legal/auth/media and similar), so relevant edge pages can be skipped.
- Rule/heuristic based selection can miss atypical information architecture.
- Deep authenticated areas or session-gated routes are not comprehensively crawled.

### Health layer limitations
- Health is strong for load/render/network signals but is not a full production observability replacement.
- Console/network findings are broad and can include third-party noise.
- Anti-bot/CDN behavior can distort status or network-failure interpretation.

### UI/Layout layer limitations
- UI/Layout is currently rule-based DOM analysis; no computer-vision model is used for visual judgment.
- It assumes common structural conventions like header/nav/footer and predictable CTA/logo patterns.
- If a website does not follow standard structure (for example missing semantic header/main/footer, custom wrappers, unusual class/id naming, or heavy canvas/shadow-dom composition), detection quality drops.
- Brand-level design quality, alignment nuance, visual hierarchy, and aesthetic consistency are not deeply judged like human visual review.

### Navigation layer limitations
- Link checks are sampled/capped for internal and external sets, so very large sites are partially validated.
- JS-driven interactions that do not expose stable href endpoints may be classified with limited confidence.
- External link status can fluctuate due to rate limits, bot protection, or remote server behavior.

### Forms layer limitations
- Forms testing is DOM-rule driven and focuses on intrinsic validation behavior (empty submit, invalid email, required fields, visible errors).
- It is not an end-to-end business workflow validator for every backend integration.
- Form count/testing is intentionally capped, and duplicate fingerprints may be skipped to control audit time.
- Classification rules skip some forms (for example search/login-only), and treat simple newsletter forms with lighter checks.
- Multi-step, OTP/Captcha, anti-automation, or heavily custom JS validation flows can become partial/inconclusive.
- Success-state detection is UI-text/signal based and may miss non-standard confirmation UX.

### Ecommerce layer limitations
- Funnel checks are best-effort across many platforms but cannot guarantee full transactional completion on every stack.
- Session, stock, region, currency, and bot-protection differences can break deterministic add-to-cart/checkout progression.
- Login-gated or protected checkout flows may only be partially assessable.

### Performance layer limitations
- Performance layer depends on PSI API availability, quota, and network reliability.
- Without API key, heavy rate limiting applies and consistency can drop.
- Metrics are environment/sample dependent; results represent a point-in-time benchmark, not full RUM coverage.

### Tool-wide boundaries
- This tool is not a complete accessibility (WCAG), security, SEO, or compliance scanner.
- It does not fully automate deeply authenticated user journeys across all app states.
- Captcha-heavy or anti-bot protected websites can produce inconclusive outcomes in multiple layers.

## Short ticket description
Web Auditor currently audits a target site across health, UI/layout, navigation, forms, ecommerce, and performance layers, and generates downloadable report artifacts. The system is intentionally bounded by rule-based discovery and check logic: forms and layout checks are deterministic DOM/rule driven (not vision based), and ecommerce coverage remains dependent on successful listing-page discovery from common site patterns.
