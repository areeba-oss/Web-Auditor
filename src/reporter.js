'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Formatters & Graders ─────────────────────────────────────────────────────

function msToSeconds(ms) { return ms != null ? (ms / 1000).toFixed(2) + 's' : null; }
function fmtCls(v)       { return v != null ? v.toFixed(3) : null; }

function fcpGrade(ms) {
  if (!ms) return null;
  if (ms < 1800) return { label: 'Fast',     color: '#16a34a' };
  if (ms < 3000) return { label: 'Moderate', color: '#b45309' };
  return               { label: 'Slow',     color: '#dc2626' };
}
function lcpGrade(ms) {
  if (!ms) return null;
  if (ms < 2500) return { label: 'Fast',     color: '#16a34a' };
  if (ms < 4000) return { label: 'Moderate', color: '#b45309' };
  return               { label: 'Slow',     color: '#dc2626' };
}
function tbtGrade(ms) {
  if (!ms) return null;
  if (ms < 200)  return { label: 'Excellent', color: '#16a34a' };
  if (ms < 600)  return { label: 'Moderate',  color: '#b45309' };
  return               { label: 'Poor',      color: '#dc2626' };
}
function clsGrade(v) {
  if (v == null) return null;
  if (v < 0.1)  return { label: 'Good',      color: '#16a34a' };
  if (v < 0.25) return { label: 'Moderate',  color: '#b45309' };
  return              { label: 'Poor',      color: '#dc2626' };
}
function ttfbGrade(ms) {
  if (!ms) return null;
  if (ms < 200)  return { label: 'Excellent',   color: '#16a34a' };
  if (ms < 500)  return { label: 'Acceptable',  color: '#b45309' };
  return               { label: 'Slow',        color: '#dc2626' };
}
function mobileGrade(responsive, hasScroll) {
  if (responsive && !hasScroll) return { label: 'Fully Responsive',  color: '#16a34a', score: 100 };
  if (!responsive && hasScroll)  return { label: 'Not Mobile-Ready', color: '#dc2626', score: 20  };
  return                                { label: 'Partial',          color: '#b45309', score: 60  };
}
function navHealthLabel(h) {
  if (h === 'good')   return { label: 'All Links Working',     color: '#16a34a' };
  if (h === 'issues') return { label: 'Minor Issues Found',    color: '#b45309' };
  return                     { label: 'Broken Links Detected', color: '#dc2626' };
}
function gradeFromScore(s) {
  if (s >= 90) return { grade: 'A', label: 'Excellent',       color: '#16a34a' };
  if (s >= 75) return { grade: 'B', label: 'Good',            color: '#65a30d' };
  if (s >= 60) return { grade: 'C', label: 'Fair',            color: '#b45309' };
  if (s >= 40) return { grade: 'D', label: 'Poor',            color: '#ea580c' };
  return              { grade: 'F', label: 'Critical Issues', color: '#dc2626' };
}

// ─── Score interpolation ──────────────────────────────────────────────────────

function interpolateScore(value, bp) {
  if (value == null || isNaN(value)) return null;
  if (value <= bp[0][0])             return bp[0][1];
  if (value >= bp[bp.length - 1][0]) return bp[bp.length - 1][1];
  for (let i = 1; i < bp.length; i++) {
    if (value <= bp[i][0]) {
      const [t0, s0] = bp[i - 1], [t1, s1] = bp[i];
      return Math.round(s0 + ((s1 - s0) * (value - t0)) / (t1 - t0));
    }
  }
  return bp[bp.length - 1][1];
}

// ─── Scoring curves ───────────────────────────────────────────────────────────
// Performance: FCP, LCP, TTFB, TBT, SI (PSI/CWV based — replaces old loadTime/dcl/pageWeight)
// Health/Nav:  unchanged

const CURVES = {
  // Core Web Vitals / PSI lab metrics
  fcp:  [[0,100],[500,98],[800,92],[1000,82],[1200,72],[1500,58],[1800,45],[2500,25],[3500,8],[5000,0]],
  lcp:  [[0,100],[500,98],[1000,92],[1500,82],[2000,68],[2500,50],[3000,35],[4000,15],[5000,0]],
  ttfb: [[0,100],[80,97],[150,90],[250,75],[350,55],[500,32],[700,15],[1000,5],[2000,0]],
  tbt:  [[0,100],[100,95],[200,85],[300,72],[400,58],[600,38],[800,20],[1000,8],[2000,0]],
  si:   [[0,100],[1000,95],[2000,82],[3400,60],[4500,40],[5800,20],[8000,5],[12000,0]],
  cls:  [[0,100],[0.05,92],[0.1,72],[0.15,52],[0.25,25],[0.4,8],[0.6,0]],

  // Health
  failedRequests: [[0,100],[1,90],[3,72],[6,52],[10,32],[18,15],[30,5],[50,0]],
  consoleErrors:  [[0,100],[1,72],[3,45],[5,25],[10,8],[20,0]],

  // Navigation
  navIssues: [[0,100],[1,78],[3,52],[5,30],[10,10],[20,0]],
};

// ─── Category score computation ───────────────────────────────────────────────
//
// Speed     — FCP 35% · LCP 25% · TTFB 25% · TBT 15%
//             (replaces old FCP/TTFB/loadTime/DCL — no loadTime or DCL in PSI)
//
// Resources — SI (desktop) 40% · SI (mobile) 30% · mobile-vs-desktop delta 30%
//             (replaces old pageWeight/resourceCount/slowImages — no resource data in PSI)
//
// Health, Mobile, Navigation, Layout — unchanged

