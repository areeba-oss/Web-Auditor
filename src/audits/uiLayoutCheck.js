'use strict';

/**
 * uiLayoutCheck.js — Layer 2 audit: UI & Layout Validation
 *
 * Strategy: ONE full-page screenshot per breakpoint → Claude Vision analyzes everything.
 * 3 screenshots total (mobile / tablet / desktop) — no scrolling, no separate footer shot.
 *
 * Checks per breakpoint:
 *   1. Header visible & intact
 *   2. Footer visible (now always in frame — fullPage screenshot)
 *   3. CTA buttons present & visible
 *   4. Logo visible & clickable
 *   5. Horizontal overflow — DOM check (objective pixel measurement)
 *   6. Mobile nav (hamburger) on small screens — AI vision
 */

const { URL } = require('url');

// ─── Breakpoints ──────────────────────────────────────────────────────────────

const BREAKPOINTS = [
  { name: 'mobile',  width: 375,  height: 812  },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'desktop', width: 1440, height: 900  },
];

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHTS = {
  header:       20,
  footer:       10,
  cta:          25,
  logo:         15,
  logoLink:     10,
  noOverflow:   10,
  mobileNav:     5,
  layoutIntact:  5,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// ─── DOM: overflow check — objective pixel measurement ───────────────────────

async function checkOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 5
  );
}

// ─── DOM: logo link check — AI can't follow actual href values ───────────────

async function checkLogoLink(page, homepageOrigin) {
  return page.evaluate((origin) => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }
    function linksToHome(el) {
      const link = el.tagName === 'A' ? el : el.closest('a');
      if (!link) return { found: false };
      try {
        const u = new URL(link.href);
        return { found: true, href: link.href, linksHome: (u.pathname === '/' || u.pathname === '') && u.origin === origin };
      } catch { return { found: false }; }
    }
    function isLogoSized(el) {
      const r = el.getBoundingClientRect();
      return r.width >= 40 && r.height <= 120
        && !(r.width < 50 && r.height < 50 && Math.abs(r.width - r.height) < 10);
    }
    function hasLogoSignal(el) {
      const txt = [el, ...el.querySelectorAll('*')]
        .map(n => (n.className||'') + ' ' + (n.id||'') + ' ' + (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('alt')||''))
        .join(' ').toLowerCase();
      return /logo|brand|site-?name|wordmark|site-?logo/.test(txt);
    }
    const header = document.querySelector('header') || document.querySelector('[role="banner"]') || document.querySelector('nav');
    if (!header) return { found: false, href: null, linksHome: false };
    // Strategy 1: explicit logo/brand class signal
    for (const a of Array.from(header.querySelectorAll('a')).filter(a => isVisible(a) && hasLogoSignal(a))) {
      const r = linksToHome(a); if (r.found) return { ...r, method: 'class-signal' };
    }
    // Strategy 2: logo-sized img/svg link (filters cart 30x30, search 24x24)
    const imgLinks = Array.from(header.querySelectorAll('a:has(img), a:has(svg)'))
      .filter(a => isVisible(a) && isLogoSized(a))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    for (const a of imgLinks) {
      const r = linksToHome(a); if (r.found) return { ...r, method: 'first-img-link' };
    }
    // Strategy 3: first leftmost text link (wordmark logos)
    const textLinks = Array.from(header.querySelectorAll('a'))
      .filter(a => { const t = (a.innerText||'').trim(); return isVisible(a) && t.length > 0 && t.length <= 40 && isLogoSized(a); })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    for (const a of textLinks.slice(0, 2)) {
      const r = linksToHome(a); if (r.found) return { ...r, method: 'first-text-link' };
    }
    return { found: false, href: null, linksHome: false };
  }, homepageOrigin);
}

// ─── DOM UI audit — primary engine (AI-free) ─────────────────────────────────

