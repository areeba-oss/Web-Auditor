'use strict';
const fs   = require('fs');
const path = require('path');

function msToSeconds(ms) { return ms ? (ms / 1000).toFixed(2) + 's' : null; }
function fcpGrade(ms)    { if (!ms) return null; if (ms < 1800) return { label: 'Fast', color: '#16a34a' }; if (ms < 3000) return { label: 'Moderate', color: '#b45309' }; return { label: 'Slow', color: '#dc2626' }; }
function ttfbGrade(ms)   { if (!ms) return null; if (ms < 200)  return { label: 'Excellent', color: '#16a34a' }; if (ms < 500) return { label: 'Acceptable', color: '#b45309' }; return { label: 'Slow', color: '#dc2626' }; }
function loadGrade(ms)   { if (!ms) return null; if (ms < 3000) return { label: 'Fast', color: '#16a34a' }; if (ms < 6000) return { label: 'Moderate', color: '#b45309' }; return { label: 'Slow', color: '#dc2626' }; }
function mobileGrade(responsive, hasScroll) {
  if (responsive && !hasScroll) return { label: 'Fully Responsive', color: '#16a34a', score: 100 };
  if (!responsive && hasScroll) return { label: 'Not Mobile-Ready', color: '#dc2626', score: 20 };
  return { label: 'Partial', color: '#b45309', score: 60 };
}
function navHealthLabel(h) {
  if (h === 'good')   return { label: 'All Links Working',    color: '#16a34a' };
  if (h === 'issues') return { label: 'Minor Issues Found',   color: '#b45309' };
  return                     { label: 'Broken Links Detected', color: '#dc2626' };
}
function gradeFromScore(s) {
  if (s >= 90) return { grade: 'A', label: 'Excellent',      color: '#16a34a' };
  if (s >= 75) return { grade: 'B', label: 'Good',           color: '#65a30d' };
  if (s >= 60) return { grade: 'C', label: 'Fair',           color: '#b45309' };
  if (s >= 40) return { grade: 'D', label: 'Poor',           color: '#ea580c' };
  return              { grade: 'F', label: 'Critical Issues', color: '#dc2626' };
}

function interpolateScore(value, bp) {
  if (value == null || isNaN(value)) return null;
  if (value <= bp[0][0]) return bp[0][1];
  if (value >= bp[bp.length-1][0]) return bp[bp.length-1][1];
  for (let i=1; i<bp.length; i++) {
    if (value <= bp[i][0]) {
      const [t0,s0]=bp[i-1], [t1,s1]=bp[i];
      return Math.round(s0 + ((s1-s0)*(value-t0))/(t1-t0));
    }
  }
  return bp[bp.length-1][1];
}

const CURVES = {
  fcp:[[0,100],[500,98],[800,92],[1000,82],[1200,72],[1500,58],[1800,45],[2500,25],[3500,8],[5000,0]],
  ttfb:[[0,100],[80,97],[150,90],[250,75],[350,55],[500,32],[700,15],[1000,5],[2000,0]],
  loadTime:[[0,100],[1000,97],[2000,88],[3000,72],[4000,55],[5500,32],[7000,15],[10000,3],[15000,0]],
  dcl:[[0,100],[600,95],[1000,82],[1400,65],[1800,48],[2200,30],[3000,12],[5000,0]],
  failedRequests:[[0,100],[1,90],[3,72],[6,52],[10,32],[18,15],[30,5],[50,0]],
  slowResources:[[0,100],[1,78],[2,58],[3,42],[5,22],[8,8],[12,0]],
  largeImages:[[0,100],[1,68],[2,45],[4,20],[6,5],[10,0]],
  pageWeight:[[0,100],[100,96],[300,82],[600,60],[1000,38],[2000,15],[5000,0]],
  resourceCount:[[0,100],[10,95],[25,78],[40,58],[60,35],[100,12],[200,0]],
  consoleErrors:[[0,100],[1,72],[3,45],[5,25],[10,8],[20,0]],
  navIssues:[[0,100],[1,78],[3,52],[5,30],[10,10],[20,0]],
};