function computeCategoryScores(h, p, l, n) {
  // ── Health ──
  const healthCat = Math.round(
    (h.httpOk ? 100 : 0)                                                            * 0.30 +
    (interpolateScore(h.significantErrorCount ?? 0, CURVES.consoleErrors)  ?? 100)  * 0.20 +
    (interpolateScore(h.failedRequestCount    ?? 0, CURVES.failedRequests) ?? 100)  * 0.25 +
    ((h.criticalFailedCount ?? 0) > 0 ? 0 : 100)                                   * 0.15 +
    (h.blankScreen ? 0 : 100)                                                       * 0.10,
  );

  // ── Speed (PSI lab — desktop primary) ──
  const speedCat = Math.round(
    (interpolateScore(p.fcp,  CURVES.fcp)  ?? 50) * 0.35 +
    (interpolateScore(p.lcp,  CURVES.lcp)  ?? 50) * 0.25 +
    (interpolateScore(p.ttfb, CURVES.ttfb) ?? 50) * 0.25 +
    (interpolateScore(p.tbt,  CURVES.tbt)  ?? 50) * 0.15,
  );

  // ── Resources (derived from PSI Speed Index + mobile penalty) ──
  const siDesktopScore  = interpolateScore(p.siDesktop,  CURVES.si) ?? 80;
  const siMobileScore   = interpolateScore(p.siMobile,   CURVES.si) ?? 80;
  // Mobile vs desktop score delta: if mobile much worse → resource/JS issue
  const deltaScore      = p.desktopScore != null && p.mobileScore != null
    ? Math.max(0, 100 - Math.max(0, p.desktopScore - p.mobileScore) * 1.5)
    : 80;
  const resourcesCat = Math.round(siDesktopScore * 0.40 + siMobileScore * 0.30 + deltaScore * 0.30);

  // ── Mobile ──
  const resp      = l.responsiveness ?? {};
  const mobileCat = Math.round(
    (resp.mobile?.responsive && !resp.mobile?.hasHorizontalScroll ? 100 : 0) * 0.55 +
    (resp.tablet?.responsive  ?? false ? 100 : 0)                            * 0.30 +
    (resp.desktop?.responsive ?? true  ? 100 : 0)                            * 0.15,
  );

  // ── Navigation ──
  const navHealthScore  = n.navHealth === 'good' ? 100 : n.navHealth === 'issues' ? 55 : 15;
  const brokenPenalty   = n.brokenCount === 0 ? 100 : Math.max(0, 100 - n.brokenCount * 25);
  const navIssueScore   = interpolateScore(n.issueCount ?? 0, CURVES.navIssues) ?? 100;
  const navigationCat   = Math.round(navHealthScore * 0.40 + brokenPenalty * 0.35 + navIssueScore * 0.25);

  // ── Layout ──
  let layoutCat = 0;
  if (l.headerVisible)  layoutCat += 22;
  if (l.footerVisible)  layoutCat += 18;
  if (l.logoDetected)   layoutCat += 12;
  if (l.logoLinksHome)  layoutCat += 5;
  if (l.mainCTAVisible) layoutCat += 18;
  layoutCat += Math.min(15, (l.ctaCount ?? 0) * 5);
  if (l.headerVisible && l.footerVisible) layoutCat += 10;
  layoutCat = Math.min(100, layoutCat);

  const overall = Math.round(
    healthCat    * 0.15 +
    speedCat     * 0.30 +
    resourcesCat * 0.15 +
    mobileCat    * 0.15 +
    navigationCat * 0.10 +
    layoutCat    * 0.15,
  );

  return { overall, categories: { health: healthCat, speed: speedCat, resources: resourcesCat, mobile: mobileCat, navigation: navigationCat, layout: layoutCat } };
}

// ─── Build a normalised metric object ─────────────────────────────────────────

function metric(ms, gradeFn) {
  return { ms: ms ?? null, formatted: msToSeconds(ms), grade: gradeFn ? gradeFn(ms) : undefined };
}

// ─── transformPage ────────────────────────────────────────────────────────────

