/**
 * pages.js — Full-page HTML sections: cover, executive summary,
 *            scorecard, opportunities, page breakdown, form validation,
 *            UI/UX issues, and closing.
 */

const path = require('path');
const { scoreRing, categoryBar, pageCard, pageHeaderBar, pageFooterBar } = require('./components');

// Populated by initCoverImage() before first render
let coverImageDataUri = '';

/**
 * Loads and resizes cover.jpg to A4 (794 × 1123 px) before embedding as base64.
 * Must be awaited once before buildReportHTML() is called.
 */
async function initCoverImage() {
  try {
    const sharp = require('sharp');
    const imgPath = path.join(__dirname, '../../cover.jpg');
    const imgBuffer = await sharp(imgPath)
      .resize(794, 1123, { fit: 'fill' })
      .jpeg({ quality: 88 })
      .toBuffer();
    coverImageDataUri = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');
    console.log(
      `🖼️  Cover image embedded (${(imgBuffer.length / 1024).toFixed(0)} KB after resize)`,
    );
  } catch (e) {
    console.warn(
      '⚠️  cover.jpg could not be loaded/resized — cover will use fallback styling.',
      e.message,
    );
  }
}

// ─── Cover Page (SPCTEK image + audit title overlay) ──────────────────────

function coverPage(meta, executiveSummary, generatedDate) {
  const imgTag = coverImageDataUri
    ? `<img src="${coverImageDataUri}" class="cover-bg-image" alt="SPCTEK Cover" />`
    : `<div class="cover-bg-fallback"></div>`;

  return `
<div class="pdf-page cover-page">
  <div class="cover-image-wrap">
    ${imgTag}
 <div class="flex-box">
    <div class="wrapper">
      <h1 class="mainPageHeading">Website Audit Report</h1>
      <h5 class="mainText">A comprehensive breakdown of your website’s performance, usability, functionality, and user experience.<br><a style="color: #0000FF; text-decoration: underline;" href="https://${meta.domain}/" target="_blank">https://${meta.domain}/</a></h5></div>
    </div>
  </div></div>
</div>`;
}

// ─── Executive Summary Page ──────────────────────────────────────────────────