async function domAuditAtBreakpoint(page, bp) {
  return page.evaluate((viewport) => {
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }
    // Header
    const headerEl = document.querySelector('header') || document.querySelector('[role="banner"]')
      || document.querySelector('nav') || document.querySelector('[class*="header"]') || document.querySelector('[id*="header"]');
    const headerVisible = headerEl ? isVisible(headerEl) : false;
    // Footer
    const footerEl = document.querySelector('footer') || document.querySelector('[role="contentinfo"]')
      || document.querySelector('[class*="footer"]') || document.querySelector('[id*="footer"]');
    const footerVisible = footerEl ? isVisible(footerEl) : false;
    // Logo — same 3-strategy logic as checkLogoLink to avoid false positives
    // header img/svg alone is too broad — cart/search/flag icons live there too
    function isLogoSized(el) {
      const r = el.getBoundingClientRect();
      // Real logos: wide (>=40px), not too tall (<=120px), not a tiny square icon
      return r.width >= 40 && r.height <= 120
        && !(r.width < 50 && r.height < 50 && Math.abs(r.width - r.height) < 10);
    }
    function hasLogoSignal(el) {
      const txt = [el, ...el.querySelectorAll('*')]
        .map(n => (n.className||'') + ' ' + (n.id||'') + ' ' +
          (n.getAttribute('aria-label')||'') + ' ' + (n.getAttribute('alt')||''))
        .join(' ').toLowerCase();
      return /logo|brand|site-?name|wordmark|site-?logo/.test(txt);
    }
    const headerForLogo = document.querySelector('header')
      || document.querySelector('[role="banner"]')
      || document.querySelector('nav');

    let logoEl = null;
    if (headerForLogo) {
      // Strategy 1: explicit logo/brand class, id, aria, or alt signal
      logoEl = Array.from(headerForLogo.querySelectorAll('*'))
        .find(el => isVisible(el) && hasLogoSignal(el)) || null;

      // Strategy 2: logo-sized img/svg (filters cart 28x28, search 24x24, flags 20x20)
      if (!logoEl) {
        logoEl = Array.from(headerForLogo.querySelectorAll('img, svg'))
          .filter(el => isVisible(el) && isLogoSized(el))
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
      }

      // Strategy 3: leftmost logo-sized link containing img/svg
      if (!logoEl) {
        logoEl = Array.from(headerForLogo.querySelectorAll('a'))
          .filter(el => isVisible(el) && isLogoSized(el) && el.querySelector('img, svg'))
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
      }
    }
    const logoVisible = logoEl ? isVisible(logoEl) : false;
    // Mobile nav
    const isMobile = viewport.width <= 768;
    let hamburgerVisible = false;
    if (isMobile) {
      const sels = ['[class*="hamburger"]','[class*="burger"]','[class*="menu-toggle"]','[class*="nav-toggle"]',
        '[aria-label*="menu" i]','[aria-label*="navigation" i]','button[class*="menu"]','[class*="MenuToggle"]','[data-testid*="menu"]'];
      for (const sel of sels) {
        try { const el = document.querySelector(sel); if (el && isVisible(el)) { hamburgerVisible = true; break; } } catch {}
      }
      if (!hamburgerVisible) {
        hamburgerVisible = Array.from(document.querySelectorAll('header button, nav button')).some(btn => {
          if (!isVisible(btn)) return false;
          const r = btn.getBoundingClientRect();
          return btn.querySelectorAll('span, div, i').length >= 2 && r.width < 60 && r.height < 60;
        });
      }
    }
    const brokenImages = Array.from(document.images || []).filter((img) => {
      const visible = isVisible(img);
      return visible && img.complete && img.naturalWidth === 0;
    }).length;

    const overlappingSticky = Array.from(document.querySelectorAll('*')).filter((el) => {
      const s = window.getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') return false;
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const vpArea = window.innerWidth * window.innerHeight;
      return area > vpArea * 0.35;
    }).length;

    const generalIssues = [];
    if (brokenImages > 0) generalIssues.push(`${brokenImages} visibly broken image(s)`);
    if (overlappingSticky > 0) generalIssues.push('Large sticky/fixed overlay may block page content');

    return {
      header:    { visible: headerVisible,  description: headerVisible  ? 'Header detected (DOM)'  : 'No header element found',  issue: headerVisible  ? null : 'No header/nav element' },
      footer:    { visible: footerVisible,  description: footerVisible  ? 'Footer detected (DOM)'  : 'No footer element found',  issue: footerVisible  ? null : 'No footer element' },
      logo:      { visible: logoVisible,    description: logoVisible    ? 'Logo detected (DOM)'    : 'No logo element found',    issue: logoVisible    ? null : 'No logo element', appearsClickable: false },
      overflow:  { detected: false, description: null },
      mobileNav: { applicable: isMobile, hamburgerVisible: isMobile ? hamburgerVisible : false,
        description: isMobile ? (hamburgerVisible ? 'Mobile nav toggle found' : 'No hamburger found') : null,
        issue: isMobile && !hamburgerVisible ? 'No mobile nav toggle detected' : null },
      generalIssues,
      _fallback: true,
    };
  }, bp);
}