function transformPage(raw) {
  const url  = raw.url;
  const slug = (() => { try { return new URL(url).pathname || '/'; } catch { return '/'; } })();

  const hRaw = raw.health     ?? {};
  const uRaw = raw.ui         ?? {};
  const nRaw = raw.navigation ?? {};
  const fRaw = raw.forms      ?? {};
  const pRaw = raw.performance ?? {};

  // ── Health ──────────────────────────────────────────────────────────────────
  const health = {
    status:                   hRaw.httpStatus    ?? null,
    ok:                       hRaw.httpOk        ?? false,
    blankScreen:              hRaw.blankScreen   ?? false,
    significantErrors:        (hRaw.significantErrors  ?? []).length,
    failedRequests:           (hRaw.failedRequests     ?? []).length,
    criticalFailures:         (hRaw.criticalFailures   ?? []).length,
    significantErrorMessages: (hRaw.significantErrors  ?? []).slice(0, 5),
  };

  // ── Performance (PSI — desktop + mobile) ─────────────────────────────────
  //
  // New structure: pRaw.desktop.lab / pRaw.mobile.lab
  //   fcp, lcp, cls, tbt, si, tti, ttfb  (all lab values from Lighthouse via PSI)
  //   pRaw.desktop.score / pRaw.mobile.score  (0–100 PSI score)
  //
  // Desktop is the primary reference for speed scoring; both are shown in report.

  const dLab = pRaw.desktop?.lab ?? {};
  const mLab = pRaw.mobile?.lab  ?? {};

  // Primary (desktop) values used for scoring and headline metrics
  const fcpMs  = dLab.fcp  ?? null;
  const lcpMs  = dLab.lcp  ?? null;
  const ttfbMs = dLab.ttfb ?? null;
  const tbtMs  = dLab.tbt  ?? null;
  const clsVal = dLab.cls  ?? null;
  const siDesktop = dLab.si ?? null;
  const siMobile  = mLab.si ?? null;

  const desktopScore = pRaw.desktop?.score ?? null;
  const mobileScore  = pRaw.mobile?.score  ?? null;

  // Helper to build a per-strategy metrics snapshot
  const buildStrategyMetrics = (lab, score) => ({
    score,
    firstContentfulPaint:    { ...metric(lab.fcp,  fcpGrade),  rating: lab.fcpRating  ?? null },
    largestContentfulPaint:  { ...metric(lab.lcp,  lcpGrade),  rating: lab.lcpRating  ?? null },
    timeToFirstByte:         { ...metric(lab.ttfb, ttfbGrade)                                },
    totalBlockingTime:       { ...metric(lab.tbt,  tbtGrade),  rating: lab.tbtRating  ?? null },
    cumulativeLayoutShift:   { value: lab.cls ?? null, formatted: fmtCls(lab.cls), grade: clsGrade(lab.cls), rating: lab.clsRating ?? null },
    speedIndex:              { ...metric(lab.si,   null),       rating: lab.siRating   ?? null },
    timeToInteractive:       { ...metric(lab.tti,  null),       rating: lab.ttiRating  ?? null },
  });

  const performance = {
    // Per-strategy breakdown (full data for detailed views)
    desktop: buildStrategyMetrics(dLab, desktopScore),
    mobile:  buildStrategyMetrics(mLab, mobileScore),

    // Convenience top-level fields (desktop values — kept for backward compat with report consumers)
    firstContentfulPaint:   { ...metric(fcpMs,  fcpGrade),  rating: dLab.fcpRating  ?? null },
    largestContentfulPaint: { ...metric(lcpMs,  lcpGrade),  rating: dLab.lcpRating  ?? null },
    timeToFirstByte:        { ...metric(ttfbMs, ttfbGrade)                                  },
    totalBlockingTime:      { ...metric(tbtMs,  tbtGrade),  rating: dLab.tbtRating  ?? null },
    cumulativeLayoutShift:  { value: clsVal, formatted: fmtCls(clsVal), grade: clsGrade(clsVal), rating: dLab.clsRating ?? null },

    // Fields that no longer exist in PSI — kept as null so consumers don't crash
    domContentLoaded: { ms: null, formatted: null },
    totalLoadTime:    { ms: null, formatted: null, grade: null },
    slowResources:    [],
    largeImages:      [],
    totalResources:   null,
    totalResourceSizeKB: null,
  };

  // ── UI — extract from details + breakpoints ──────────────────────────────
  const uDetails = uRaw.details ?? {};

  // Breakpoint overflow map (same structure as before)
  const bpMap = {};
  (uRaw.breakpointResults ?? []).forEach(bp => { bpMap[bp.breakpoint] = bp; });
  const mobileOF  = bpMap.mobile?.domOverflow  ?? false;
  const tabletOF  = bpMap.tablet?.domOverflow  ?? false;
  const desktopOF = bpMap.desktop?.domOverflow ?? false;

  // Header / Footer — per-breakpoint, prefer desktop
  const dHeader = uDetails.header?.desktop ?? uDetails.header?.tablet ?? uDetails.header?.mobile ?? {};
  const dFooter = uDetails.footer?.desktop ?? uDetails.footer?.tablet ?? uDetails.footer?.mobile ?? {};

  // CTA — now always per-breakpoint { found, count, examples }
  const dCTA = uDetails.cta?.desktop ?? uDetails.cta?.tablet ?? uDetails.cta?.mobile ?? {};

  // Logo — flat object { visible, linksToHome, appearsClickable, ... }
  const logo = uDetails.logo ?? {};

  const layout = {
    headerFound:    dHeader.visible ?? false,
    headerVisible:  dHeader.visible ?? false,
    footerFound:    dFooter.visible ?? false,
    footerVisible:  dFooter.visible ?? false,
    logoDetected:   logo.visible    ?? false,
    logoVisible:    logo.visible    ?? false,
    logoLinksHome:  logo.linksToHome ?? false,
    mainCTAVisible: dCTA.found  ?? false,
    ctaCount:       dCTA.count  ?? 0,
    ctaTexts:       (dCTA.examples ?? []).slice(0, 6),
    responsiveness: {
      mobile:  { responsive: !mobileOF,  hasHorizontalScroll: mobileOF,  details: { responsive: !mobileOF,  hasHorizontalScroll: mobileOF  } },
      tablet:  { responsive: !tabletOF,  hasHorizontalScroll: tabletOF,  details: { responsive: !tabletOF,  hasHorizontalScroll: tabletOF  } },
      desktop: { responsive: !desktopOF, hasHorizontalScroll: desktopOF, details: { responsive: !desktopOF, hasHorizontalScroll: desktopOF } },
    },
  };

  const responsiveness = {
    mobile:  { ...mobileGrade(!mobileOF, mobileOF), details: { responsive: !mobileOF, hasHorizontalScroll: mobileOF  } },
    tablet:  { label: !tabletOF ? 'Responsive' : 'Issues', color: !tabletOF ? '#16a34a' : '#dc2626', details: { responsive: !tabletOF } },
    desktop: { label: 'Responsive', color: '#16a34a', details: { responsive: true } },
  };

  // ── Navigation ─────────────────────────────────────────────────────────────
  //
  // DEDUPLICATION RULE:
  //   nav + footer = site-wide elements (same on every page).
  //   We report their broken count per page for the page breakdown, but
  //   buildSummary deduplicates by URL across pages for the site total.
  //
  //   internal + external = page-specific content links → count as-is.

  const nSummary = nRaw.summary ?? {};
  const nDetails = nRaw.details ?? {};
  const nIssues  = (nRaw.issues ?? []).filter(i => i.type !== 'info');

  // Bot-blocked codes are not truly broken for real users
  const BOT_BLOCKED = new Set([401, 403, 429]);
  const isBrokenLink = (l) =>
    l._broken ||
    (!l.ok && l.status !== 'timeout' && !BOT_BLOCKED.has(Number(l.status)));

  // Broken links — internal + external only (nav/footer deduplicated at summary level)
  const contentBrokenLinks = [];
  ['internal', 'external'].forEach(region => {
    (nDetails[region] ?? []).filter(isBrokenLink).forEach(l => {
      contentBrokenLinks.push({ url: l.url ?? l.href, status: l.status, region });
    });
  });

  // Nav + footer broken (kept separate so summary can deduplicate)
  const navBrokenLinks    = (nDetails.nav    ?? []).filter(isBrokenLink).map(l => ({ url: l.url ?? l.href, status: l.status, region: 'nav'    }));
  const footerBrokenLinks = (nDetails.footer ?? []).filter(isBrokenLink).map(l => ({ url: l.url ?? l.href, status: l.status, region: 'footer' }));

  // All broken (for per-page findings — shows everything on this page)
  const allBrokenLinks = [...navBrokenLinks, ...footerBrokenLinks, ...contentBrokenLinks];

  const totalLinks   = (nSummary.nav?.total ?? 0) + (nSummary.internal?.total ?? 0) + (nSummary.external?.total ?? 0) + (nSummary.footer?.total ?? 0);
  const navHealthStr = allBrokenLinks.length > 3 ? 'broken' : allBrokenLinks.length > 0 ? 'issues' : 'good';

  const navigation = {
    health:      navHealthLabel(navHealthStr),
    severity:    allBrokenLinks.length > 3 ? 'high' : allBrokenLinks.length > 0 ? 'medium' : 'low',
    totalLinks,
    internalLinks:     (nSummary.internal?.total ?? 0) + (nSummary.footer?.total ?? 0),
    externalLinks:     nSummary.external?.total ?? 0,
    // Broken split: content-only for per-page score; full list for display
    brokenLinks:       allBrokenLinks,          // all broken on this page (display)
    contentBrokenLinks,                          // internal+external only (score)
    navBrokenLinks,                              // nav broken (deduplicated at summary)
    footerBrokenLinks,                           // footer broken (deduplicated at summary)
    protectedLinks: [],
    issues:  nIssues.slice(0, 5).map(i => i.message),
    insight: nIssues.length === 0 ? 'All links working correctly.' : `${nIssues.length} navigation issue(s) found.`,
  };

  // ── Forms ──────────────────────────────────────────────────────────────────
  const formResults = fRaw.formResults ?? [];
  const forms = {
    count: fRaw.formsFound ?? 0,
    forms: formResults.map((f, i) => ({
      index:                     i,
      fieldCount:                f.inputCount ?? 2,
      purpose:                   f.isMultiStep ? 'multi-step' : 'contact',
      isCritical:                false,
      hasSubmitBtn:              true,
      hasEmailField:             f.invalidEmail?.tested ?? f.hasEmail ?? false,
      hasRequiredFields:         true,
      browserValidationActive:   f.emptySubmit?.validationShown ?? false,
      criticalMissingValidation: (f.issues ?? []).filter(i => i.type === 'critical').map(i => i.code),
      detectionMethod:           'dom',
    })),
  };

  // ── Category scores ─────────────────────────────────────────────────────────
  const { overall: overallScore, categories: categoryScores } = computeCategoryScores(
    {
      httpOk:               health.ok,
      blankScreen:          health.blankScreen,
      significantErrorCount: health.significantErrors,
      failedRequestCount:   health.failedRequests,
      criticalFailedCount:  health.criticalFailures,
    },
    {
      fcp:          fcpMs,
      lcp:          lcpMs,
      ttfb:         ttfbMs,
      tbt:          tbtMs,
      siDesktop,
      siMobile,
      desktopScore,
      mobileScore,
    },
    layout,
    {
      // Use content broken links only for nav scoring (nav/footer deduped at summary)
      navHealth:  contentBrokenLinks.length > 3 ? 'broken' : contentBrokenLinks.length > 0 ? 'issues' : 'good',
      brokenCount: contentBrokenLinks.length,
      issueCount:  nIssues.length,
    },
  );
  const grade = gradeFromScore(overallScore);

  // ── Findings ───────────────────────────────────────────────────────────────
  const findings     = [];
  const opportunities = [];

  // Health findings
  if (!health.ok)
    findings.push({ type: 'critical', message: `Page returned HTTP ${health.status} — users may not be able to access this page.` });
  if (health.blankScreen)
    findings.push({ type: 'critical', message: 'Blank screen detected — page may be completely broken.' });
  if (health.significantErrors > 0)
    findings.push({ type: 'warning', message: `${health.significantErrors} significant console error(s) detected.` });
  if (health.failedRequests > 10)
    findings.push({ type: 'critical', message: `${health.failedRequests} failed network request(s) — significant reliability issue.` });
  else if (health.failedRequests > 3)
    findings.push({ type: 'warning', message: `${health.failedRequests} failed network request(s).` });

  // FCP (desktop)
  if (fcpMs != null) {
    if      (fcpMs >= 3000) findings.push({ type: 'critical', message: `Very slow first paint — desktop FCP ${msToSeconds(fcpMs)} (target < 1.8s).` });
    else if (fcpMs >= 1800) findings.push({ type: 'warning',  message: `Moderate first paint — desktop FCP ${msToSeconds(fcpMs)}.` });
    else if (fcpMs <  1000) findings.push({ type: 'success',  message: `Excellent first paint — desktop FCP ${msToSeconds(fcpMs)}.` });
    else                    findings.push({ type: 'success',  message: `Good first paint — desktop FCP ${msToSeconds(fcpMs)}.` });
  }

  // LCP (desktop)
  if (lcpMs != null) {
    if      (lcpMs >= 4000) findings.push({ type: 'critical', message: `Slow Largest Contentful Paint — desktop LCP ${msToSeconds(lcpMs)} (target < 2.5s). Impacts SEO Core Web Vitals.` });
    else if (lcpMs >= 2500) findings.push({ type: 'warning',  message: `LCP needs improvement — desktop ${msToSeconds(lcpMs)}.` });
    else                    findings.push({ type: 'success',  message: `Good LCP — desktop ${msToSeconds(lcpMs)}.` });
  }

  // TTFB (desktop)
  if (ttfbMs != null) {
    if      (ttfbMs >= 800) findings.push({ type: 'critical', message: `Slow server response — TTFB ${msToSeconds(ttfbMs)}.` });
    else if (ttfbMs >= 400) findings.push({ type: 'warning',  message: `Server response time could improve — TTFB ${msToSeconds(ttfbMs)}.` });
  }

  // TBT (desktop)
  if (tbtMs != null) {
    if      (tbtMs >= 600) findings.push({ type: 'critical', message: `High Total Blocking Time — desktop TBT ${msToSeconds(tbtMs)}. Heavy JavaScript is blocking interaction.` });
    else if (tbtMs >= 200) findings.push({ type: 'warning',  message: `TBT ${msToSeconds(tbtMs)} — some JS blocking detected.` });
  }

  // CLS (desktop)
  if (clsVal != null) {
    if      (clsVal >= 0.25) findings.push({ type: 'critical', message: `High layout shift — CLS ${fmtCls(clsVal)} (target < 0.1). Elements shifting hurts UX and CWV.` });
    else if (clsVal >= 0.1)  findings.push({ type: 'warning',  message: `CLS ${fmtCls(clsVal)} — some layout instability.` });
    else                     findings.push({ type: 'success',  message: `Stable layout — CLS ${fmtCls(clsVal)}.` });
  }

  // Mobile vs desktop performance gap
  if (desktopScore != null && mobileScore != null) {
    const gap = desktopScore - mobileScore;
    if      (gap >= 40) findings.push({ type: 'critical', message: `Large mobile performance gap — desktop ${desktopScore}/100 vs mobile ${mobileScore}/100. Mobile users have a significantly worse experience.` });
    else if (gap >= 20) findings.push({ type: 'warning',  message: `Mobile performance (${mobileScore}/100) lags desktop (${desktopScore}/100) by ${gap} points.` });
    else if (desktopScore != null) findings.push({ type: 'success', message: `Desktop PSI score: ${desktopScore}/100, mobile: ${mobileScore ?? '—'}/100.` });
  }

  // Mobile responsiveness
  if (mobileOF)
    findings.push({ type: 'critical', message: "Not mobile-responsive — failing on 60%+ of today's traffic." });
  else
    findings.push({ type: 'success',  message: 'Fully mobile-responsive.' });

  // Broken links (all on this page)
  if (allBrokenLinks.length > 0)
    findings.push({ type: 'critical', message: `${allBrokenLinks.length} broken link(s) on this page — damages SEO.` });

  // Navigation issues
  if      (nIssues.length >= 5) findings.push({ type: 'warning', message: `${nIssues.length} navigation issues.` });
  else if (nIssues.length >  0) findings.push({ type: 'info',    message: `${nIssues.length} minor navigation issue(s).` });

  // Layout
  if      (!layout.headerVisible && !layout.footerVisible) findings.push({ type: 'critical', message: 'Missing both header and footer.' });
  else if (!layout.headerVisible)                          findings.push({ type: 'warning',  message: 'No visible header/navigation.' });
  else if (!layout.footerVisible)                          findings.push({ type: 'info',     message: 'No visible footer.' });

  // CTA
  if (layout.ctaCount === 0)
    findings.push({ type: 'warning', message: 'No CTAs detected — missed conversions.' });
  else
    findings.push({ type: 'success', message: `${layout.ctaCount} CTA(s): ${layout.ctaTexts.slice(0, 3).join(', ')}` });

  // Logo
  if (!layout.logoDetected)
    findings.push({ type: 'info', message: 'No logo detected on page.' });

  if (findings.filter(f => f.type === 'critical' || f.type === 'warning').length === 0)
    findings.push({ type: 'success', message: 'No critical issues on this page.' });

  // ── Opportunities (structured — deduplicated + aggregated in buildSummary) ──
  if (lcpMs != null && lcpMs >= 2500)              opportunities.push({ key: 'slow-lcp',    value: lcpMs,        pages: 1 });
  if (tbtMs != null && tbtMs >= 200)               opportunities.push({ key: 'high-tbt',    value: tbtMs,        pages: 1 });
  if (clsVal != null && clsVal >= 0.1)             opportunities.push({ key: 'high-cls',    value: clsVal,       pages: 1 });
  if (desktopScore != null && mobileScore != null && (desktopScore - mobileScore) >= 20)
                                                   opportunities.push({ key: 'mobile-perf', value: mobileScore,  pages: 1 });
  if (mobileOF)                                    opportunities.push({ key: 'mobile-resp', value: 1,            pages: 1 });
  if (layout.ctaCount === 0)                       opportunities.push({ key: 'no-cta',      value: 1,            pages: 1 });
  if (nIssues.length > 0)                          opportunities.push({ key: 'nav-issues',  value: nIssues.length, pages: 1 });
  if (health.failedRequests > 3)                   opportunities.push({ key: 'failed-reqs', value: health.failedRequests, pages: 1 });
  if (ttfbMs != null && ttfbMs >= 400)             opportunities.push({ key: 'slow-ttfb',   value: ttfbMs,       pages: 1 });
  if (!layout.headerVisible || !layout.footerVisible) opportunities.push({ key: 'missing-nav', value: 1,         pages: 1 });

  return { url, slug, overallScore, grade, categoryScores, health, performance, responsiveness, navigation, layout, forms, findings, opportunities };
}

