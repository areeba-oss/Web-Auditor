'use strict';

/**
 * basicHealthCheck.js — Layer 1 audit: Page Load & Basic Health
 *
 * Checks:
 *   1. HTTP status (200 OK?)
 *   2. Blank screen / broken layout detection
 *   3. Console errors & warnings (JS errors)
 *   4. Network failures (failed/blocked requests)
 *
 * Returns a structured result + AI-powered analysis of findings.
 */

// ─── Noise patterns — analytics/trackers we don't care about ─────────────────

const NOISE_PATTERNS = [
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /googlesyndication\.com/,
  /doubleclick\.net/,
  /facebook\.net/,
  /connect\.facebook\.net/,
  /hotjar\.com/,
  /clarity\.ms/,
  /mouseflow\.com/,
  /fullstory\.com/,
  /segment\.com/,
  /mixpanel\.com/,
  /amplitude\.com/,
  /intercom\.io/,
  /crisp\.chat/,
  /tawk\.to/,
  /cdn\.heapanalytics\.com/,
];

function isNoise(str = '') {
  return NOISE_PATTERNS.some((p) => p.test(str));
}

// ─── Blank screen detection ───────────────────────────────────────────────────

const BLANK_SCREEN_CHECKS = {
  minBodyText: 100,      // less than this = likely blank
  minVisibleElements: 3, // less than this = broken layout
};

// ─── Main audit function ──────────────────────────────────────────────────────

/**
 * @param {import('playwright-core').Page} page  — already loaded Playwright page
 * @param {string} url                           — page URL
 * @param {object} loadResult                    — { httpStatus, redirectedTo }
 * @returns {Promise<HealthCheckResult>}
 */