function executiveSummaryPage(meta, summary, generatedDate) {
  const { siteHealth, performanceStats, worstPages, bestPages } = summary;

  const statItems = [
    {
      icon: 'HTTP',
      val: siteHealth.httpOkCount + '/' + siteHealth.totalPages,
      label: 'Pages OK',
      sub: '',
    },
    {
      icon: 'FCP',
      val: performanceStats.avgFCP.formatted ?? 'N/A',
      label: 'Avg FCP',
      sub: performanceStats.avgFCP.grade?.label || '',
    },
    {
      icon: 'LNK',
      val: siteHealth.totalLinks,
      label: 'Total Links',
      sub: siteHealth.brokenLinks > 0 ? siteHealth.brokenLinks + ' broken' : 'All healthy',
    },
    {
      icon: 'MOB',
      val: siteHealth.mobilePass + '/' + siteHealth.totalPages,
      label: 'Mobile-Ready',
      sub: siteHealth.mobileFail > 0 ? siteHealth.mobileFail + ' failing' : '',
    },
    { icon: 'CTA', val: siteHealth.totalCTAs, label: 'CTAs Found', sub: '' },
    {
      icon: 'TTFB',
      val: performanceStats.avgTTFB.formatted ?? 'N/A',
      label: 'Avg TTFB',
      sub: performanceStats.avgTTFB.grade?.label || '',
    },
    {
      icon: 'LOAD',
      val: performanceStats.avgLoadTime.formatted ?? 'N/A',
      label: 'Avg Load Time',
      sub: performanceStats.avgLoadTime.grade?.label || '',
    },
    {
      icon: 'HDR',
      val: siteHealth.headerFound + '/' + siteHealth.totalPages,
      label: 'Header Visible',
      sub: '',
    },
  ];

  const statsHTML = statItems
    .map(
      (s) => `
    <div class="exec-stat-card">
      <span class="esc-icon">${s.icon}</span>
      <div>
        <div class="esc-val">${s.val}</div>
        <div class="esc-label">${s.label}</div>
        ${s.sub ? `<div class="esc-sub" style="color: ${s.sub.includes('broken') || s.sub.includes('failing') ? 'var(--red)' : 'var(--green)'}">${s.sub}</div>` : ''}
      </div>
    </div>`,
    )
    .join('');

  const bestHTML = (bestPages || [])
    .map(
      (p) => `
    <div class="bw-item best">
      <span class="bw-slug">${p.slug}</span>
      <span class="bw-score" style="color:${p.grade.color}">${p.score}</span>
    </div>`,
    )
    .join('');

  const worstHTML = (worstPages || [])
    .map(
      (p) => `
    <div class="bw-item worst">
      <span class="bw-slug">${p.slug}</span>
      <span class="bw-score" style="color:${p.grade.color}">${p.score}</span>
    </div>`,
    )
    .join('');

  return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header">
    <div class="section-eyebrow">Executive Summary</div>
    <h2 class="section-title">Your Site at a Glance</h2>
    <p class="section-sub">Key metrics aggregated from ${meta.auditedPages} audited pages</p>
  </div>
  <div class="exec-summary-body">
    <p class="exec-headline">${summary.headline}</p>
    <div class="exec-grid">${statsHTML}</div>
    <div class="best-worst-row">
      <div>
        <div class="bw-col-title">Top Performing Pages</div>
        ${bestHTML}
      </div>
      <div>
        <div class="bw-col-title">Pages Needing Attention</div>
        ${worstHTML}
      </div>
    </div>
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'Executive Summary')}
</div>`;
}

// ─── Scorecard + Opportunities (Combined Page) ─────────────────────────────

function scorecardAndOpportunitiesPage(meta, categoryScorecard, opportunitySummary, generatedDate) {
  const categories = categoryScorecard.categories
    .map((c) => categoryBar(c.name, c.description, c.score, c.grade))
    .join('');

  const MAX_ITEMS = 8;
  const allItems = opportunitySummary.items || [];
  const visible = allItems.slice(0, MAX_ITEMS);
  const remaining = allItems.length - visible.length;

  const items = visible
    .map(
      (item) => `
    <div class="opp-summary-item compact">
      <span class="opp-num">${String(item.id).padStart(2, '0')}</span>
      <div class="opp-content">
        <span class="opp-text">${item.opportunity}</span>
      </div>
    </div>`,
    )
    .join('');

  const overflowNote =
    remaining > 0 ? `<div class="opp-overflow">+ ${remaining} more identified</div>` : '';

  return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">Performance Overview</div>
    <h2 class="section-title">${categoryScorecard.title}</h2>
    <p class="section-sub">Scored across ${categoryScorecard.categories.length} categories from ${meta.auditedPages} pages</p>
  </div>
  <div class="scorecard-body compact">
    ${categories}
  </div>
  <div class="combined-divider"></div>
  <div class="section-header compact inline">
    <div class="section-eyebrow">Quick Wins</div>
    <h2 class="section-title">${opportunitySummary.title}</h2>
  </div>
  <div class="opp-section-body compact">
    <div class="opp-summary-list">
      ${items}
    </div>
    ${overflowNote}
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'Scorecard & Opportunities')}
</div>`;
}

// ─── Page Breakdown Pages ────────────────────────────────────────────────────
//  Groups page cards into PDF pages (2 per page for compact layout).

