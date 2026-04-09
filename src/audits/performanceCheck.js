'use strict';

/**
 * performanceCheck.js — Layer 6 audit: Page Performance
 *
 * Uses Google PageSpeed Insights API directly.
 * Same data source as pagespeed.web.dev — no Playwright needed for this layer.
 *
 * Runs both DESKTOP and MOBILE strategies in parallel.
 *
 * Required env var:
 *   PSI_API_KEY — get one free at https://developers.google.com/speed/docs/insights/v5/get-started
 *   Without a key it still works but is rate-limited to ~2 requests/day.
 *
 * PSI API docs: https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed
 */

const https = require('https');
const PSI_HTTP_TIMEOUT_MS = Number(process.env.PSI_HTTP_TIMEOUT_MS || 45_000);
const PSI_MAX_RETRIES = Number(process.env.PSI_MAX_RETRIES || 2);
const PSI_TIMEOUT_RETRIES = Math.max(3, Number(process.env.PSI_TIMEOUT_RETRIES || 3));

// ─── Thresholds (Google CWV official) ────────────────────────────────────────

const THRESHOLDS = {
  fcp:  { good: 1800, needs: 3000 },
  lcp:  { good: 2500, needs: 4000 },
  cls:  { good: 0.1,  needs: 0.25 },
  tbt:  { good: 200,  needs: 600  },   // Total Blocking Time (PSI lab)
  si:   { good: 3400, needs: 5800 },   // Speed Index
  tti:  { good: 3800, needs: 7300 },   // Time to Interactive
  ttfb: { good: 800,  needs: 1800 },   // TTFB (field data)
};

// ─── Scoring weights (mirrors Lighthouse v11) ─────────────────────────────────