function computeCategoryScores(h, p, l, n) {
  const healthCat = Math.round(
    (h.httpOk?100:0)*0.3 +
    (interpolateScore(h.significantErrorCount??0, CURVES.consoleErrors)??100)*0.2 +
    (interpolateScore(h.failedRequestCount??0, CURVES.failedRequests)??100)*0.25 +
    ((h.criticalFailedCount??0)>0?0:100)*0.15 +
    (h.blankScreen?0:100)*0.1
  );
  const speedCat = Math.round(
    (interpolateScore(p.fcp,      CURVES.fcp)??50)*0.35 +
    (interpolateScore(p.ttfb,     CURVES.ttfb)??50)*0.25 +
    (interpolateScore(p.loadTime, CURVES.loadTime)??50)*0.25 +
    (interpolateScore(p.dcl,      CURVES.dcl)??50)*0.15
  );
  const resourcesCat = Math.round(
    (interpolateScore(p.slowCount,  CURVES.slowResources)??100)*0.30 +
    (interpolateScore(p.largeCount, CURVES.largeImages)??100)*0.25 +
    (interpolateScore(p.totalKB,    CURVES.pageWeight)??80)*0.25 +
    (interpolateScore(p.resCount,   CURVES.resourceCount)??80)*0.20
  );
  const resp = l.responsiveness ?? {};
  const mobileCat = Math.round(
    (resp.mobile?.responsive && !resp.mobile?.hasHorizontalScroll ? 100 : 0)*0.55 +
    (resp.tablet?.responsive??false ? 100 : 0)*0.30 +
    (resp.desktop?.responsive??true ? 100 : 0)*0.15
  );
  const navHealthScore = n.navHealth==='good'?100: n.navHealth==='issues'?55:15;
  const brokenPenalty  = n.brokenCount===0?100:Math.max(0,100-n.brokenCount*25);
  const navIssueScore  = interpolateScore(n.issueCount??0, CURVES.navIssues)??100;
  const navigationCat  = Math.round(navHealthScore*0.4 + brokenPenalty*0.35 + navIssueScore*0.25);
  let layoutCat = 0;
  if (l.headerVisible) layoutCat+=22;
  if (l.footerVisible) layoutCat+=18;
  if (l.logoDetected)  layoutCat+=12;
  if (l.logoLinksHome) layoutCat+=5;
  if (l.mainCTAVisible) layoutCat+=18;
  layoutCat += Math.min(15,(l.ctaCount??0)*5);
  if (l.headerVisible && l.footerVisible) layoutCat+=10;
  layoutCat = Math.min(100, layoutCat);
  const overall = Math.round(healthCat*0.15 + speedCat*0.30 + resourcesCat*0.15 + mobileCat*0.15 + navigationCat*0.10 + layoutCat*0.15);
  return { overall, categories: { health:healthCat, speed:speedCat, resources:resourcesCat, mobile:mobileCat, navigation:navigationCat, layout:layoutCat } };
}