function pageBreakdownPages(meta, pageBreakdown, generatedDate, maxPages = 6) {
  const CARDS_PER_PAGE = 3;

  // Sort by score ascending (worst first) and take top N
  const worstPages = [...pageBreakdown]
    .sort((a, b) => a.overallScore - b.overallScore)
    .slice(0, maxPages);

  const chunks = [];
  for (let i = 0; i < worstPages.length; i += CARDS_PER_PAGE) {
    chunks.push(worstPages.slice(i, i + CARDS_PER_PAGE));
  }

  return chunks
    .map((chunk, ci) => {
      const cards = chunk.map((page, j) => pageCard(page, ci * CARDS_PER_PAGE + j)).join('');
      const pageNum = `Pages ${ci * CARDS_PER_PAGE + 1}–${Math.min((ci + 1) * CARDS_PER_PAGE, worstPages.length)} of ${worstPages.length} (lowest scoring)`;

      return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">Detailed Analysis</div>
    <h2 class="section-title">Pages Needing Most Attention</h2>
    <p class="section-sub">${pageNum} — sorted by lowest score from ${pageBreakdown.length} total pages audited</p>
  </div>
  <div class="pages-body compact">
    ${cards}
  </div>
  ${pageFooterBar(meta.tool, meta.version, pageNum)}
</div>`;
    })
    .join('\n');
}

// ─── Form Validation Page (single page) ─────────────────────────────────────

function formValidationPages(meta, formValidation, generatedDate) {
  if (!formValidation || formValidation.totalForms === 0) {
    return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">Form Analysis</div>
    <h2 class="section-title">Form Validation Audit</h2>
    <p class="section-sub">No forms were detected across ${meta.auditedPages} audited pages</p>
  </div>
  <div class="form-section-body">
    <div class="form-empty-state">
      <div class="form-empty-icon">📋</div>
      <div class="form-empty-text">No forms were found on any of the audited pages. If your site uses forms, they may be dynamically loaded or behind authentication.</div>
    </div>
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'Form Validation')}
</div>`;
  }

  const { stats, forms, issues } = formValidation;

  // Summary stats cards
  const statsHTML = `
    <div class="form-stats-grid">
      <div class="form-stat-card">
        <div class="form-stat-val">${formValidation.totalForms}</div>
        <div class="form-stat-label">Total Forms</div>
      </div>
      <div class="form-stat-card">
        <div class="form-stat-val">${formValidation.totalPages}</div>
        <div class="form-stat-label">Pages with Forms</div>
      </div>
      <div class="form-stat-card ${stats.withBrowserValidation < formValidation.totalForms ? 'warn' : ''}">
        <div class="form-stat-val">${stats.withBrowserValidation}/${formValidation.totalForms}</div>
        <div class="form-stat-label">Browser Validation</div>
      </div>
      <div class="form-stat-card ${stats.withSubmitButton < formValidation.totalForms ? 'warn' : ''}">
        <div class="form-stat-val">${stats.withSubmitButton}/${formValidation.totalForms}</div>
        <div class="form-stat-label">Submit Button</div>
      </div>
      <div class="form-stat-card">
        <div class="form-stat-val">${stats.withRequiredFields}/${formValidation.totalForms}</div>
        <div class="form-stat-label">Required Fields</div>
      </div>
      <div class="form-stat-card ${stats.withMissingValidation > 0 ? 'critical' : ''}">
        <div class="form-stat-val">${stats.withMissingValidation}</div>
        <div class="form-stat-label">Missing Validation</div>
      </div>
    </div>`;

  // Individual form cards
  const formCards = forms
    .slice(0, 8)
    .map((f) => {
      const statusChecks = [
        { label: 'Submit', ok: f.hasSubmitBtn },
        { label: 'Email', ok: f.hasEmailField },
        { label: 'Required', ok: f.hasRequiredFields },
        { label: 'Validation', ok: f.browserValidationActive },
      ];
      const checksHTML = statusChecks
        .map(
          (c) =>
            `<span class="form-check ${c.ok ? 'pass' : 'fail'}">${c.ok ? '✓' : '✕'} ${c.label}</span>`,
        )
        .join('');

      return `
      <div class="form-card">
        <div class="form-card-header">
          <span class="form-card-page">${f.page}</span>
          <span class="form-card-fields">${f.fieldCount} field${f.fieldCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="form-card-checks">${checksHTML}</div>
      </div>`;
    })
    .join('');

  // Issues list (compact, inline with form cards)
  const issuesHTML = issues
    .slice(0, 5)
    .map(
      (issue) => `
    <div class="form-issue-item ${issue.severity}">
      <span class="form-issue-badge ${issue.severity}">${issue.severity.toUpperCase()}</span>
      <div class="form-issue-content">
        <span class="form-issue-page">${issue.page}</span>
        <span class="form-issue-msg">${issue.message}</span>
      </div>
    </div>`,
    )
    .join('');

  const issuesSection =
    issues.length > 0
      ? `<div class="form-issues-divider"></div>
       <div class="form-cards-label">Issues Found</div>
       <div class="form-issues-list compact">${issuesHTML}</div>
       ${issues.length > 5 ? `<div class="form-overflow">+ ${issues.length - 5} more issue(s)</div>` : ''}`
      : '';

  return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">Form Analysis</div>
    <h2 class="section-title">Form Validation Audit</h2>
    <p class="section-sub">${formValidation.totalForms} form(s) found across ${formValidation.totalPages} page(s)</p>
  </div>
  <div class="form-section-body">
    ${statsHTML}
    <div class="form-cards-label">Form Details</div>
    <div class="form-cards-grid">
      ${formCards}
    </div>
    ${issuesSection}
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'Form Validation')}
</div>`;
}

// ─── UI/UX Issues Pages (2 pages, 2 issues each) ───────────────────────────

function uiUxPages(meta, uiUxIssues, generatedDate, maxImages = 4) {
  if (!uiUxIssues || uiUxIssues.totalIssues === 0) {
    return `
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">UI / UX Review</div>
    <h2 class="section-title">User Interface & Experience</h2>
    <p class="section-sub">No significant UI/UX issues detected across ${meta.auditedPages} pages</p>
  </div>
  <div class="uiux-section-body">
    <div class="form-empty-state">
      <div class="form-empty-icon">🎨</div>
      <div class="form-empty-text">All audited pages passed UI/UX checks. Headers, footers, logos, CTAs, and responsive layouts are functioning correctly.</div>
    </div>
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'UI/UX Review')}
</div>`;
  }

  const ISSUES_PER_PAGE = 2;
  const TOTAL_PAGES = Math.max(1, Math.ceil(maxImages / ISSUES_PER_PAGE));
  const allIssues = uiUxIssues.issues.slice(0, maxImages);

  const pages = [];
  for (let p = 0; p < TOTAL_PAGES; p++) {
    const start = p * ISSUES_PER_PAGE;
    const chunk = allIssues.slice(start, start + ISSUES_PER_PAGE);
    const pageNum = p + 1;

    const issueCards = chunk
      .map((issue) => {
        const severityColor =
          issue.severity === 'critical'
            ? 'var(--red)'
            : issue.severity === 'warning'
              ? 'var(--yellow)'
              : 'var(--accent)';

        return `
      <div class="uiux-issue-card">
        <div class="uiux-issue-header">
          <span class="uiux-severity-badge" style="color:${severityColor}; border-color:${severityColor}">${issue.severity.toUpperCase()}</span>
          <span class="uiux-issue-category">${issue.category}</span>
          <span class="uiux-issue-pages">${issue.pageCount} page${issue.pageCount !== 1 ? 's' : ''} affected</span>
        </div>
        <h3 class="uiux-issue-title">${issue.title}</h3>
        <p class="uiux-issue-desc">${issue.description}</p>
        <div class="uiux-screenshot-placeholder">
          <div class="uiux-screenshot-label">📷 Screenshot – Insert manually</div>
        </div>
      </div>`;
      })
      .join('');

    // If fewer than 2 issues on this page, add empty screenshot space
    const emptySlots = ISSUES_PER_PAGE - chunk.length;
    const emptyCards =
      emptySlots > 0 && chunk.length > 0
        ? Array(emptySlots)
            .fill(
              `
      <div class="uiux-issue-card empty">
        <div class="uiux-screenshot-placeholder large">
          <div class="uiux-screenshot-label">📷 Additional Screenshot Space</div>
        </div>
      </div>`,
            )
            .join('')
        : emptySlots === ISSUES_PER_PAGE
          ? `
      <div class="uiux-additional-space">
        <div class="uiux-screenshot-placeholder full-page">
          <div class="uiux-screenshot-label">📷 Additional Screenshots & Notes</div>
        </div>
      </div>`
          : '';

    pages.push(`
