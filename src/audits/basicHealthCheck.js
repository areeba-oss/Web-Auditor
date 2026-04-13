'use strict';

/**
 * basicHealthCheck.js — Layer 1 audit: Page Load & Basic Health
 *
 * RAW MODE — no noise filtering, no bot detection, no tracker exclusions.
 * Collects and reports everything exactly as the browser sees it.
 *
 * Checks:
 *   1. HTTP status (200 OK?)
 *   2. Blank screen / broken layout detection
 *   3. Console errors & warnings (JS errors) — ALL, unfiltered
 *   4. Network failures (failed/blocked requests) — ALL, unfiltered
 *
 * Returns a structured rule-based result for layer-1 health.
 */

const BLANK_SCREEN_CHECKS = {
  minBodyText: 100,      // less than this = likely blank
  minVisibleElements: 3, // less than this = broken layout
};

const POST_LOAD_OBSERVE_MS = Number(process.env.HEALTH_POST_LOAD_OBSERVE_MS || 500);
const NETWORKIDLE_WAIT_MS = Number(process.env.HEALTH_NETWORKIDLE_TIMEOUT_MS || 15_000);
const EVAL_TIMEOUT_MS = Number(process.env.HEALTH_EVAL_TIMEOUT_MS || 12_000);
const HEALTH_TOTAL_GUARD_MS = Number(process.env.HEALTH_TOTAL_GUARD_MS || 25_000);

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function safeClosePage(page) {
  if (!page) return;
  try {
    await withTimeout(page.close(), 5_000, 'page-close');
  } catch {
    // Ignore close hangs so one problematic page cannot stall the full audit.
  }
}

function stripQueryAndHash(url = '') {
  return String(url || '').split('#')[0].split('?')[0].toLowerCase();
}

// ─── Main audit function ──────────────────────────────────────────────────────

/**
 * @param {import('playwright-core').Page} page  — already loaded Playwright page
 * @param {string} url                           — page URL
 * @param {object} loadResult                    — { httpStatus, redirectedTo, consoleErrors, consoleWarnings, failedRequests }
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
    errorPageSignals: [],

    // ── 3. Console Errors/Warnings (RAW — no filtering) ─────────
    consoleErrors: [],
    consoleWarnings: [],
    rawConsoleErrorCount: 0,
    rawConsoleWarningCount: 0,
    significantErrors: [],
    significantWarnings: [],

    // ── 4. Network Failures (RAW — no filtering) ────────────────
    failedRequests: [],
    criticalFailures: [],        // failures that likely affect page function

    // ── Summary ─────────────────────────────────────────────────
    overallStatus: 'healthy',    // healthy | warning | critical
    issues: [],
    score: 100,
  };

  try {

    // ── 1. HTTP STATUS ──────────────────────────────────────────────────────
    result.httpOk = result.httpStatus == null || (result.httpStatus >= 200 && result.httpStatus < 400);
    result.wasRedirected = !!(result.redirectedTo && result.redirectedTo !== url);

    if (result.httpStatus == null) {
      result.issues.push({
        type: 'warning',
        code: 'HTTP_STATUS_UNKNOWN',
        message: 'Could not resolve final HTTP status code, but page rendered enough DOM for analysis',
      });
    } else if (!result.httpOk) {
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
    const domData = await withTimeout(page.evaluate(() => {
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

      const title = document.title?.trim() ?? '';
      const hasTitle = title.length > 0 && title.toLowerCase() !== 'untitled';

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
    }), EVAL_TIMEOUT_MS, 'health-dom-evaluate');

    result.bodyTextLength = domData.bodyTextLength;
    result.visibleElementCount = domData.visibleElementCount;
    result.pageTitle = domData.title;
    const hasMeaningfulTitle = !!domData.hasTitle;

    result.errorPageSignals = domData.errorPageSignals;

    if (domData.bodyTextLength < BLANK_SCREEN_CHECKS.minBodyText && domData.visibleElementCount < BLANK_SCREEN_CHECKS.minVisibleElements && !hasMeaningfulTitle) {
      result.blankScreen = true;
      result.blankScreenReason = `Body text only ${domData.bodyTextLength} chars (min: ${BLANK_SCREEN_CHECKS.minBodyText}) — page likely not hydrated or empty`;
    } else if (domData.visibleElementCount < BLANK_SCREEN_CHECKS.minVisibleElements) {
      result.blankScreen = true;
      result.blankScreenReason = `Only ${domData.visibleElementCount} visible elements found — layout likely broken`;
    }

    if (result.blankScreen) {
      result.issues.push({
        type: 'critical',
        code: 'BLANK_SCREEN',
        message: result.blankScreenReason,
      });
    }

    if (domData.errorPageSignals.length > 0) {
      result.issues.push({
        type: 'warning',
        code: 'ERROR_PAGE_CONTENT',
        message: `Error page content detected: "${domData.errorPageSignals[0]}"`,
      });
    }

    // ── 3. CONSOLE ERRORS & WARNINGS (RAW — no filtering applied) ───────────
    const rawErrors   = loadResult.consoleErrors   ?? [];
    const rawWarnings = loadResult.consoleWarnings ?? [];

    result.consoleErrors          = rawErrors;
    result.consoleWarnings        = rawWarnings;
    result.rawConsoleErrorCount   = rawErrors.length;
    result.rawConsoleWarningCount = rawWarnings.length;
    result.significantErrors      = [...rawErrors];
    result.significantWarnings    = [...rawWarnings];

    if (result.significantErrors.length > 0) {
      result.issues.push({
        type: result.significantErrors.length >= 5 ? 'critical' : 'warning',
        code: 'CONSOLE_ERRORS',
        message: `${result.significantErrors.length} JS error(s) detected`,
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

    // ── 4. NETWORK FAILURES (RAW — no filtering applied) ────────────────────
    // All failed requests passed in directly — nothing stripped
    const allFailures = loadResult.failedRequests ?? [];
    result.failedRequests = allFailures;

    // Critical = failures that likely affect core page functionality
    result.criticalFailures = allFailures.filter((r) => {
      const url = stripQueryAndHash(r.url || '');
      return (
        url.endsWith('.js') ||
        url.includes('/api/') ||
        url.includes('/graphql') ||
        url.includes('/rest/') ||
        (url.endsWith('.css') && !url.includes('font')) ||
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
        message: `${result.failedRequests.length} request(s) failed`,
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
 * RAW MODE: captures everything — no tracker filtering, no bot detection.
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} url
 * @param {number} timeout
 * @returns {Promise<HealthCheckResult>}
 */