function transformPage(raw) {
  const url  = raw.url;
  const slug = (() => { try { return new URL(url).pathname || '/'; } catch { return '/'; } })();

  // Our auditor fields
  const hRaw = raw.health      ?? {};
  const uRaw = raw.ui          ?? {};
  const nRaw = raw.navigation  ?? {};
  const fRaw = raw.forms       ?? {};
  const pRaw = raw.performance ?? {};

  const uDetails  = uRaw.details  ?? {};
  const pMetrics  = pRaw.metrics  ?? {};
  const pImages   = pRaw.images   ?? {};

  // ── Health ──
  const health = {
    status:               hRaw.httpStatus ?? null,
    ok:                   hRaw.httpOk ?? false,
    blankScreen:          hRaw.blankScreen ?? false,
    significantErrors:    (hRaw.significantErrors ?? []).length,
    failedRequests:       (hRaw.failedRequests ?? []).length,
    criticalFailures:     (hRaw.criticalFailures ?? []).length,
    significantErrorMessages: (hRaw.significantErrors ?? []).slice(0,5),
  };

  // ── Performance ──
  const fcpMs   = pMetrics.fcp      ?? null;
  const ttfbMs  = pMetrics.ttfb     ?? null;
  const dclMs   = pMetrics.dcl      ?? null;
  const totalMs = pMetrics.loadTime ?? null;
  const totalKB = pMetrics.totalTransferKb ?? 0;
  const resCount = pMetrics.resourceCount ?? 0;
  const slowRes  = (pImages.slow  ?? []).map(i => ({ url:i.url, type:'image', durationMs:i.durationMs??0, sizeKB:Math.round((i.sizeBytes??0)/1024) }));
  const largeImg = (pImages.large ?? []).map(i => ({ url:i.url, durationMs:i.durationMs??0, sizeKB:Math.round((i.sizeBytes??0)/1024) }));

  const performance = {
    firstContentfulPaint: { ms:fcpMs,   formatted:msToSeconds(fcpMs),   grade:fcpGrade(fcpMs)   },
    timeToFirstByte:      { ms:ttfbMs,  formatted:msToSeconds(ttfbMs),  grade:ttfbGrade(ttfbMs) },
    domContentLoaded:     { ms:dclMs,   formatted:msToSeconds(dclMs)    },
    totalLoadTime:        { ms:totalMs, formatted:msToSeconds(totalMs), grade:loadGrade(totalMs) },
    resources:            { script:{count:0,totalKB:pMetrics.jsSizeKb??0}, link:{count:0,totalKB:pMetrics.cssSizeKb??0}, other:{count:resCount,totalKB:totalKB} },
    totalResources:       resCount,
    totalResourceSizeKB:  totalKB,
    slowResources:        slowRes,
    largeImages:          largeImg,
  };

  // ── UI — extract from breakpoints ──
  const bpMap = {};
  (uRaw.breakpointResults ?? []).forEach(bp => { bpMap[bp.breakpoint] = bp; });
  const mobileOF  = bpMap.mobile?.domOverflow  ?? false;
  const tabletOF  = bpMap.tablet?.domOverflow  ?? false;
  const desktopOF = bpMap.desktop?.domOverflow ?? false;

  const dHeader = uDetails.header?.desktop ?? uDetails.header?.mobile ?? {};
  const dFooter = uDetails.footer?.desktop ?? uDetails.footer?.mobile ?? {};
  const dCTA    = uDetails.cta?.desktop    ?? uDetails.cta?.mobile    ?? {};
  const logo    = uDetails.logo ?? {};

  const layout = {
    headerFound:   dHeader.visible ?? false,
    headerVisible: dHeader.visible ?? false,
    footerFound:   dFooter.visible ?? false,
    footerVisible: dFooter.visible ?? false,
    logoDetected:  logo.visible ?? false,
    logoVisible:   logo.visible ?? false,
    logoLinksHome: logo.linksToHome ?? false,
    mainCTAVisible: dCTA.found ?? false,
    ctaCount:      dCTA.count ?? 0,
    ctaTexts:      (dCTA.examples ?? []).slice(0,6),
    responsiveness: {
      mobile:  { responsive:!mobileOF,  hasHorizontalScroll:mobileOF,  details:{ responsive:!mobileOF,  hasHorizontalScroll:mobileOF  } },
      tablet:  { responsive:!tabletOF,  hasHorizontalScroll:tabletOF,  details:{ responsive:!tabletOF,  hasHorizontalScroll:tabletOF  } },
      desktop: { responsive:!desktopOF, hasHorizontalScroll:desktopOF, details:{ responsive:!desktopOF, hasHorizontalScroll:desktopOF } },
    },
  };

  const responsiveness = {
    mobile:  { ...mobileGrade(!mobileOF, mobileOF),  details:{ responsive:!mobileOF,  hasHorizontalScroll:mobileOF  } },
    tablet:  { label:!tabletOF?'Responsive':'Issues', color:!tabletOF?'#16a34a':'#dc2626', details:{ responsive:!tabletOF } },
    desktop: { label:'Responsive', color:'#16a34a', details:{ responsive:true } },
  };

  // ── Navigation ──
  const nSummary = nRaw.summary ?? {};
  const nDetails = nRaw.details ?? {};
  const nIssues  = (nRaw.issues ?? []).filter(i => i.type !== 'info');
  const brokenLinks = [];
  ['nav','internal','external','footer'].forEach(region => {
    (nDetails[region] ?? []).filter(l => !l.ok && l.status !== 'timeout').forEach(l => {
      brokenLinks.push({ url:l.url, status:l.status, region });
    });
  });
  const totalLinks    = (nSummary.nav?.total??0)+(nSummary.internal?.total??0)+(nSummary.external?.total??0)+(nSummary.footer?.total??0);
  const navHealthStr  = brokenLinks.length>3?'broken': brokenLinks.length>0?'issues':'good';
  const navigation = {
    health:      navHealthLabel(navHealthStr),
    severity:    brokenLinks.length>3?'high': brokenLinks.length>0?'medium':'low',
    totalLinks,
    internalLinks: (nSummary.internal?.total??0)+(nSummary.footer?.total??0),
    externalLinks: nSummary.external?.total??0,
    brokenLinks,
    protectedLinks: [],
    issues:      nIssues.slice(0,5).map(i => i.message),
    insight:     nIssues.length===0?'All links working correctly.':`${nIssues.length} navigation issue(s) found.`,
  };

  // ── Forms ──
  const formResults = fRaw.formResults ?? [];
  const forms = {
    count: fRaw.formsFound ?? 0,
    forms: formResults.map((f,i) => ({
      index: i, fieldCount: f.inputCount??2, purpose: f.isMultiStep?'multi-step':'contact',
      isCritical: false, hasSubmitBtn: true,
      hasEmailField: f.invalidEmail?.tested ?? f.hasEmail ?? false,
      hasRequiredFields: true,
      browserValidationActive: f.emptySubmit?.validationShown ?? false,
      criticalMissingValidation: (f.issues??[]).filter(i=>i.type==='critical').map(i=>i.code),
      detectionMethod: 'dom',
    })),
  };

  // ── Score ──
  const { overall: overallScore, categories: categoryScores } = computeCategoryScores(
    { httpOk:health.ok, blankScreen:health.blankScreen, significantErrorCount:health.significantErrors, failedRequestCount:health.failedRequests, criticalFailedCount:health.criticalFailures },
    { fcp:fcpMs, ttfb:ttfbMs, dcl:dclMs, loadTime:totalMs, slowCount:slowRes.length, largeCount:largeImg.length, totalKB, resCount },
    layout,
    { navHealth:navHealthStr, brokenCount:brokenLinks.length, issueCount:nIssues.length }
  );
  const grade = gradeFromScore(overallScore);

  // ── Findings ──
  const findings = [], opportunities = [];
  if (!health.ok)                  findings.push({ type:'critical', message:`Page returned HTTP ${health.status} — users may not be able to access this page.` });
  if (health.blankScreen)          findings.push({ type:'critical', message:'Blank screen detected — page may be completely broken.' });
  if (health.significantErrors>0)  findings.push({ type:'warning',  message:`${health.significantErrors} significant console error(s) detected.` });
  if (health.failedRequests>10)    findings.push({ type:'critical', message:`${health.failedRequests} failed network request(s) — significant reliability issue.` });
  else if (health.failedRequests>3) findings.push({ type:'warning', message:`${health.failedRequests} failed network request(s).` });

  if (fcpMs >= 3000)       findings.push({ type:'critical', message:`Very slow first paint (${msToSeconds(fcpMs)}) — users may abandon.` });
  else if (fcpMs >= 1800)  findings.push({ type:'warning',  message:`Moderate page paint time (${msToSeconds(fcpMs)}) — room for improvement.` });
  else if (fcpMs < 1000)   findings.push({ type:'success',  message:`Excellent first paint (${msToSeconds(fcpMs)}).` });
  else if (fcpMs)          findings.push({ type:'success',  message:`Good first paint (${msToSeconds(fcpMs)}).` });

  if (ttfbMs>=800)  findings.push({ type:'critical', message:`Slow server response (${msToSeconds(ttfbMs)} TTFB).` });
  else if (ttfbMs>=400) findings.push({ type:'warning', message:`Server response time could improve (${msToSeconds(ttfbMs)} TTFB).` });
  if (totalMs>=7000)    findings.push({ type:'critical', message:`Page takes ${msToSeconds(totalMs)} to fully load — severe UX impact.` });
  else if (totalMs>=5000) findings.push({ type:'warning', message:`Total load time ${msToSeconds(totalMs)} — noticeably slow.` });
  if (dclMs>=2500)      findings.push({ type:'warning', message:`DOM ready at ${msToSeconds(dclMs)} — interactive content delayed.` });
  if (slowRes.length>=4) findings.push({ type:'critical', message:`${slowRes.length} slow-loading resources dragging down page speed.` });
  else if (slowRes.length>=2) findings.push({ type:'warning', message:`${slowRes.length} resources loading slowly (>1s each).` });
  if (totalKB>1000) findings.push({ type:'critical', message:`Heavy page weight (${totalKB} KB) — compress assets.` });
  else if (totalKB>500) findings.push({ type:'warning', message:`Page weight ${totalKB} KB could be reduced.` });
  if (mobileOF)  findings.push({ type:'critical', message:"Not mobile-responsive — failing on 60%+ of today's traffic." });
  else           findings.push({ type:'success',  message:'Fully mobile-responsive.' });
  if (brokenLinks.length>0) findings.push({ type:'critical', message:`${brokenLinks.length} broken link(s) — damages SEO.` });
  if (nIssues.length>=5)    findings.push({ type:'warning',  message:`${nIssues.length} navigation issues.` });
  else if (nIssues.length>0) findings.push({ type:'info', message:`${nIssues.length} minor navigation issue(s).` });
  if (!layout.headerVisible && !layout.footerVisible) findings.push({ type:'critical', message:'Missing both header and footer.' });
  else if (!layout.headerVisible) findings.push({ type:'warning', message:'No visible header/navigation.' });
  else if (!layout.footerVisible) findings.push({ type:'info', message:'No visible footer.' });
  if (layout.ctaCount===0) findings.push({ type:'warning', message:'No CTAs detected — missed conversions.' });
  else findings.push({ type:'success', message:`${layout.ctaCount} CTA(s): ${layout.ctaTexts.slice(0,3).join(', ')}` });
  if (!layout.logoDetected) findings.push({ type:'info', message:'No logo detected on page.' });
  if (findings.filter(f=>f.type==='critical'||f.type==='warning').length===0) findings.push({ type:'success', message:'No critical issues on this page.' });

  // Store structured objects so buildSummary can deduplicate + aggregate across pages
  if (totalKB>500)             opportunities.push({ key:'page-weight',  value:totalKB,          pages:1 });
  if (slowRes.length)          opportunities.push({ key:'slow-resources',value:slowRes.length,   pages:1 });
  if (mobileOF)                opportunities.push({ key:'mobile-resp',  value:1,                pages:1 });
  if (layout.ctaCount===0)     opportunities.push({ key:'no-cta',       value:1,                pages:1 });
  if (nIssues.length>0)        opportunities.push({ key:'nav-issues',   value:nIssues.length,   pages:1 });
  if (health.failedRequests>3) opportunities.push({ key:'failed-reqs',  value:health.failedRequests, pages:1 });
  if (ttfbMs>=400)             opportunities.push({ key:'slow-ttfb',    value:ttfbMs,           pages:1 });
  if (totalMs>=5000)           opportunities.push({ key:'slow-load',    value:totalMs,          pages:1 });
  if (!layout.headerVisible || !layout.footerVisible) opportunities.push({ key:'missing-nav', value:1, pages:1 });

  return { url, slug, overallScore, grade, categoryScores, health, performance, responsiveness, navigation, layout, forms, findings, opportunities };
}