<div class="pdf-page">
  ${pageHeaderBar(meta.tool, meta.domain, generatedDate)}
  <div class="section-header compact">
    <div class="section-eyebrow">UI / UX Review</div>
    <h2 class="section-title">User Interface & Experience Issues</h2>
    <p class="section-sub">Page ${pageNum} of ${TOTAL_PAGES} — ${Math.min(uiUxIssues.totalIssues, maxImages)} issues shown across ${meta.auditedPages} pages</p>
  </div>
  <div class="uiux-section-body">
    ${issueCards}
    ${emptyCards}
  </div>
  ${pageFooterBar(meta.tool, meta.version, 'UI/UX Review ' + pageNum + '/' + TOTAL_PAGES)}
</div>`);
  }

  return pages.join('\n');
}

// ─── Closing Page ────────────────────────────────────────────────────────────

function closingPage(meta, executiveSummary) {
  const criticals = executiveSummary.keyStats[1]?.value ?? 0;
  const warnings = executiveSummary.keyStats[2]?.value ?? 0;
  const mobileIssues = executiveSummary.keyStats[3]?.value ?? 0;
  const score = executiveSummary.overallScore;
  const grade = executiveSummary.grade;

  return `
<div class="pdf-page closing-page">
  <div class="cover-accent-bar"></div>
  <div class="closing-body-wrap">
    <div class="closing-eyebrow">Ready to Fix This?</div>
    <h2 class="closing-title">Let's Turn These<br/><span>Findings Into Wins</span></h2>
    <p class="closing-body">
      This audit analysed <strong>${meta.auditedPages} pages</strong> of
      <strong>${meta.domain}</strong> and identified
      <strong>${criticals} critical issues</strong> and
      <strong>${warnings} warnings</strong>.
      Each one is a measurable drag on your search rankings, user experience, and conversions.
      The good news? Every issue here has a clear, actionable fix.
    </p>

    <div class="closing-summary-row">
      <div class="closing-summary-card">
        <div class="closing-summary-val" style="color:${grade.color}">${score}<span>/100</span></div>
        <div class="closing-summary-lab">Overall Score — ${grade.grade} (${grade.label})</div>
      </div>
      <div class="closing-summary-card">
        <div class="closing-summary-val" style="color:var(--red)">${criticals}</div>
        <div class="closing-summary-lab">Critical Issues</div>
      </div>
      <div class="closing-summary-card">
        <div class="closing-summary-val" style="color:var(--yellow)">${warnings}</div>
        <div class="closing-summary-lab">Warnings</div>
      </div>
      <div class="closing-summary-card">
        <div class="closing-summary-val" style="color:var(--red)">${mobileIssues}</div>
        <div class="closing-summary-lab">Mobile Failures</div>
      </div>
    </div>

    <div class="closing-section-label">What We Can Fix For You</div>
    <div class="closing-bullets">
      <div class="closing-bullet">Mobile responsiveness fixes — capture the 60%+ mobile audience you're currently losing</div>
      <div class="closing-bullet">Page speed optimisations — reduce load times, bounce rates, and improve Core Web Vitals</div>
      <div class="closing-bullet">Broken link and navigation repairs — protect your SEO authority and search rankings</div>
      <div class="closing-bullet">Layout and UX improvements — ensure headers, footers, and CTAs are visible and effective</div>
      <div class="closing-bullet">Console error remediation — eliminate JavaScript errors that affect functionality</div>
      <div class="closing-bullet">CTA strategy and placement — turn passive visitors into leads and customers</div>
    </div>
    <div class="closing-cta-card">
      <div class="closing-cta-title">Start With a Free Strategy Call</div>
      <div class="closing-cta-body">
        Our team will walk you through the priority fixes for
        <strong>${meta.domain}</strong>, provide accurate effort estimates,
        and show you exactly how we'd approach each issue.
        No obligation — just a clear picture of what's possible.
      </div>
    </div>
  </div>
  <div class="closing-accent-bar"></div>
</div>`;
}

module.exports = {
  initCoverImage,
  coverPage,
  executiveSummaryPage,
  scorecardAndOpportunitiesPage,
  pageBreakdownPages,
  formValidationPages,
  uiUxPages,
  closingPage,
};