// ─── Opportunity consolidation ────────────────────────────────────────────────

function consolidateOpportunities(rawOpps) {
  const grouped = {};
  rawOpps.forEach(opp => {
    if (typeof opp === 'string') {
      if (!grouped[opp]) grouped[opp] = { key: opp, isString: true, count: 0 };
      grouped[opp].count++;
      return;
    }
    if (!grouped[opp.key]) grouped[opp.key] = { key: opp.key, worstValue: opp.value, pageCount: 0 };
    grouped[opp.key].pageCount++;
    if (opp.value > grouped[opp.key].worstValue) grouped[opp.key].worstValue = opp.value;
  });

  const LABELS = {
    'slow-lcp':    (v, n) => `Improve Largest Contentful Paint — slowest page is ${msToSeconds(v)}. Optimize images and server response across ${n} page${n > 1 ? 's' : ''}.`,
    'high-tbt':    (v, n) => `Reduce JavaScript blocking time (TBT up to ${msToSeconds(v)}) — heavy JS is delaying interactivity on ${n} page${n > 1 ? 's' : ''}.`,
    'high-cls':    (v, n) => `Fix layout shift (CLS up to ${Number(v).toFixed(3)}) on ${n} page${n > 1 ? 's' : ''} — reserve space for images and ads.`,
    'mobile-perf': (v, n) => `Improve mobile performance (score as low as ${v}/100) on ${n} page${n > 1 ? 's' : ''} — mobile users are seeing much slower experiences than desktop.`,
    'mobile-resp': (v, n) => `Fix mobile responsiveness on ${n} page${n > 1 ? 's' : ''} — content overflows on 375px viewports.`,
    'no-cta':      (v, n) => `Add call-to-action buttons to ${n} page${n > 1 ? 's' : ''} — visitors have no clear conversion path.`,
    'nav-issues':  (v, n) => `Resolve navigation issues across ${n} page${n > 1 ? 's' : ''} — fix broken anchors and link structure.`,
    'failed-reqs': (v, n) => `Fix failed network requests — up to ${v} failures per page across ${n} page${n > 1 ? 's' : ''}.`,
    'slow-ttfb':   (v, n) => `Improve server response time (TTFB) — slow on ${n} page${n > 1 ? 's' : ''}. Add caching or a CDN.`,
    'missing-nav': (v, n) => `Add consistent header/footer on ${n} page${n > 1 ? 's' : ''} — missing navigation breaks user flow.`,
  };

  const ORDER = ['mobile-resp', 'slow-lcp', 'high-tbt', 'high-cls', 'mobile-perf', 'failed-reqs', 'no-cta', 'slow-ttfb', 'nav-issues', 'missing-nav'];

  const result = [];
  ORDER.forEach(key => {
    if (grouped[key]) {
      const g = grouped[key];
      const fn = LABELS[key];
      if (fn) result.push(fn(g.worstValue, g.pageCount));
    }
  });
  Object.values(grouped).filter(g => g.isString && !result.includes(g.key)).forEach(g => result.push(g.key));
  return result;
}