// ─── Consolidate opportunities across pages ───────────────────────────────────
// Groups by key, picks worst-case value, counts affected pages, outputs clean sentences

function consolidateOpportunities(rawOpps) {
  const grouped = {};
  rawOpps.forEach(opp => {
    if (typeof opp === 'string') {
      // Legacy string format — use as-is with dedup
      if (!grouped[opp]) grouped[opp] = { key: opp, isString: true, count: 0 };
      grouped[opp].count++;
      return;
    }
    if (!grouped[opp.key]) {
      grouped[opp.key] = { key: opp.key, worstValue: opp.value, pageCount: 0 };
    }
    grouped[opp.key].pageCount++;
    if (opp.value > grouped[opp.key].worstValue) grouped[opp.key].worstValue = opp.value;
  });

  const LABELS = {
    'page-weight':   (v, n) => `Reduce page weight — heaviest page is ${v} KB. Compress images and minify JS/CSS across ${n} page${n>1?'s':''}.`,
    'slow-resources':(v, n) => `Fix slow-loading resources — up to ${v} asset${v>1?'s':''} taking over 1s to load across ${n} page${n>1?'s':''}.`,
    'mobile-resp':   (v, n) => `Fix mobile responsiveness on ${n} page${n>1?'s':''} — content overflows on 375px viewports.`,
    'no-cta':        (v, n) => `Add call-to-action buttons to ${n} page${n>1?'s':''} — visitors have no clear conversion path.`,
    'nav-issues':    (v, n) => `Resolve navigation issues across ${n} page${n>1?'s':''} — fix broken anchors and link structure.`,
    'failed-reqs':   (v, n) => `Fix failed network requests — up to ${v} failures per page across ${n} page${n>1?'s':''}.`,
    'slow-ttfb':     (v, n) => `Improve server response time (TTFB) — slow on ${n} page${n>1?'s':''}. Add caching or a CDN.`,
    'slow-load':     (v, n) => `Reduce total load time — slowest page takes ${(v/1000).toFixed(1)}s. Target under 3s across ${n} page${n>1?'s':''}.`,
    'missing-nav':   (v, n) => `Add consistent header/footer on ${n} page${n>1?'s':''} — missing navigation breaks user flow.`,
  };

  // Priority order for display
  const ORDER = ['mobile-resp','page-weight','slow-resources','failed-reqs','no-cta','slow-load','slow-ttfb','nav-issues','missing-nav'];

  const result = [];
  ORDER.forEach(key => {
    if (grouped[key]) {
      const g = grouped[key];
      const label = LABELS[key];
      if (label) result.push(label(g.worstValue, g.pageCount));
    }
  });

  // Any leftover string-format entries
  Object.values(grouped).filter(g => g.isString && !result.includes(g.key)).forEach(g => {
    result.push(g.key);
  });

  return result;
}