async function auditPageHealth(context, url, timeout = 15_000) {
  const page = await context.newPage();

  // Collectors — must be registered before goto()
  const consoleEvents        = [];
  const failedRequestEvents  = [];
  const failedResponseEvents = [];

  // ── Console: capture ALL types (error, warning, log, info, etc.) ──────────
  page.on('console', (msg) => {
    const text = msg.text();
    const t    = msg.type();
    consoleEvents.push({
      ts:   Date.now(),
      type: t === 'assert' ? 'error' : t,
      text,
    });
  });

  // ── Uncaught exceptions — always significant ───────────────────────────────
  page.on('pageerror', (err) => {
    consoleEvents.push({
      ts:   Date.now(),
      type: 'error',
      text: `[uncaught] ${err.message}`,
    });
  });

  // ── Transport-level failures (DNS, connection refused, SSL, CORS abort) ───
  page.on('requestfailed', (req) => {
    failedRequestEvents.push({
      ts:           Date.now(),
      url:          req.url(),
      errorText:    req.failure()?.errorText ?? 'unknown',
      resourceType: req.resourceType(),
      method:       req.method(),
    });
  });

  // ── HTTP-level failures (4xx / 5xx responses) ─────────────────────────────
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      const req = res.request();
      failedResponseEvents.push({
        ts:           Date.now(),
        url:          res.url(),
        status,
        statusText:   res.statusText(),
        method:       req.method(),
        resourceType: req.resourceType(),
      });
    }
  });

  let httpStatus   = null;
  let redirectedTo = null;
  let navError     = null;
  let didNavigate  = false;

  try {
    const observeStartTs = Date.now();

    try {
      const response = await withTimeout(page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      }), timeout + 2_000, 'page-goto');

      httpStatus   = response?.status() ?? null;
      redirectedTo = page.url();
      didNavigate  = true;
    } catch (err) {
      navError = err;
      redirectedTo = page.url();
    }

    // Salvage mode: some bot-protected/slow sites throw navigation timeout,
    // but meaningful DOM still renders. Do not hard-fail in that case.
    if (!didNavigate) {
      const salvage = await withTimeout(page.evaluate(() => {
        const bodyText = document.body?.innerText?.trim() ?? '';
        const hasMeaningfulDom = bodyText.length > 80 || document.querySelectorAll('header, footer, main, section, article, nav').length > 0;
        return {
          hasMeaningfulDom,
          readyState: document.readyState,
          title: document.title || '',
        };
      }), EVAL_TIMEOUT_MS, 'health-salvage-evaluate').catch(() => ({ hasMeaningfulDom: false, readyState: 'unknown', title: '' }));

      const hasRealNavigatedUrl = !!(redirectedTo && !/^about:blank/i.test(redirectedTo));

      if (salvage.hasMeaningfulDom || hasRealNavigatedUrl) {
        didNavigate = true;
      } else {
        throw navError || new Error('Navigation failed before DOM was rendered');
      }
    }

    // Wait for network idle so async data fetches settle (React/Next/Vue)
    try {
      await withTimeout(
        page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_WAIT_MS }),
        NETWORKIDLE_WAIT_MS + 2_000,
        'wait-networkidle',
      );
    } catch {
      // Long-polling / streaming pages may never go idle — continue anyway
    }

    // Additional observation window to catch late-firing errors
    await page.waitForTimeout(POST_LOAD_OBSERVE_MS);

    // ── Slice events to post-navigation window only ──────────────────────────
    const postLoadConsole        = consoleEvents.filter((e) => e.ts >= observeStartTs);
    const postLoadFailedRequests = failedRequestEvents.filter((e) => e.ts >= observeStartTs);
    const postLoadFailedResponses = failedResponseEvents.filter((e) => e.ts >= observeStartTs);

    // ── RAW console — no noise filtering ────────────────────────────────────
    const consoleErrors   = postLoadConsole.filter((e) => e.type === 'error').map((e) => e.text);
    const consoleWarnings = postLoadConsole.filter((e) => e.type === 'warning').map((e) => e.text);

    // ── Merge transport + HTTP failures, deduplicate on url+resourceType ─────
    const transportFailedRequests = postLoadFailedRequests.map(({ ts, ...rest }) => ({
      ...rest,
      source: 'requestfailed',
    }));
    const httpFailedRequests = postLoadFailedResponses.map(({ ts, ...rest }) => ({
      url:          rest.url,
      errorText:    `HTTP ${rest.status}${rest.statusText ? ` ${rest.statusText}` : ''}`,
      resourceType: rest.resourceType,
      status:       rest.status,
      method:       rest.method,
      source:       'http-response',
    }));

    const dedupe = new Set();
    // RAW — keep ALL failures, just deduplicate same request appearing in both event types
    const failedRequests = [...transportFailedRequests, ...httpFailedRequests].filter((r) => {
      const key = `${r.url}|${r.resourceType || ''}`;
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    });

    return await withTimeout(runBasicHealthCheck(page, url, {
      httpStatus,
      redirectedTo,
      consoleErrors,
      consoleWarnings,
      failedRequests,   // raw, unfiltered
    }), HEALTH_TOTAL_GUARD_MS, 'runBasicHealthCheck');

  } catch (err) {
    // Navigation itself failed (timeout, DNS error, etc.)
    return {
      url,
      httpStatus:        null,
      httpOk:            false,
      blankScreen:       true,
      blankScreenReason: `Navigation failed: ${err.message}`,
      consoleErrors:     consoleEvents.filter((e) => e.type === 'error').map((e) => e.text),
      consoleWarnings:   consoleEvents.filter((e) => e.type === 'warning').map((e) => e.text),
      significantErrors: consoleEvents.filter((e) => e.type === 'error').map((e) => e.text),
      significantWarnings: consoleEvents.filter((e) => e.type === 'warning').map((e) => e.text),
      failedRequests:    failedRequestEvents.map(({ ts, ...rest }) => rest),
      criticalFailures:  failedRequestEvents.map(({ ts, ...rest }) => rest),
      overallStatus:     'critical',
      score:             0,
      issues: [{
        type:    'critical',
        code:    'NAVIGATION_FAILED',
        message: `Could not load page: ${err.message}`,
      }],
      fatalError: err.message,
    };
  } finally {
    await safeClosePage(page);
  }
}

module.exports = { auditPageHealth, runBasicHealthCheck };