async function runBasicHealthCheck(page, url, loadResult = {}) {
  const result = {
    url,
    // ── 1. HTTP Status ──────────────────────────────────────────
    httpStatus: loadResult.httpStatus ?? null,
    httpOk: false,
    redirectedTo: loadResult.redirectedTo ?? null,
    wasRedirected: false,

    // ── 2. Blank Screen ─────────────────────────────────────────
    blankScreen: false,
    blankScreenReason: null,
    bodyTextLength: 0,
    visibleElementCount: 0,

    // ── 3. Console Errors/Warnings ──────────────────────────────
    consoleErrors: [],
    consoleWarnings: [],
    significantErrors: [],       // after noise filtering
    significantWarnings: [],
    filteredNoise: [],

    // ── 4. Network Failures ─────────────────────────────────────
    failedRequests: [],
    blockedRequests: [],
    criticalFailures: [],        // failures that likely affect page function

    // ── Summary ─────────────────────────────────────────────────
    overallStatus: 'healthy',    // healthy | warning | critical
    issues: [],
    score: 100,
  };

  try {

    // ── 1. HTTP STATUS ──────────────────────────────────────────────────────
    result.httpOk = result.httpStatus >= 200 && result.httpStatus < 400;
    result.wasRedirected = !!(result.redirectedTo && result.redirectedTo !== url);

    if (!result.httpOk) {
      result.issues.push({
        type: 'critical',
        code: 'HTTP_ERROR',
        message: `Page returned HTTP ${result.httpStatus} — users cannot access this page`,
      });
    }

    if (result.wasRedirected) {
      result.issues.push({
        type: 'info',
        code: 'REDIRECT',
        message: `Page redirects to ${result.redirectedTo}`,
      });
    }

    // ── 2. BLANK SCREEN DETECTION ───────────────────────────────────────────
    const domData = await page.evaluate((checks) => {
      const bodyText = document.body?.innerText?.trim() ?? '';

      // Count meaningfully visible elements (not hidden, not 0-size)
      const allEls = Array.from(document.querySelectorAll(
        'p, h1, h2, h3, h4, img, button, a, li, td, span, div'
      ));
      const visibleCount = allEls.filter((el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          s.opacity !== '0'
        );
      }).length;

      // Check if page has a meaningful <title>
      const title = document.title?.trim() ?? '';
      const hasTitle = title.length > 0 && title.toLowerCase() !== 'untitled';

      // Check for common error page indicators — word-boundary match to avoid
      // false positives like "$500" or "1-800-" on real pages
      const errorPageSignals = [
        /\b404\b.{0,30}(not found|page)/i,
        /\b(page|file) not found\b/i,
        /\b500\b.{0,30}(internal server error|error)/i,
        /\binternal server error\b/i,
        /\b403\b.{0,30}forbidden/i,
        /\baccess (denied|forbidden)\b/i,
        /\b502\b.{0,30}bad gateway/i,
        /\b503\b.{0,30}(unavailable|maintenance)/i,
        /\bsite (is under|under) (maintenance|construction)\b/i,
      ].filter((rx) => rx.test(bodyText)).map((rx) => rx.toString());

      return {
        bodyTextLength: bodyText.length,
        visibleElementCount: visibleCount,
        hasTitle,
        title,
        errorPageSignals,
      };
    }, BLANK_SCREEN_CHECKS);

    result.bodyTextLength = domData.bodyTextLength;
    result.visibleElementCount = domData.visibleElementCount;
    result.pageTitle = domData.title;

    // Determine if page is blank/broken
    if (domData.bodyTextLength < BLANK_SCREEN_CHECKS.minBodyText) {
      result.blankScreen = true;
      result.blankScreenReason = `Body text only ${domData.bodyTextLength} chars (min: ${BLANK_SCREEN_CHECKS.minBodyText}) — page likely not hydrated or empty`;
    } else if (domData.visibleElementCount < BLANK_SCREEN_CHECKS.minVisibleElements) {
      result.blankScreen = true;
      result.blankScreenReason = `Only ${domData.visibleElementCount} visible elements found — layout likely broken`;
    } else if (domData.errorPageSignals.length > 0) {
      result.blankScreen = true;
      result.blankScreenReason = `Error page content detected: "${domData.errorPageSignals[0]}"`;
    }

    if (result.blankScreen) {
      result.issues.push({
        type: 'critical',
        code: 'BLANK_SCREEN',
        message: result.blankScreenReason,
      });
    }

    // ── 3. CONSOLE ERRORS & WARNINGS ────────────────────────────────────────
    // NOTE: Callers must set up page.on('console') BEFORE page.goto()
    // These are passed in via loadResult.consoleErrors/consoleWarnings
    const rawErrors = loadResult.consoleErrors ?? [];
    const rawWarnings = loadResult.consoleWarnings ?? [];

    result.consoleErrors = rawErrors;
    result.consoleWarnings = rawWarnings;

    // Separate real errors from analytics/tracker noise
    result.significantErrors = rawErrors.filter((e) => !isNoise(e));
    result.significantWarnings = rawWarnings.filter((w) => !isNoise(w));
    result.filteredNoise = [
      ...rawErrors.filter(isNoise),
      ...rawWarnings.filter(isNoise),
    ];

    if (result.significantErrors.length > 0) {
      result.issues.push({
        type: result.significantErrors.length >= 5 ? 'critical' : 'warning',
        code: 'CONSOLE_ERRORS',
        message: `${result.significantErrors.length} JS error(s) detected (${result.filteredNoise.length} analytics/tracker noise filtered)`,
        detail: result.significantErrors.slice(0, 5),
      });
    }

    if (result.significantWarnings.length > 0) {
      result.issues.push({
        type: 'info',
        code: 'CONSOLE_WARNINGS',
        message: `${result.significantWarnings.length} console warning(s)`,
        detail: result.significantWarnings.slice(0, 3),
      });
    }

    // ── 4. NETWORK FAILURES ──────────────────────────────────────────────────
    const rawFailed = loadResult.failedRequests ?? [];

    // Separate noise from real failures
    const realFailures = rawFailed.filter((r) => !isNoise(r.url));
    const noiseFailures = rawFailed.filter((r) => isNoise(r.url));

    result.failedRequests = realFailures;
    result.blockedRequests = noiseFailures;

    // Critical = failures that affect core page functionality
    result.criticalFailures = realFailures.filter((r) => {
      const url = (r.url || '').toLowerCase();
      return (
        // JS bundles
        url.endsWith('.js') ||
        url.includes('/api/') ||
        url.includes('/graphql') ||
        url.includes('/rest/') ||
        // CSS that affects layout
        (url.endsWith('.css') && !url.includes('font')) ||
        // Fonts that would cause FOUT
        url.endsWith('.woff2') ||
        url.endsWith('.woff')
      );
    });

    if (result.criticalFailures.length > 0) {
      result.issues.push({
        type: 'critical',
        code: 'CRITICAL_NETWORK_FAILURES',
        message: `${result.criticalFailures.length} critical request(s) failed (JS/CSS/API)`,
        detail: result.criticalFailures.slice(0, 5).map((r) => ({
          url: r.url?.slice(0, 100),
          error: r.errorText,
        })),
      });
    } else if (result.failedRequests.length > 0) {
      result.issues.push({
        type: 'warning',
        code: 'NETWORK_FAILURES',
        message: `${result.failedRequests.length} non-critical request(s) failed`,
        detail: result.failedRequests.slice(0, 3).map((r) => ({
          url: r.url?.slice(0, 100),
          error: r.errorText,
        })),
      });
    }

    // ── SCORE CALCULATION ────────────────────────────────────────────────────
    let score = 100;

    if (!result.httpOk)                           score -= 50;
    if (result.blankScreen)                       score -= 40;
    if (result.criticalFailures.length > 0)       score -= Math.min(30, result.criticalFailures.length * 10);
    if (result.significantErrors.length >= 5)     score -= 20;
    else if (result.significantErrors.length > 0) score -= result.significantErrors.length * 3;
    if (result.failedRequests.length > 5)         score -= 10;
    if (result.significantWarnings.length > 3)    score -= 5;

    result.score = Math.max(0, score);

    // ── OVERALL STATUS ───────────────────────────────────────────────────────
    const criticalIssues = result.issues.filter((i) => i.type === 'critical');
    const warningIssues  = result.issues.filter((i) => i.type === 'warning');

    if (criticalIssues.length > 0)      result.overallStatus = 'critical';
    else if (warningIssues.length > 0)  result.overallStatus = 'warning';
    else                                result.overallStatus = 'healthy';

  } catch (err) {
    result.fatalError = err.message;
    result.overallStatus = 'critical';
    result.score = 0;
    result.issues.push({
      type: 'critical',
      code: 'AUDIT_FATAL',
      message: `Health check crashed: ${err.message}`,
    });
  }

  return result;
}