// ─── buildSummary ─────────────────────────────────────────────────────────────

function buildSummary(pages) {
  const scores   = pages.map(p => p.overallScore);
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const grade    = gradeFromScore(avgScore);

  const criticalCount   = pages.flatMap(p => p.findings).filter(f => f.type === 'critical').length;
  const warningCount    = pages.flatMap(p => p.findings).filter(f => f.type === 'warning').length;
  const mobileFailCount = pages.filter(p => p.responsiveness.mobile.score <= 20).length;
  const mobilePassCount = pages.filter(p => p.responsiveness.mobile.score === 100).length;

  const allOpportunities = consolidateOpportunities(pages.flatMap(p => p.opportunities));

  // ── Performance averages (desktop primary) ────────────────────────────────
  const withFcp  = pages.filter(p => p.performance.firstContentfulPaint.ms != null);
  const withLcp  = pages.filter(p => p.performance.largestContentfulPaint.ms != null);
  const withTtfb = pages.filter(p => p.performance.timeToFirstByte.ms != null);
  const withTbt  = pages.filter(p => p.performance.totalBlockingTime.ms != null);

  const avgFcp  = withFcp.length  ? Math.round(withFcp.reduce( (a, p) => a + p.performance.firstContentfulPaint.ms,   0) / withFcp.length)  : null;
  const avgLcp  = withLcp.length  ? Math.round(withLcp.reduce( (a, p) => a + p.performance.largestContentfulPaint.ms, 0) / withLcp.length)  : null;
  const avgTtfb = withTtfb.length ? Math.round(withTtfb.reduce((a, p) => a + p.performance.timeToFirstByte.ms,        0) / withTtfb.length) : null;
  const avgTbt  = withTbt.length  ? Math.round(withTbt.reduce( (a, p) => a + p.performance.totalBlockingTime.ms,      0) / withTbt.length)  : null;

  const avgDesktopPsiScore = (() => {
    const ps = pages.map(p => p.performance.desktop?.score).filter(s => s != null);
    return ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
  })();
  const avgMobilePsiScore = (() => {
    const ps = pages.map(p => p.performance.mobile?.score).filter(s => s != null);
    return ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null;
  })();

  // ── Navigation: deduplicate nav + footer broken links across all pages ────
  const brokenNavUrls  = new Set();
  const brokenFootUrls = new Set();
  pages.forEach(p => {
    (p.navigation.navBrokenLinks    ?? []).forEach(l => brokenNavUrls.add(l.url));
    (p.navigation.footerBrokenLinks ?? []).forEach(l => brokenFootUrls.add(l.url));
  });
  const contentBrokenTotal = pages.reduce((a, p) => a + (p.navigation.contentBrokenLinks?.length ?? 0), 0);
  const totalBrokenLinks   = brokenNavUrls.size + brokenFootUrls.size + contentBrokenTotal;
  const totalLinks         = pages.reduce((a, p) => a + p.navigation.totalLinks, 0);

  const httpOkCount        = pages.filter(p => p.health.ok).length;
  const totalCTAs          = pages.reduce((a, p) => a + p.layout.ctaCount, 0);
  const headerVisibleCount = pages.filter(p => p.layout.headerVisible).length;
  const footerVisibleCount = pages.filter(p => p.layout.footerVisible).length;
  const logoCount          = pages.filter(p => p.layout.logoDetected).length;

  const sorted     = [...pages].sort((a, b) => a.overallScore - b.overallScore);
  const worstPages = sorted.slice(0, 3).map(p => ({ slug: p.slug, score: p.overallScore, grade: p.grade }));
  const bestPages  = sorted.slice(-3).reverse().map(p => ({ slug: p.slug, score: p.overallScore, grade: p.grade }));

  const topFindings = [];
  if (criticalCount > 0)    topFindings.push(`${criticalCount} critical issue(s) across ${pages.length} pages`);
  if (mobileFailCount > 0)  topFindings.push(`${mobileFailCount} of ${pages.length} pages not mobile-ready`);
  if (totalBrokenLinks > 0) topFindings.push(`${totalBrokenLinks} unique broken link(s)`);
  if (warningCount > 0)     topFindings.push(`${warningCount} warning(s) flagged`);
  if (topFindings.length === 0) topFindings.push('No critical issues detected');

  return {
    pagesAudited: pages.length,
    averageScore: avgScore,
    grade,
    criticalIssues:   criticalCount,
    warnings:         warningCount,
    mobileFailures:   mobileFailCount,
    mobilePassCount,
    httpOkCount,
    totalLinks,
    totalBrokenLinks,
    totalCTAs,
    headerVisibleCount,
    footerVisibleCount,
    logoCount,
    // Performance averages (desktop FCP/TTFB/TBT + LCP replaces old loadTime)
    averageFirstContentfulPaint:  { ms: avgFcp,  formatted: msToSeconds(avgFcp),  grade: fcpGrade(avgFcp)  },
    averageLargestContentfulPaint:{ ms: avgLcp,  formatted: msToSeconds(avgLcp),  grade: lcpGrade(avgLcp)  },
    averageTTFB:                  { ms: avgTtfb, formatted: msToSeconds(avgTtfb), grade: ttfbGrade(avgTtfb) },
    averageTBT:                   { ms: avgTbt,  formatted: msToSeconds(avgTbt),  grade: tbtGrade(avgTbt)  },
    // PSI scores
    averageDesktopPsiScore: avgDesktopPsiScore,
    averageMobilePsiScore:  avgMobilePsiScore,
    topFindings,
    allOpportunities,
    worstPages,
    bestPages,
  };
}