function buildSummary(pages) {
  const scores   = pages.map(p => p.overallScore);
  const avgScore = Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);
  const grade    = gradeFromScore(avgScore);
  const criticalCount   = pages.flatMap(p=>p.findings).filter(f=>f.type==='critical').length;
  const warningCount    = pages.flatMap(p=>p.findings).filter(f=>f.type==='warning').length;
  const mobileFailCount = pages.filter(p=>p.responsiveness.mobile.score<=20).length;
  const mobilePassCount = pages.filter(p=>p.responsiveness.mobile.score===100).length;
  // Aggregate per-page structured opportunities → deduplicated, consolidated list
  const allOpportunities = consolidateOpportunities(pages.flatMap(p=>p.opportunities));
  const pFCP  = pages.filter(p=>p.performance.firstContentfulPaint.ms);
  const avgFcp = pFCP.length ? Math.round(pFCP.reduce((a,p)=>a+p.performance.firstContentfulPaint.ms,0)/pFCP.length) : null;
  const pTTFB = pages.filter(p=>p.performance.timeToFirstByte.ms);
  const avgTtfb = pTTFB.length ? Math.round(pTTFB.reduce((a,p)=>a+p.performance.timeToFirstByte.ms,0)/pTTFB.length) : null;
  const pLoad = pages.filter(p=>p.performance.totalLoadTime.ms);
  const avgLoad = pLoad.length ? Math.round(pLoad.reduce((a,p)=>a+p.performance.totalLoadTime.ms,0)/pLoad.length) : null;
  const totalBrokenLinks   = pages.reduce((a,p)=>a+(p.navigation.brokenLinks?.length??0),0);
  const totalLinks         = pages.reduce((a,p)=>a+p.navigation.totalLinks,0);
  const httpOkCount        = pages.filter(p=>p.health.ok).length;
  const totalCTAs          = pages.reduce((a,p)=>a+p.layout.ctaCount,0);
  const headerVisibleCount = pages.filter(p=>p.layout.headerVisible).length;
  const footerVisibleCount = pages.filter(p=>p.layout.footerVisible).length;
  const logoCount          = pages.filter(p=>p.layout.logoDetected).length;
  const sorted = [...pages].sort((a,b)=>a.overallScore-b.overallScore);
  const worstPages = sorted.slice(0,3).map(p=>({slug:p.slug,score:p.overallScore,grade:p.grade}));
  const bestPages  = sorted.slice(-3).reverse().map(p=>({slug:p.slug,score:p.overallScore,grade:p.grade}));
  const topFindings = [];
  if (criticalCount>0)    topFindings.push(`${criticalCount} critical issue(s) across ${pages.length} pages`);
  if (mobileFailCount>0)  topFindings.push(`${mobileFailCount} of ${pages.length} pages not mobile-ready`);
  if (totalBrokenLinks>0) topFindings.push(`${totalBrokenLinks} broken link(s)`);
  if (warningCount>0)     topFindings.push(`${warningCount} warning(s) flagged`);
  if (topFindings.length===0) topFindings.push('No critical issues detected');
  return { pagesAudited:pages.length, averageScore:avgScore, grade, criticalIssues:criticalCount, warnings:warningCount, mobileFailures:mobileFailCount, mobilePassCount, httpOkCount, totalLinks, totalBrokenLinks, totalCTAs, headerVisibleCount, footerVisibleCount, logoCount, averageFirstContentfulPaint:{ms:avgFcp,formatted:msToSeconds(avgFcp),grade:fcpGrade(avgFcp)}, averageTTFB:{ms:avgTtfb,formatted:msToSeconds(avgTtfb),grade:ttfbGrade(avgTtfb)}, averageLoadTime:{ms:avgLoad,formatted:msToSeconds(avgLoad),grade:loadGrade(avgLoad)}, topFindings, allOpportunities, worstPages, bestPages };
}