// ─── Page loader — sets up listeners BEFORE navigation ───────────────────────

/**
 * Opens a page, sets up all event listeners, navigates, then runs health check.
 * Call this from your auditor — it handles the full lifecycle.
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<HealthCheckResult>}
 */
async function auditPageHealth(context, url, timeout = 15_000) {
  const page = await context.newPage();

  // Collectors — must be registered before goto()
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error')   consoleErrors.push(text);
    if (msg.type() === 'warning') consoleWarnings.push(text);
  });

  page.on('pageerror', (err) => {
    // Uncaught exceptions — always significant
    consoleErrors.push(`[uncaught] ${err.message}`);
  });

  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url(),
      errorText: req.failure()?.errorText ?? 'unknown',
      resourceType: req.resourceType(),
    });
  });

  let httpStatus = null;
  let redirectedTo = null;

  try {
    const response = await page.goto(url, {
      waitUntil: 'load',       // ⚡ wait for full load, not just HTML — SPAs need this
      timeout,
    });

    httpStatus = response?.status() ?? null;
    redirectedTo = page.url();

    // ⚡ For React/Next.js/Vue sites — wait until body has real content (max 5s)
    // domcontentloaded pe inke pages khali hote hain, JS hydrate karta hai baad mein
    try {
      await page.waitForFunction(
        () => (document.body?.innerText?.trim().length ?? 0) > 100,
        { timeout: 5_000 },
      );
    } catch {
      // If still empty after 5s — genuine blank page, let the check report it
    }

    // Small extra wait for JS errors to bubble up after hydration
    await page.waitForTimeout(500);

    const result = await runBasicHealthCheck(page, url, {
      httpStatus,
      redirectedTo,
      consoleErrors,
      consoleWarnings,
      failedRequests,
    });

    return result;

  } catch (err) {
    // Navigation itself failed (timeout, DNS error, etc.)
    return {
      url,
      httpStatus: null,
      httpOk: false,
      blankScreen: true,
      blankScreenReason: `Navigation failed: ${err.message}`,
      consoleErrors,
      consoleWarnings,
      significantErrors: consoleErrors,
      significantWarnings: consoleWarnings,
      filteredNoise: [],
      failedRequests,
      blockedRequests: [],
      criticalFailures: failedRequests,
      overallStatus: 'critical',
      score: 0,
      issues: [{
        type: 'critical',
        code: 'NAVIGATION_FAILED',
        message: `Could not load page: ${err.message}`,
      }],
      fatalError: err.message,
    };
  } finally {
    await page.close();
  }
}

module.exports = { auditPageHealth, runBasicHealthCheck };