// ─── buildFormValidationSummary ───────────────────────────────────────────────

function buildFormValidationSummary(pages) {
  const pagesWithForms = pages.filter(p => p.forms.count > 0);
  const totalForms     = pagesWithForms.reduce((a, p) => a + p.forms.count, 0);
  const allForms       = pagesWithForms.flatMap(p => p.forms.forms.map(f => ({ ...f, pageSlug: p.slug, pageUrl: p.url })));
  const issues = [];
  allForms.forEach(f => {
    if (!f.hasSubmitBtn)                         issues.push({ severity: 'warning',  page: f.pageSlug, message: 'Form has no submit button.' });
    if (!f.browserValidationActive && f.fieldCount > 1) issues.push({ severity: 'info', page: f.pageSlug, message: 'Browser validation not active.' });
    if (f.criticalMissingValidation.length > 0)  issues.push({ severity: 'critical', page: f.pageSlug, message: `Missing critical validation: ${f.criticalMissingValidation.join(', ')}` });
  });
  return {
    totalPages: pagesWithForms.length,
    totalForms,
    stats: {
      withSubmitButton:       allForms.filter(f => f.hasSubmitBtn).length,
      withEmailField:         allForms.filter(f => f.hasEmailField).length,
      withRequiredFields:     allForms.filter(f => f.hasRequiredFields).length,
      withBrowserValidation:  allForms.filter(f => f.browserValidationActive).length,
      withMissingValidation:  allForms.filter(f => f.criticalMissingValidation.length > 0).length,
    },
    forms: allForms.map(f => ({
      page: f.pageSlug, pageUrl: f.pageUrl, fieldCount: f.fieldCount, purpose: f.purpose,
      hasSubmitBtn: f.hasSubmitBtn, hasEmailField: f.hasEmailField, hasRequiredFields: f.hasRequiredFields,
      browserValidationActive: f.browserValidationActive, criticalMissingValidation: f.criticalMissingValidation,
    })),
    issues: issues.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - ({ critical: 0, warning: 1, info: 2 }[b.severity]))),
  };
}