function buildFormValidationSummary(pages) {
  const pagesWithForms = pages.filter(p=>p.forms.count>0);
  const totalForms = pagesWithForms.reduce((a,p)=>a+p.forms.count,0);
  const allForms   = pagesWithForms.flatMap(p=>p.forms.forms.map(f=>({...f,pageSlug:p.slug,pageUrl:p.url})));
  const issues = [];
  allForms.forEach(f => {
    if (!f.hasSubmitBtn)          issues.push({ severity:'warning',  page:f.pageSlug, message:'Form has no submit button.' });
    if (!f.browserValidationActive && f.fieldCount>1) issues.push({ severity:'info', page:f.pageSlug, message:'Browser validation not active.' });
    if (f.criticalMissingValidation.length>0) issues.push({ severity:'critical', page:f.pageSlug, message:`Missing critical validation: ${f.criticalMissingValidation.join(', ')}` });
  });
  return { totalPages:pagesWithForms.length, totalForms, stats:{ withSubmitButton:allForms.filter(f=>f.hasSubmitBtn).length, withEmailField:allForms.filter(f=>f.hasEmailField).length, withRequiredFields:allForms.filter(f=>f.hasRequiredFields).length, withBrowserValidation:allForms.filter(f=>f.browserValidationActive).length, withMissingValidation:allForms.filter(f=>f.criticalMissingValidation.length>0).length }, forms:allForms.map(f=>({page:f.pageSlug,pageUrl:f.pageUrl,fieldCount:f.fieldCount,purpose:f.purpose,hasSubmitBtn:f.hasSubmitBtn,hasEmailField:f.hasEmailField,hasRequiredFields:f.hasRequiredFields,browserValidationActive:f.browserValidationActive,criticalMissingValidation:f.criticalMissingValidation})), issues:issues.sort((a,b)=>({critical:0,warning:1,info:2}[a.severity]-({critical:0,warning:1,info:2}[b.severity]))) };
}