// ─── Rule-based CTA classification — fallback when no API key ─────────────────

function classifyCTAsWithRules(elements) {
  if (!elements || elements.length === 0)
    return { found: false, count: 0, examples: [], issue: 'No interactive elements found' };

  const STRONG = /^(get started|start now|start free|sign up|register|subscribe|buy now|purchase|shop now|order now|book now|book a demo|schedule a demo|request demo|request a quote|get a quote|contact sales|try free|free trial|download now|install now|create account|join now|claim offer|apply now|try it free|get started free|see demo|watch demo|talk to us|speak to sales)$/i;
  const ACTION = /(sign up|get started|start|subscribe|buy|purchase|book|schedule|request|download|install|create account|join|claim|try free|free trial|demo|get quote|contact sales|talk to|speak to)/i;
  const EXCLUDE = /^(home|about|services|products|solutions|blog|news|faq|help|support|docs|documentation|login|log in|sign in|privacy|terms|cookies|sitemap|careers|jobs|team|menu|close|back|next|previous|search|share|read more|see more|load more|scroll|top|skip|go to|×|☰|←|→)$/i;

  const ctas = elements.filter(el => {
    const t = el.text.trim();
    if (EXCLUDE.test(t) || t.length > 60) return false;
    if (STRONG.test(t)) return true;
    if (ACTION.test(t) && (el.tag === 'button' || el.tag === 'role-button' || el.tag === 'input')) return true;
    if (ACTION.test(t) && el.region === 'body' && el.tag === 'a') return true;
    return false;
  });

  return { found: ctas.length > 0, count: ctas.length, examples: ctas.slice(0, 6).map(e => e.text),
    issue: ctas.length === 0 ? 'No CTA buttons detected — users may not know what action to take' : null, _fallback: true };
}

// ─── DOM: Extract all interactive elements for CTA classification ─────────────

async function extractInteractiveElements(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }
    const elements = [], seen = new Set();
    document.querySelectorAll('button').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
      if (!text || text.length < 2 || seen.has(text)) return;
      seen.add(text);
      elements.push({ text, tag: 'button', region: el.closest('nav, header') ? 'nav' : 'body' });
    });
    document.querySelectorAll('a[href]').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (!text || text.length < 2 || seen.has(text)) return;
      seen.add(text);
      elements.push({ text, tag: 'a', region: el.closest('header, nav') ? 'nav' : el.closest('footer') ? 'footer' : 'body' });
    });
    document.querySelectorAll('input[type="submit"], input[type="button"]').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.value || el.getAttribute('aria-label') || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      elements.push({ text, tag: 'input', region: 'body' });
    });
    document.querySelectorAll('[role="button"]').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (!text || text.length < 2 || seen.has(text)) return;
      seen.add(text);
      elements.push({ text, tag: 'role-button', region: 'body' });
    });
    return elements.slice(0, 80);
  });
}

// ─── Aggregate AI results → score + issues ───────────────────────────────────