// ─── buildUiUxIssues ──────────────────────────────────────────────────────────

function buildUiUxIssues(pages) {
  const issues = [];
  pages.forEach(p => {
    const slug = p.slug, url = p.url;
    if (!p.layout.headerVisible)
      issues.push({ category: 'Layout',        severity: 'critical', page: slug, url, title: 'Missing Header Navigation',         description: `The page at ${slug} has no visible header or navigation bar. Users cannot navigate to other sections of the site, leading to high bounce rates and poor user experience.`,            pageCount: 1, affectedPages: [slug] });
    if (!p.layout.footerVisible)
      issues.push({ category: 'Layout',        severity: 'warning',  page: slug, url, title: 'Missing Footer',                    description: `No footer is visible on ${slug}. Footers provide essential links, legal information, and trust signals.`,                                                                           pageCount: 1, affectedPages: [slug] });
    if (!p.layout.logoDetected)
      issues.push({ category: 'Branding',      severity: 'info',     page: slug, url, title: 'No Logo Detected',                  description: `The page ${slug} does not display a visible logo.`,                                                                                                                              pageCount: 1, affectedPages: [slug] });
    if (p.layout.logoDetected && !p.layout.logoLinksHome)
      issues.push({ category: 'Navigation',    severity: 'warning',  page: slug, url, title: 'Logo Does Not Link to Homepage',    description: `The logo on ${slug} is visible but does not link back to the homepage.`,                                                                                                          pageCount: 1, affectedPages: [slug] });
    if (p.layout.ctaCount === 0)
      issues.push({ category: 'Conversions',   severity: 'warning',  page: slug, url, title: 'No Call-to-Action Found',           description: `No CTA buttons or links were detected on ${slug}. Without clear calls to action, visitors have no guided path to convert.`,                                                      pageCount: 1, affectedPages: [slug] });
    if (p.responsiveness.mobile?.details && !p.responsiveness.mobile.details.responsive)
      issues.push({ category: 'Responsiveness',severity: 'critical', page: slug, url, title: 'Not Mobile Responsive',             description: `The page ${slug} is not responsive at 375px mobile viewport.`,                                                                                                                   pageCount: 1, affectedPages: [slug] });
    // PSI-based UX issues
    const dLcp = p.performance.largestContentfulPaint?.ms;
    const dTbt = p.performance.totalBlockingTime?.ms;
    if (dLcp != null && dLcp >= 4000)
      issues.push({ category: 'Performance',   severity: 'critical', page: slug, url, title: 'Poor Largest Contentful Paint',     description: `LCP is ${msToSeconds(dLcp)} on ${slug} — significantly above the 2.5s target. This directly impacts Google's Core Web Vitals ranking signals.`,                                   pageCount: 1, affectedPages: [slug] });
    if (dTbt != null && dTbt >= 600)
      issues.push({ category: 'Performance',   severity: 'critical', page: slug, url, title: 'High JavaScript Blocking Time',     description: `Total Blocking Time is ${msToSeconds(dTbt)} on ${slug} — heavy JavaScript is preventing user interaction. Reduce or defer unused JS bundles.`,                                   pageCount: 1, affectedPages: [slug] });
  });

  const grouped = {};
  issues.forEach(i => {
    if (!grouped[i.title]) grouped[i.title] = { ...i, affectedPages: [i.page] };
    else grouped[i.title].affectedPages.push(i.page);
  });
  const deduped = Object.values(grouped)
    .map(g => ({
      ...g,
      pageCount: g.affectedPages.length,
      description: g.affectedPages.length > 1
        ? `${g.description.split('.')[0]}. This issue affects ${g.affectedPages.length} pages: ${g.affectedPages.slice(0, 4).join(', ')}${g.affectedPages.length > 4 ? ` and ${g.affectedPages.length - 4} more` : ''}.`
        : g.description,
    }))
    .sort((a, b) =>
      ({ critical: 0, warning: 1, info: 2 }[a.severity] ?? 3) - ({ critical: 0, warning: 1, info: 2 }[b.severity] ?? 3) ||
      b.pageCount - a.pageCount,
    );

  return { totalIssues: deduped.length, issues: deduped };
}

