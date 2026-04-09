/**
 * components.js — Reusable HTML building-block functions.
 * scoreRing, gradeBadge, categoryBar, findingIcon, pageCard, metricChip
 */

// ─── Score Ring SVG ──────────────────────────────────────────────────────────

function scoreRing(score, size = 72) {
  const radius = size / 2 - 7;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color =
    score >= 90
      ? '#16a34a'
      : score >= 75
        ? '#65a30d'
        : score >= 60
          ? '#b45309'
          : score >= 40
            ? '#ea580c'
            : '#dc2626';

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="score-ring">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="#e2e8f0" stroke-width="5"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${color}" stroke-width="5"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
        stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
        fill="${color}" font-size="${size * 0.24}px" font-weight="800" font-family="'DM Mono', monospace">${score}</text>
    </svg>`;
}

// ─── Grade Badge ─────────────────────────────────────────────────────────────

function gradeBadge(grade, label, color) {
  return `<span class="grade-badge" style="color:${color}; border-color:${color}30; background:${color}10">${grade} <span class="grade-label">${label}</span></span>`;
}

// ─── Category Bar ────────────────────────────────────────────────────────────

function categoryBar(name, description, score, grade) {
  const color = grade.color;
  return `
    <div class="category-row">
      <div class="category-info">
        <span class="category-name">${name}</span>
        <span class="category-desc">${description}</span>
      </div>
      <div class="category-bar-wrap">
        <div class="category-bar-track">
          <div class="category-bar-fill" style="width:${score}%; background:${color}"></div>
        </div>
        <span class="category-score" style="color:${color}">${score}</span>
      </div>
      ${gradeBadge(grade.grade, grade.label, grade.color)}
    </div>`;
}

// ─── Finding Icon ────────────────────────────────────────────────────────────

function findingIcon(type) {
  if (type === 'critical') return `<span class="finding-icon critical">✕</span>`;
  if (type === 'warning') return `<span class="finding-icon warning">!</span>`;
  if (type === 'success') return `<span class="finding-icon success">✓</span>`;
  return `<span class="finding-icon info">i</span>`;
}

// ─── Metric Chip ─────────────────────────────────────────────────────────────

function metricChip(color, label) {
  return `
    <div class="metric-chip">
      <span class="metric-dot" style="background:${color}"></span>
      <span class="metric-label">${label}</span>
    </div>`;
}

// ─── Page Card ───────────────────────────────────────────────────────────────

function pageCard(page, index) {
  const scoreColor = page.grade.color;
  const healthColor = page.health.ok ? '#16a34a' : '#dc2626';

  // Limit findings to 5 most important (critical → warning → info → success)
  const FINDING_LIMIT = 5;
  const priorityOrder = { critical: 0, warning: 1, info: 2, success: 3 };
  const sortedFindings = [...page.findings]
    .sort((a, b) => (priorityOrder[a.type] ?? 4) - (priorityOrder[b.type] ?? 4))
    .slice(0, FINDING_LIMIT);
  const findingsLeft = page.findings.length - sortedFindings.length;

  const findings =
    sortedFindings
      .map(
        (f) => `
    <div class="finding-item ${f.type}">
      ${findingIcon(f.type)}
      <span>${f.message}</span>
    </div>`,
      )
      .join('') +
    (findingsLeft > 0 ? `<div class="finding-overflow">+ ${findingsLeft} more</div>` : '');

  // Limit opportunities to 3
  function oppLabel(o) {
    const v = o.value;
    const p = o.pages > 1 ? ` across ${o.pages} pages` : '';
    switch (o.key) {
      case 'page-weight':    return `Reduce page weight — ${v} KB. Compress images and minify JS/CSS${p}.`;
      case 'slow-resources': return `Fix ${v} slow-loading resource${v !== 1 ? 's' : ''} dragging down page speed${p}.`;
      case 'failed-reqs':    return `Fix ${v} failed network request${v !== 1 ? 's' : ''} causing errors${p}.`;
      case 'slow-load':      return `Reduce total load time — currently ${v}s. Target under 3s${p}.`;
      case 'slow-ttfb':      return `Improve server response time (TTFB) — ${v}s. Add caching or a CDN${p}.`;
      case 'nav-issues':     return `Resolve ${v} navigation issue${v !== 1 ? 's' : ''} — fix broken anchors${p}.`;
      case 'missing-nav':    return `Add consistent header/footer — missing navigation breaks user flow${p}.`;
      default:               return `Fix ${o.key.replace(/-/g, ' ')} (${v})${p}.`;
    }
  }

  const OPP_LIMIT = 3;
  const visibleOpps = [...page.opportunities].slice(0, OPP_LIMIT);
  const oppsLeft = page.opportunities.length - visibleOpps.length;

  const opportunities =
    visibleOpps.length > 0
      ? `<div class="opp-list">
        ${visibleOpps.map((o) => `<div class="opp-item">${oppLabel(o)}</div>`).join('')}
        ${oppsLeft > 0 ? `<div class="opp-item" style="color: var(--muted); font-style: italic">+ ${oppsLeft} more</div>` : ''}
      </div>`
      : '';

  return `
    <div class="page-card no-break" style="--accent: ${scoreColor}; border-left-color: ${scoreColor}">
      <div class="page-card-header">
        <div class="page-index">PAGE ${String(index + 1).padStart(2, '0')}</div>
        <div class="page-url-wrap">
  <a class="page-slug" href="${page.url}" target="_blank" rel="noopener noreferrer">${page.slug}</a>
</div>
        <div class="page-score-wrap">
          ${scoreRing(page.overallScore, 52)}
        </div>
      </div>

      <div class="page-metrics">
        ${metricChip(healthColor, `HTTP ${page.health.status}`)}
        ${metricChip(page.performance.firstContentfulPaint.grade?.color || '#888', `FCP ${page.performance.firstContentfulPaint.formatted || 'N/A'}`)}
        ${metricChip(page.performance.timeToFirstByte.grade?.color || '#888', `TTFB ${page.performance.timeToFirstByte.formatted || 'N/A'}`)}
        ${metricChip(page.responsiveness.mobile.color, `Mobile: ${page.responsiveness.mobile.label}`)}
        ${metricChip(page.navigation.health.color, page.navigation.health.label)}
        ${metricChip('#64748b', `${page.navigation.totalLinks} links`)}
        ${page.forms.count > 0 ? metricChip('#e8590c', `${page.forms.count} form(s)`) : ''}
        ${page.layout.ctaCount > 0 ? metricChip('#16a34a', `${page.layout.ctaCount} CTA(s)`) : ''}
      </div>

      <div class="page-body">
        <div class="findings-col">
          <div class="col-label">FINDINGS</div>
          ${findings}
        </div>
        ${
          visibleOpps.length > 0
            ? `<div class="opp-col">
              <div class="col-label">OPPORTUNITIES</div>
              ${opportunities}
            </div>`
            : `<div class="opp-col">
              <div class="col-label">OPPORTUNITIES</div>
              <div class="opp-item" style="color: var(--muted)">No specific actions needed.</div>
            </div>`
        }
      </div>
    </div>`;
}

// ─── Page header/footer helpers ──────────────────────────────────────────────

function pageHeaderBar(toolName, domain, date) {
  return `
    <div class="page-header-bar">
      <span class="phb-left">${toolName}</span>
      <span class="phb-right">${domain} · ${date}</span>
    </div>`;
}

function pageFooterBar(toolName, version, pageLabel) {
  return `
    <div class="page-footer-bar">
      <span class="pfb-left">${toolName} v${version}</span>
      <span class="pfb-right">${pageLabel}</span>
    </div>`;
}

module.exports = {
  scoreRing,
  gradeBadge,
  categoryBar,
  findingIcon,
  metricChip,
  pageCard,
  pageHeaderBar,
  pageFooterBar,
};