function aggregateResults(bpAnalyses, logoLinkResult) {
  const issues = [];
  let score = 100;

  const byName = {};
  for (const a of bpAnalyses) byName[a.breakpoint] = a;

  const desktop = byName.desktop?.ai;
  const mobile  = byName.mobile?.ai;

  // ── Header ─────────────────────────────────────────────────────────────────
  const headerBroken = bpAnalyses.filter((a) => a.ai && !a.ai.header?.visible).map((a) => a.breakpoint);
  if (headerBroken.length > 0) {
    const penalty = Math.round(WEIGHTS.header * (headerBroken.length / bpAnalyses.length));
    score -= penalty;
    issues.push({
      type: headerBroken.length === 3 ? 'critical' : 'warning',
      code: 'HEADER_MISSING',
      message: `Header not visible at: ${headerBroken.join(', ')}`,
      breakpoints: headerBroken,
    });
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  const footerBroken = bpAnalyses.filter((a) => a.ai && !a.ai.footer?.visible).map((a) => a.breakpoint);
  if (footerBroken.length >= 2) {
    score -= WEIGHTS.footer;
    issues.push({
      type: 'warning',
      code: 'FOOTER_MISSING',
      message: `Footer not found at: ${footerBroken.join(', ')}`,
      breakpoints: footerBroken,
    });
  }

  // ── CTA ────────────────────────────────────────────────────────────────────
  const desktopCTA = desktop?.ctas;
  const mobileCTA  = mobile?.ctas;
  const ctaMissingBps = bpAnalyses.filter((a) => !a.ai?.ctas?.found).map((a) => a.breakpoint);

  if (ctaMissingBps.length === bpAnalyses.length) {
    score -= WEIGHTS.cta;
    issues.push({
      type: 'warning',
      code: 'NO_CTA_FOUND',
      message: 'No CTA buttons detected on any breakpoint — users may not know what action to take',
    });
  } else if (desktopCTA?.found && !mobileCTA?.found) {
    score -= 10;
    issues.push({
      type: 'warning',
      code: 'CTA_HIDDEN_MOBILE',
      message: `CTAs on desktop (${(desktopCTA.examples || []).join(', ')}) but none on mobile`,
    });
  }

  // ── Logo ───────────────────────────────────────────────────────────────────
  const logoVisible = desktop?.logo?.visible ?? false;
  const logoLink    = logoLinkResult;

  if (!logoVisible) {
    score -= WEIGHTS.logo;
    issues.push({ type: 'warning', code: 'LOGO_NOT_FOUND', message: desktop?.logo?.issue || 'Logo not detected on desktop' });
  } else {
    if (!logoLink?.found) {
      score -= Math.round(WEIGHTS.logoLink * 0.6);
      issues.push({ type: 'info', code: 'LOGO_NOT_CLICKABLE', message: 'Logo visible but not wrapped in a link — users expect clicking it to go home' });
    } else if (!logoLink.linksHome) {
      score -= Math.round(WEIGHTS.logoLink * 0.3);
      issues.push({ type: 'info', code: 'LOGO_WRONG_LINK', message: `Logo link doesn't point to homepage root (href: ${logoLink.href?.slice(0, 60)})` });
    }

    if (!(mobile?.logo?.visible)) {
      score -= 5;
      issues.push({ type: 'warning', code: 'LOGO_HIDDEN_MOBILE', message: 'Logo visible on desktop but not found on mobile viewport' });
    }
  }

  // ── Overflow ───────────────────────────────────────────────────────────────
  const overflowBps = bpAnalyses.filter((a) => a.domOverflow).map((a) => a.breakpoint);
  if (overflowBps.length > 0) {
    score -= Math.round(WEIGHTS.noOverflow * (overflowBps.length / bpAnalyses.length));
    issues.push({
      type: overflowBps.includes('mobile') ? 'critical' : 'warning',
      code: 'HORIZONTAL_OVERFLOW',
      message: `Horizontal scroll at: ${overflowBps.join(', ')} — layout broken`,
      breakpoints: overflowBps,
    });
  }

  // ── Mobile nav ─────────────────────────────────────────────────────────────
  const mobileNav = mobile?.mobileNav;
  if (mobileNav?.applicable && !mobileNav?.hamburgerVisible) {
    score -= WEIGHTS.mobileNav;
    issues.push({ type: 'warning', code: 'MOBILE_NAV_MISSING', message: mobileNav.issue || 'No hamburger/mobile nav toggle detected on 375px viewport' });
  }

  // ── AI general observations ────────────────────────────────────────────────
  for (const a of bpAnalyses) {
    for (const gi of (a.ai?.generalIssues ?? [])) {
      if (gi) issues.push({ type: 'info', code: 'AI_OBSERVATION', message: `[${a.breakpoint}] ${gi}` });
    }
  }

  score = Math.max(0, score);
  const criticals = issues.filter((i) => i.type === 'critical');
  const warnings  = issues.filter((i) => i.type === 'warning');

  return {
    score,
    overallStatus: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
    issues,
    details: {
      header:   Object.fromEntries(bpAnalyses.map((a) => [a.breakpoint, a.ai?.header ?? null])),
      footer:   Object.fromEntries(bpAnalyses.map((a) => [a.breakpoint, a.ai?.footer ?? null])),
      cta:      Object.fromEntries(bpAnalyses.map((a) => [a.breakpoint, a.ai?.ctas   ?? null])),
      logo: {
        ...(desktop?.logo ?? {}),
        linkFound:   logoLink?.found    ?? false,
        linksToHome: logoLink?.linksHome ?? false,
        href:        logoLink?.href     ?? null,
      },
      overflow:  { hasOverflow: overflowBps.length > 0, breakpoints: overflowBps },
      mobileNav: mobileNav ?? {},
    },
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function auditUILayout(context, url, homepageUrl, timeout = 20_000) {
  const page = await context.newPage();
  const homepageOrigin = getOrigin(homepageUrl || url);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    const httpStatus = response?.status() ?? null;

    if (!httpStatus || httpStatus >= 400) {
      return {
        url, httpStatus, overallStatus: 'critical', score: 0,
        issues: [{ type: 'critical', code: 'PAGE_LOAD_FAILED', message: `HTTP ${httpStatus}` }],
        breakpointResults: [], details: {},
      };
    }

    try {
      await page.waitForFunction(
        () => (document.body?.innerText?.trim().length ?? 0) > 100,
        { timeout: 5_000 },
      );
    } catch {}

    // ── Per-breakpoint: DOM-only layout and CTA audit (AI-free) ───────────────
    const bpAnalyses = [];
    let logoLinkResult = { found: false, href: null, linksHome: false };

    for (const bp of BREAKPOINTS) {
      console.log(`   🔎 ${bp.name} (${bp.width}px) — DOM audit...`);
      try {
        await page.setViewportSize({ width: bp.width, height: bp.height });
        await page.waitForTimeout(350);

        const domOverflow = await checkOverflow(page);
        const elements = await extractInteractiveElements(page);
        const ctaResult = classifyCTAsWithRules(elements);
        const ai = await domAuditAtBreakpoint(page, bp);
        ai.ctas = ctaResult;

        if (bp.name === 'desktop') {
          logoLinkResult = await checkLogoLink(page, homepageOrigin);
        }

        const h = ai.header?.visible        ? '✅' : '❌';
        const f = ai.footer?.visible        ? '✅' : '❌';
        const l = ai.logo?.visible          ? '✅' : '❌';
        const c = ai.ctas?.found            ? '✅' : '❌';
        const n = bp.name === 'mobile' ? (ai.mobileNav?.hamburgerVisible ? '✅' : '❌') : '—';
        console.log(`      [DOM] header:${h} footer:${f} logo:${l} cta:${c} mobileNav:${n}`);

        bpAnalyses.push({ breakpoint: bp.name, width: bp.width, ai, domOverflow });
      } catch (err) {
        const ai = {
          header: { visible: false, description: null, issue: 'DOM audit failed at this breakpoint' },
          footer: { visible: false, description: null, issue: 'DOM audit failed at this breakpoint' },
          logo: { visible: false, description: null, issue: 'DOM audit failed at this breakpoint', appearsClickable: false },
          mobileNav: { applicable: bp.width <= 768, hamburgerVisible: false, description: null, issue: 'DOM audit failed at this breakpoint' },
          generalIssues: [`DOM audit error: ${err.message}`],
          ctas: { found: false, count: 0, examples: [], issue: 'DOM audit failed at this breakpoint' },
          _fallback: true,
        };
        console.warn(`      ⚠️  DOM audit failed: ${err.message}`);
        bpAnalyses.push({ breakpoint: bp.name, width: bp.width, ai, domOverflow: false });
      }
    }

    const analysis = aggregateResults(bpAnalyses, logoLinkResult);
    return { url, httpStatus, ...analysis, breakpointResults: bpAnalyses };

  } catch (err) {
    return {
      url, httpStatus: null, overallStatus: 'critical', score: 0,
      issues: [{ type: 'critical', code: 'AUDIT_FATAL', message: `UI check crashed: ${err.message}` }],
      breakpointResults: [], details: {}, fatalError: err.message,
    };
  } finally {
    await page.close();
  }
}

module.exports = { auditUILayout };