// ─── buildReport ──────────────────────────────────────────────────────────────

function buildReport(rawPages) {
  const transformed = rawPages.map(transformPage);
  const summary     = buildSummary(transformed);
  const domain      = (() => { try { return new URL(rawPages[0].url).hostname; } catch { return 'unknown'; } })();

  return {
    meta: {
      reportTitle:  `Web Audit Report — ${domain}`,
      domain,
      generatedAt:  new Date().toISOString(),
      auditedPages: transformed.length,
      tool:         'SPCTEK Web Auditor',
      version:      '2.0',
    },

    executiveSummary: {
      headline: summary.averageScore >= 75
        ? `Your site scores ${summary.averageScore}/100 — a solid foundation with clear wins available.`
        : `Your site scores ${summary.averageScore}/100 — meaningful improvements available.`,
      overallScore: summary.averageScore,
      grade:        summary.grade,

      keyStats: [
        { label: 'Pages Audited',    value: summary.pagesAudited,                                         icon: 'PA'  },
        { label: 'Critical Issues',  value: summary.criticalIssues,  highlight: summary.criticalIssues > 0, icon: 'CI'  },
        { label: 'Warnings',         value: summary.warnings,                                             icon: 'WN'  },
        { label: 'Mobile Failures',  value: summary.mobileFailures,  highlight: summary.mobileFailures > 0, icon: 'MF'  },
        { label: 'Avg. FCP',         value: summary.averageFirstContentfulPaint.formatted ?? 'N/A',
          subLabel: summary.averageFirstContentfulPaint.grade?.label,                                      icon: 'FCP' },
        { label: 'Avg. LCP',         value: summary.averageLargestContentfulPaint.formatted ?? 'N/A',
          subLabel: summary.averageLargestContentfulPaint.grade?.label,                                    icon: 'LCP' },
        { label: 'Desktop PSI',      value: summary.averageDesktopPsiScore != null ? `${summary.averageDesktopPsiScore}/100` : 'N/A', icon: 'PSI' },
        { label: 'Mobile PSI',       value: summary.averageMobilePsiScore  != null ? `${summary.averageMobilePsiScore}/100`  : 'N/A', icon: 'MOB' },
      ],

      performanceStats: {
        avgFCP:  summary.averageFirstContentfulPaint,
        avgLCP:  summary.averageLargestContentfulPaint,
        avgTTFB: summary.averageTTFB,
        avgTBT:  summary.averageTBT,
        avgDesktopPsiScore: summary.averageDesktopPsiScore,
        avgMobilePsiScore:  summary.averageMobilePsiScore,
      },

      siteHealth: {
        httpOkCount:   summary.httpOkCount,
        totalPages:    summary.pagesAudited,
        totalLinks:    summary.totalLinks,
        brokenLinks:   summary.totalBrokenLinks,
        totalCTAs:     summary.totalCTAs,
        headerFound:   summary.headerVisibleCount,
        footerFound:   summary.footerVisibleCount,
        logoFound:     summary.logoCount,
        mobilePass:    summary.mobilePassCount,
        mobileFail:    summary.mobileFailures,
      },

      topFindings:   summary.topFindings,
      worstPages:    summary.worstPages,
      bestPages:     summary.bestPages,
      callToAction:  'The issues identified are actionable improvements that can increase search rankings, improve user experience, and drive more conversions.',
    },

    pageBreakdown:         transformed,
    formValidationSummary: buildFormValidationSummary(transformed),
    uiUxIssues:            buildUiUxIssues(transformed),

    opportunitySummary: {
      title:       'Growth Opportunities Identified',
      description: 'Addressing these items can directly impact your search rankings, page speed, and user engagement.',
      items:       summary.allOpportunities.map((opp, i) => ({ id: i + 1, opportunity: opp })),
    },

    categoryScorecard: {
      title: 'How Your Site Performs by Category',
      categories: [
        { name: 'Page Health',         description: 'HTTP status, console errors, failed requests, and reliability',                        score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.health,     0) / transformed.length) },
        { name: 'Page Speed',          description: 'First Contentful Paint, Largest Contentful Paint, TTFB, and Total Blocking Time',      score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.speed,      0) / transformed.length) },
        { name: 'Resource Efficiency', description: 'Speed Index (desktop + mobile) and mobile vs desktop rendering efficiency',            score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.resources,  0) / transformed.length) },
        { name: 'Mobile Experience',   description: 'Responsiveness across mobile, tablet, and desktop viewports',                         score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.mobile,     0) / transformed.length) },
        { name: 'Navigation & Links',  description: 'Broken links, anchor integrity, and navigation health',                               score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.navigation, 0) / transformed.length) },
        { name: 'Layout & UX',         description: 'Header, footer, logo, CTAs, and page structure completeness',                        score: Math.round(transformed.reduce((a, p) => a + p.categoryScores.layout,     0) / transformed.length) },
      ].map(c => ({ ...c, grade: gradeFromScore(c.score) })),
    },
  };
}

module.exports = { buildReport };

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const inputArg  = process.argv[2] || 'results.json';
  const inputPath = fs.existsSync(inputArg) ? inputArg : path.join('outputs', 'raw-json', inputArg);
  if (!fs.existsSync(inputPath)) { console.error(`❌  Not found: ${inputPath}`); process.exit(1); }

  const raw   = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const pages = Array.isArray(raw) ? raw : (raw.pages ?? [raw]);

  const report = buildReport(pages);
  fs.mkdirSync('outputs/report-json', { recursive: true });
  const out = 'outputs/report-json/report.json';
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`✅  Report written: ${out}`);
  console.log(`📊  Pages: ${report.meta.auditedPages}  Score: ${report.executiveSummary.overallScore}/100 (${report.executiveSummary.grade.grade})`);
  console.log(`🔴  Critical: ${report.executiveSummary.keyStats[1].value}  ⚠️  Warnings: ${report.executiveSummary.keyStats[2].value}`);
  console.log(`🚀  Desktop PSI avg: ${report.executiveSummary.performanceStats.avgDesktopPsiScore ?? '—'}  Mobile PSI avg: ${report.executiveSummary.performanceStats.avgMobilePsiScore ?? '—'}`);
}