function buildUiUxIssues(pages) {
  const issues = [];
  pages.forEach(p => {
    const slug=p.slug, url=p.url;
    if (!p.layout.headerVisible) issues.push({ category:'Layout',        severity:'critical', page:slug, url, title:'Missing Header Navigation', description:`The page at ${slug} has no visible header or navigation bar. Users cannot navigate to other sections of the site, leading to high bounce rates and poor user experience.`, pageCount:1, affectedPages:[slug] });
    if (!p.layout.footerVisible) issues.push({ category:'Layout',        severity:'warning',  page:slug, url, title:'Missing Footer',            description:`No footer is visible on ${slug}. Footers provide essential links, legal information, and trust signals.`, pageCount:1, affectedPages:[slug] });
    if (!p.layout.logoDetected)  issues.push({ category:'Branding',      severity:'info',     page:slug, url, title:'No Logo Detected',          description:`The page ${slug} does not display a visible logo.`, pageCount:1, affectedPages:[slug] });
    if (p.layout.logoDetected && !p.layout.logoLinksHome) issues.push({ category:'Navigation',severity:'warning',page:slug,url,title:'Logo Does Not Link to Homepage',description:`The logo on ${slug} is visible but does not link back to the homepage.`,pageCount:1,affectedPages:[slug] });
    if (p.layout.ctaCount===0)   issues.push({ category:'Conversions',   severity:'warning',  page:slug, url, title:'No Call-to-Action Found',   description:`No CTA buttons or links were detected on ${slug}. Without clear calls to action, visitors have no guided path to convert.`, pageCount:1, affectedPages:[slug] });
    if (p.responsiveness.mobile?.details && !p.responsiveness.mobile.details.responsive) issues.push({ category:'Responsiveness',severity:'critical',page:slug,url,title:'Not Mobile Responsive',description:`The page ${slug} is not responsive at 375px mobile.`,pageCount:1,affectedPages:[slug] });
  });
  const grouped = {};
  issues.forEach(i => {
    if (!grouped[i.title]) grouped[i.title] = { ...i, affectedPages:[i.page] };
    else grouped[i.title].affectedPages.push(i.page);
  });
  const deduped = Object.values(grouped).map(g => ({ ...g, pageCount:g.affectedPages.length, description: g.affectedPages.length>1 ? `${g.description.split('.')[0]}. This issue affects ${g.affectedPages.length} pages: ${g.affectedPages.slice(0,4).join(', ')}${g.affectedPages.length>4?` and ${g.affectedPages.length-4} more`:''}.` : g.description })).sort((a,b)=>({critical:0,warning:1,info:2}[a.severity]??3)-({critical:0,warning:1,info:2}[b.severity]??3)||b.pageCount-a.pageCount);
  return { totalIssues:deduped.length, issues:deduped };
}