const WEIGHTS = {
  fcp: 10,
  lcp: 25,
  cls: 15,
  tbt: 30,   // TBT is the biggest signal in Lighthouse scoring
  si:  10,
  tti: 10,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rating(value, good, needs) {
  if (value == null) return null;
  if (value <= good)  return 'good';
  if (value <= needs) return 'needs-improvement';
  return 'poor';
}

function fmt(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// ─── PSI API call ─────────────────────────────────────────────────────────────

function fetchPSI(url, strategy, apiKey, attempt = 1) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      url,
      strategy,
      category: 'performance',
      ...(apiKey ? { key: apiKey } : {}),
    });

    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const msg = String(json.error.message || 'PSI API error');
            const timeoutLike = /timeout|timed out/i.test(msg);
            const retryable = /rate limit|quota|backend|timeout|temporar|unavailable|internal/i.test(msg);
            const retryBudget = timeoutLike ? PSI_TIMEOUT_RETRIES : PSI_MAX_RETRIES;
            if (retryable && attempt <= retryBudget) {
              const delay = 1000 * attempt;
              return setTimeout(() => {
                fetchPSI(url, strategy, apiKey, attempt + 1).then(resolve).catch(reject);
              }, delay);
            }
            reject(new Error(msg));
          } else {
            resolve(json);
          }
        } catch (e) {
          if (attempt <= PSI_MAX_RETRIES) {
            const delay = 1000 * attempt;
            return setTimeout(() => {
              fetchPSI(url, strategy, apiKey, attempt + 1).then(resolve).catch(reject);
            }, delay);
          }
          reject(new Error(`PSI response parse error: ${e.message}`));
        }
      });
    });

    req.setTimeout(PSI_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`PSI request timed out after ${PSI_HTTP_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      const msg = String(err?.message || err || 'PSI request failed');
      const timeoutLike = /timeout|timed out|etimedout/i.test(msg);
      const retryable = /timeout|timed out|reset|socket hang up|econnreset|etimedout|temporar|unavailable/i.test(msg);
      const retryBudget = timeoutLike ? PSI_TIMEOUT_RETRIES : PSI_MAX_RETRIES;
      if (retryable && attempt <= retryBudget) {
        const delay = 1000 * attempt;
        return setTimeout(() => {
          fetchPSI(url, strategy, apiKey, attempt + 1).then(resolve).catch(reject);
        }, delay);
      }
      reject(err);
    });
  });
}

// ─── Extract lab metrics from Lighthouse result ───────────────────────────────

function extractLabMetrics(lhr) {
  const audits = lhr.audits;

  const ms  = (key) => audits[key]?.numericValue ?? null;
  const val = (key) => audits[key]?.numericValue ?? null;

  return {
    fcp:          ms('first-contentful-paint'),
    lcp:          ms('largest-contentful-paint'),
    cls:          val('cumulative-layout-shift'),
    tbt:          ms('total-blocking-time'),
    si:           ms('speed-index'),
    tti:          ms('interactive'),
    ttfb:         ms('server-response-time'),
    // Lighthouse overall score (0-100)
    score:        Math.round((lhr.categories?.performance?.score ?? 0) * 100),
  };
}

// ─── Extract field data (CrUX) from PSI response ─────────────────────────────

function extractFieldData(psiJson) {
  const origin  = psiJson.originLoadingExperience;
  const page    = psiJson.loadingExperience;

  // Prefer page-level data, fall back to origin
  const data = (page?.metrics && Object.keys(page.metrics).length > 0) ? page : origin;

  if (!data?.metrics) return null;

  const m = data.metrics;

  return {
    overallCategory: data.overall_category ?? null,   // FAST / AVERAGE / SLOW
    fcp: {
      p75:      m.FIRST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      category: m.FIRST_CONTENTFUL_PAINT_MS?.category  ?? null,
    },
    lcp: {
      p75:      m.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      category: m.LARGEST_CONTENTFUL_PAINT_MS?.category  ?? null,
    },
    cls: {
      p75:      m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
                  ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
                  : null,
      category: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category ?? null,
    },
    inp: {
      p75:      m.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      category: m.INTERACTION_TO_NEXT_PAINT?.category  ?? null,
    },
    ttfb: {
      p75:      m.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile ?? null,
      category: m.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.category  ?? null,
    },
  };
}

// ─── Build issues list from lab metrics ──────────────────────────────────────

function buildIssues(lab, lhr) {
  const issues = [];
  const audits = lhr?.audits ?? {};

  const check = (key, metricKey, label, threshKey, poorLevel = 'critical') => {
    const val = lab[metricKey];
    const t   = THRESHOLDS[threshKey ?? metricKey];
    if (val == null || !t) return;
    const r = rating(val, t.good, t.needs);
    if (r === 'needs-improvement') issues.push({ type: 'warning',  code: `${key}_NEEDS_IMPROVEMENT`, message: `${label} is ${fmt(val)} — aim for under ${fmt(t.good)}` });
    if (r === 'poor')              issues.push({ type: poorLevel, code: `${key}_POOR`,              message: `${label} is ${fmt(val)} — exceeds poor threshold of ${fmt(t.needs)}` });
  };

  check('FCP',  'fcp',  'First Contentful Paint',   'fcp');
  check('LCP',  'lcp',  'Largest Contentful Paint',  'lcp');
  check('CLS',  'cls',  'Cumulative Layout Shift',   'cls');
  check('TBT',  'tbt',  'Total Blocking Time',       'tbt');
  // SI/TTI are useful diagnostics but noisy on PSI lab runs. Keep them warning-level
  // when poor so they don't override an otherwise strong score.
  check('SI',   'si',   'Speed Index',               'si',  'warning');
  check('TTI',  'tti',  'Time to Interactive',       'tti', 'warning');
  check('TTFB', 'ttfb', 'Server Response Time',      'ttfb');

  // Pull top opportunities from Lighthouse
  const opportunities = [
    'render-blocking-resources',
    'unused-javascript',
    'unused-css-rules',
    'uses-optimized-images',
    'uses-webp-images',
    'uses-responsive-images',
    'efficient-animated-content',
    'uses-text-compression',
    'uses-long-cache-ttl',
    'unminified-javascript',
    'unminified-css',
  ];

  for (const id of opportunities) {
    const audit = audits[id];
    if (!audit || audit.score == null) continue;
    if (audit.score >= 0.9) continue; // passing — skip

    const savingsMs = Number(audit.details?.overallSavingsMs || 0);
    const savings = savingsMs
      ? ` (~${fmt(savingsMs)} savings)`
      : '';

    // Opportunities should be severity-driven by expected user impact, not
    // raw audit score alone (which can be strict even for tiny savings).
    let level = 'info';
    if (savingsMs >= 1000) level = 'critical';
    else if (savingsMs >= 250) level = 'warning';

    issues.push({
      type:    level,
      code:    id.toUpperCase().replace(/-/g, '_'),
      message: `${audit.title}${savings}`,
    });
  }

  return issues;
}

// ─── Audit one strategy ───────────────────────────────────────────────────────

async function auditStrategy(url, strategy, apiKey) {
  const label    = strategy === 'MOBILE' ? 'Mobile' : 'Desktop';
  const viewport = strategy === 'MOBILE' ? '375×812' : '1440×900';

  let psiJson;
  try {
    psiJson = await fetchPSI(url, strategy, apiKey);
  } catch (err) {
    return {
      device: strategy.toLowerCase(), label, viewport,
      overallStatus: 'critical', score: 0,
      issues: [{ type: 'critical', code: 'PSI_API_ERROR', message: err.message }],
      lab: null, field: null,
    };
  }

  const lhr        = psiJson.lighthouseResult;
  const lab        = extractLabMetrics(lhr);
  const field      = extractFieldData(psiJson);
  const issues     = buildIssues(lab, lhr);
  const criticals  = issues.filter(i => i.type === 'critical');
  const warnings   = issues.filter(i => i.type === 'warning');

  return {
    device:        strategy.toLowerCase(),
    label,
    viewport,
    overallStatus: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
    score:         lab.score,
    lab: {
      fcp:       lab.fcp  != null ? Math.round(lab.fcp)  : null,
      fcpRating: rating(lab.fcp,  THRESHOLDS.fcp.good,  THRESHOLDS.fcp.needs),
      lcp:       lab.lcp  != null ? Math.round(lab.lcp)  : null,
      lcpRating: rating(lab.lcp,  THRESHOLDS.lcp.good,  THRESHOLDS.lcp.needs),
      cls:       lab.cls  != null ? parseFloat(lab.cls.toFixed(3)) : null,
      clsRating: rating(lab.cls,  THRESHOLDS.cls.good,  THRESHOLDS.cls.needs),
      tbt:       lab.tbt  != null ? Math.round(lab.tbt)  : null,
      tbtRating: rating(lab.tbt,  THRESHOLDS.tbt.good,  THRESHOLDS.tbt.needs),
      si:        lab.si   != null ? Math.round(lab.si)   : null,
      siRating:  rating(lab.si,   THRESHOLDS.si.good,   THRESHOLDS.si.needs),
      tti:       lab.tti  != null ? Math.round(lab.tti)  : null,
      ttiRating: rating(lab.tti,  THRESHOLDS.tti.good,  THRESHOLDS.tti.needs),
      ttfb:      lab.ttfb != null ? Math.round(lab.ttfb) : null,
    },
    field,
    issues,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @returns {Promise<{ url, desktop, mobile }>}
 *
 * Note: context param kept for API compatibility with other audit layers
 * but is not used here — PSI API handles everything.
 */
async function auditPerformance(_context, url) {
  const apiKey = process.env.PSI_API_KEY ?? null;

  if (!apiKey) {
    console.warn('[perf] PSI_API_KEY not set — running without key (heavily rate-limited). Get a free key at https://developers.google.com/speed/docs/insights/v5/get-started');
  }

  // Run both strategies in parallel
  const [desktop, mobile] = await Promise.all([
    auditStrategy(url, 'DESKTOP', apiKey),
    auditStrategy(url, 'MOBILE',  apiKey),
  ]);

  return { url, desktop, mobile };
}

module.exports = { auditPerformance };