function buildReport(rawPages) {
  const transformed = rawPages.map(transformPage);
  const summary     = buildSummary(transformed);
  const domain      = (() => { try { return new URL(rawPages[0].url).hostname; } catch { return 'unknown'; } })();
  return {
    meta: { reportTitle:`Web Audit Report — ${domain}`, domain, generatedAt:new Date().toISOString(), auditedPages:transformed.length, tool:'SPCTEK Web Auditor', version:'1.0' },
    executiveSummary: {
      headline: summary.averageScore>=75 ? `Your site scores ${summary.averageScore}/100 — a solid foundation with clear wins available.` : `Your site scores ${summary.averageScore}/100 — meaningful improvements available.`,
      overallScore: summary.averageScore, grade: summary.grade,
      keyStats: [ {label:'Pages Audited',value:summary.pagesAudited,icon:'PA'}, {label:'Critical Issues',value:summary.criticalIssues,icon:'CI',highlight:summary.criticalIssues>0}, {label:'Warnings',value:summary.warnings,icon:'WN'}, {label:'Mobile Failures',value:summary.mobileFailures,icon:'MF',highlight:summary.mobileFailures>0}, {label:'Avg. FCP',value:summary.averageFirstContentfulPaint.formatted??'N/A',icon:'FCP',subLabel:summary.averageFirstContentfulPaint.grade?.label} ],
      performanceStats: { avgFCP:summary.averageFirstContentfulPaint, avgTTFB:summary.averageTTFB, avgLoadTime:summary.averageLoadTime },
      siteHealth: { httpOkCount:summary.httpOkCount, totalPages:summary.pagesAudited, totalLinks:summary.totalLinks, brokenLinks:summary.totalBrokenLinks, totalCTAs:summary.totalCTAs, headerFound:summary.headerVisibleCount, footerFound:summary.footerVisibleCount, logoFound:summary.logoCount, mobilePass:summary.mobilePassCount, mobileFail:summary.mobileFailures },
      topFindings:summary.topFindings, worstPages:summary.worstPages, bestPages:summary.bestPages, callToAction:'The issues identified are actionable improvements that can increase search rankings, improve user experience, and drive more conversions.',
    },
    pageBreakdown:         transformed,
    formValidationSummary: buildFormValidationSummary(transformed),
    uiUxIssues:            buildUiUxIssues(transformed),
    opportunitySummary: { title:'Growth Opportunities Identified', description:'Addressing these items can directly impact your search rankings, page speed, and user engagement.', items:summary.allOpportunities.map((opp,i)=>({id:i+1,opportunity:opp})) },
    categoryScorecard: { title:'How Your Site Performs by Category', categories:[
      { name:'Page Health',         description:'HTTP status, console errors, failed requests, and reliability',          score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.health,0)/transformed.length) },
      { name:'Page Speed',          description:'First Contentful Paint, TTFB, DOM ready, and total load time',           score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.speed,0)/transformed.length) },
      { name:'Resource Efficiency', description:'Page weight, resource count, slow assets, and image optimisation',       score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.resources,0)/transformed.length) },
      { name:'Mobile Experience',   description:'Responsiveness across mobile, tablet, and desktop viewports',            score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.mobile,0)/transformed.length) },
      { name:'Navigation & Links',  description:'Broken links, anchor integrity, and navigation health',                  score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.navigation,0)/transformed.length) },
      { name:'Layout & UX',         description:'Header, footer, logo, CTAs, and page structure completeness',           score:Math.round(transformed.reduce((a,p)=>a+p.categoryScores.layout,0)/transformed.length) },
    ].map(c=>({...c,grade:gradeFromScore(c.score)})) },
  };
}

module.exports = { buildReport };

if (require.main === module) {
  const inputArg = process.argv[2] || 'results.json';
  const inputPath = fs.existsSync(inputArg) ? inputArg : path.join('outputs','raw-json',inputArg);
  if (!fs.existsSync(inputPath)) { console.error(`❌  Not found: ${inputPath}`); process.exit(1); }
  const raw   = JSON.parse(fs.readFileSync(inputPath,'utf8'));
  const pages = Array.isArray(raw) ? raw : (raw.pages ?? [raw]);
  const report = buildReport(pages);
  fs.mkdirSync('outputs/report-json',{recursive:true});
  const out = 'outputs/report-json/report.json';
  fs.writeFileSync(out, JSON.stringify(report,null,2));
  console.log(`✅  Report written: ${out}`);
  console.log(`📊  Pages: ${report.meta.auditedPages}  Score: ${report.executiveSummary.overallScore}/100 (${report.executiveSummary.grade.grade})`);
  console.log(`🔴  Critical: ${report.executiveSummary.keyStats[1].value}  ⚠️  Warnings: ${report.executiveSummary.keyStats[2].value}`);
}