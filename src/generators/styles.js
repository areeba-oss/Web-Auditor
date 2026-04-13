/**
 * styles.js — All CSS for the HTML audit report.
 * Orange & Black theme across every page (cover → content → closing).
 */

function getStyles(accentColor) {
  const accent = accentColor || '#e8590c';

  return `
    /* ── Reset & Variables ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #ffffff;
      --surface: #faf5f0;
      --surface2: #f5ebe0;
      --border: #e8d5c4;
      --border-bright: #d4b896;
      --text: #1a1a1a;
      --text-secondary: #3d3d3d;
      --muted: #6b6b6b;
      --accent: ${accent};
      --accent-light: #fff4ed;
      --accent2: #c2410c;
      --green: #16a34a;
      --green-light: #f0fdf4;
      --yellow: #b45309;
      --yellow-light: #fffbeb;
      --red: #dc2626;
      --red-light: #fef2f2;
      --navy: #1a1a1a;
      --black: #0a0a0a;
      --page-w: 210mm;
      --page-h: 297mm;
    }

    html { font-size: 12.5px; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      font-weight: 400;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Print / PDF ── */
    @page {
      size: A4;
      margin: 0;
    }

    @media print {
      html, body { font-size: 11px; }
      .pdf-page { page-break-after: always; break-after: page; }
      .pdf-page:last-child { page-break-after: auto; break-after: auto; }
      .no-break { page-break-inside: avoid; break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
    }

    /* ── Typography helpers ── */
    .font-mono { font-family: 'DM Mono', monospace; }

    /* ── A4 page wrapper ── */
    .pdf-page {
      width: var(--page-w);
      min-height: var(--page-h);
      margin: 0 auto;
      position: relative;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }

    /* ─────────────────────────────────────────
       PAGE HEADER BAR  (top of every content page)
    ───────────────────────────────────────── */
    .page-header-bar {
      background: var(--black);
      padding: 3mm 10mm;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
    }

    .page-header-bar .phb-left {
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .page-header-bar .phb-right {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      color: rgba(255,255,255,0.6);
    }

    /* ─────────────────────────────────────────
       PAGE FOOTER BAR  (bottom of every page)
    ───────────────────────────────────────── */
    .page-footer-bar {
      margin-top: auto;
      padding: 3mm 10mm;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    .page-footer-bar .pfb-left {
      font-size: 8px;
      color: var(--muted);
      font-family: 'DM Mono', monospace;
    }

    .page-footer-bar .pfb-right {
      font-size: 8px;
      color: var(--muted);
      font-family: 'DM Mono', monospace;
    }

    /* ─────────────────────────────────────────
       COVER PAGE — Full-bleed image with title overlay
    ───────────────────────────────────────── */
    .cover-page {
      background: var(--black);
      padding: 0;
      overflow: hidden;
    }

    .cover-accent-bar {
      height: 6mm;
      background: linear-gradient(90deg, var(--accent), #f97316, var(--accent2));
      flex-shrink: 0;
    }

    /* Image-based cover */
    .cover-image-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .cover-bg-image {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: fill;
      display: block;
    }

    .cover-bg-fallback {
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, var(--black) 0%, #1a1a1a 100%);
    }

    .cover-title-overlay {
      position: absolute;
      top: 50%;
      left: 42%;
      right: 6%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .cover-audit-heading {
      font-size: 34px;
      font-weight: 800;
      color: #0b2545;
      letter-spacing: -0.02em;
      line-height: 1.15;
    }
      .flex-box {
    z-index: 999;
    position: absolute;
    width: 550px;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%)
}

    .cover-audit-domain {
      font-family: 'DM Mono', monospace;
      font-size: 12px;
      color: #e35d22;
      margin-top: 4mm;
      letter-spacing: 0.04em;
      word-break: break-all;
    }

    /* ─────────────────────────────────────────
       SECTION HEADERS
    ───────────────────────────────────────── */
    .section-header {
      padding: 7mm 10mm 4mm;
      border-bottom: 2px solid var(--border);
      margin-bottom: 4mm;
    }

    .section-eyebrow {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 1.5mm;
    }

    .section-title {
      font-size: 19px;
      font-weight: 700;
      color: var(--navy);
      letter-spacing: -0.01em;
    }

    .section-sub {
      font-size: 10.5px;
      color: var(--muted);
      margin-top: 2px;
    }

    /* Compact section header variant */
    .section-header.compact {
      padding: 4mm 10mm 2.5mm;
      margin-bottom: 2mm;
    }

    .section-header.compact .section-title { font-size: 16px; }
    .section-header.compact .section-sub { font-size: 9.5px; }

    .section-header.compact.inline {
      border-bottom: none;
      padding-top: 2mm;
      margin-bottom: 1mm;
    }

    /* Combined page divider */
    .combined-divider {
      height: 1px;
      background: var(--border);
      margin: 2mm 10mm;
    }

    /* Form issues divider */
    .form-issues-divider {
      height: 1px;
      background: var(--border);
      margin: 3mm 0;
    }

    .form-issues-list.compact {
      gap: 2mm;
    }

    .form-issues-list.compact .form-issue-item {
      padding: 2mm 3mm;
    }

    /* ─────────────────────────────────────────
       EXECUTIVE SUMMARY (2-column stats + best/worst)
    ───────────────────────────────────────── */
    .exec-summary-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: flex;
      flex-direction: column;
        justify-content: flex-start;
    }

    .exec-headline {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 5mm;
      line-height: 1.5;
    }

    .exec-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3mm;
      margin-bottom: 5mm;
    }

    .exec-stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3.5mm 4mm;
      display: flex;
      align-items: center;
      gap: 3mm;
    }

    .exec-stat-card .esc-icon {
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.04em;
      background: var(--accent-light);
      color: var(--accent);
      border: 1px solid #fdba74;
      border-radius: 3px;
      padding: 2px 5px;
      flex-shrink: 0;
      text-align: center;
      min-width: 28px;
    }

    .exec-stat-card .esc-val {
      font-size: 17px;
      font-weight: 800;
      line-height: 1;
      color: var(--navy);
    }

    .exec-stat-card .esc-label {
      font-size: 9px;
      color: var(--muted);
      margin-top: 1px;
    }

    .exec-stat-card .esc-sub {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      margin-top: 1px;
    }

    .exec-stat-card.highlight {
      border-color: var(--red);
      background: var(--red-light);
    }

    .exec-stat-card.highlight .esc-val { color: var(--red); }

    .best-worst-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4mm;
    }

    .bw-col-title {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 2mm;
      font-weight: 500;
    }

    .bw-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2.5mm 3mm;
      border-radius: 4px;
      margin-bottom: 1.5mm;
      font-size: 10px;
    }

    .bw-item.best { background: var(--green-light); border: 1px solid #bbf7d0; }
    .bw-item.worst { background: var(--red-light); border: 1px solid #fecaca; }

    .bw-slug { font-family: 'DM Mono', monospace; font-weight: 500; color: var(--text); }
    .bw-score { font-family: 'DM Mono', monospace; font-weight: 700; font-size: 11px; }

    /* ─────────────────────────────────────────
       SCORECARD
    ───────────────────────────────────────── */
    .scorecard-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: flex;
      flex-direction: column;
        justify-content: flex-start;
    }

    .scorecard-body.compact {
      padding: 0 10mm 2mm;
      justify-content: flex-start;
    }

    .scorecard-body.compact .category-row {
      padding: 2.5mm 4mm;
      margin-bottom: 1.5mm;
    }

    .category-row {
      display: grid;
      grid-template-columns: 150px 1fr 105px;
      gap: 3mm;
      align-items: center;
      padding: 3.5mm 4mm;
      border-radius: 5px;
      margin-bottom: 2mm;
      background: var(--surface);
      border: 1px solid var(--border);
    }

    .category-info { min-width: 0; }
    .category-name { display: block; font-size: 11.5px; font-weight: 600; color: var(--text); }
    .category-desc { display: block; font-size: 8.5px; color: var(--muted); margin-top: 1px; }

    .category-bar-wrap { display: flex; align-items: center; gap: 3mm; }
    .category-bar-track { flex: 1; height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .category-bar-fill { height: 100%; border-radius: 3px; }
    .category-score { font-family: 'DM Mono', monospace; font-size: 12px; font-weight: 500; min-width: 26px; text-align: right; }

    .grade-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-family: 'DM Mono', monospace;
      font-size: 9.5px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid;
      white-space: nowrap;
      max-width: 105px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .grade-label { font-size: 8px; opacity: 0.75; }

    /* ─────────────────────────────────────────
       PAGE CARDS
    ───────────────────────────────────────── */
    .pages-body {
      padding: 0 10mm 3mm;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4mm;
    }

    .pages-body.compact {
      padding: 0 10mm 2mm;
      gap: 2.5mm;
        justify-content: flex-start;
    }

    .page-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 5px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        max-height: 130mm;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
    }
    .page-card-header {
      display: flex;
      align-items: center;
      gap: 3mm;
      padding: 2.5mm 4mm;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .page-index {
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      color: var(--muted);
      letter-spacing: 0.12em;
      min-width: 45px;
    }

    .page-url-wrap { flex: 1; min-width: 0; }

    .page-slug {
      display: block;
      font-family: 'DM Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      color: var(--navy);
      line-height: 1.2;
    }

    .page-full-url {
      display: block;
      font-size: 8.5px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .page-score-wrap { flex-shrink: 0; }
    .score-ring { display: block; }

    .page-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5mm;
      padding: 2mm 4mm;
      border-bottom: 1px solid var(--border);
    }

    .metric-chip {
      display: flex;
      align-items: center;
      gap: 3px;
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      padding: 1.5px 5px;
      border-radius: 3px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .metric-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }

    .page-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
        gap: 0;
    }

    .findings-col, .opp-col { padding: 2mm 3.5mm; }
    .findings-col { border-right: 1px solid var(--border); }

    .col-label {
      font-family: 'DM Mono', monospace;
      font-size: 7px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 1.5mm;
      font-weight: 500;
    }

    .finding-item {
      display: flex;
      align-items: flex-start;
      gap: 5px;
      font-size: 8.5px;
      color: var(--text-secondary);
      margin-bottom: 1.5mm;
      line-height: 1.35;
    }

    .finding-overflow {
      font-size: 8px;
      color: var(--muted);
      font-style: italic;
      margin-top: 0.5mm;
    }

    .finding-icon {
      flex-shrink: 0;
      width: 12px; height: 12px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 7px;
      font-weight: 700;
      margin-top: 1px;
    }

    .finding-icon.critical { background: var(--red-light); color: var(--red); border: 1px solid #fecaca; }
    .finding-icon.warning  { background: var(--yellow-light); color: var(--yellow); border: 1px solid #fde68a; }
    .finding-icon.success  { background: var(--green-light); color: var(--green); border: 1px solid #bbf7d0; }
    .finding-icon.info     { background: var(--accent-light); color: var(--accent); border: 1px solid #fdba74; }

    .opp-item {
      font-size: 8.5px;
      color: var(--text-secondary);
      margin-bottom: 1.5mm;
      padding-left: 10px;
      position: relative;
      line-height: 1.35;
    }

    .opp-item::before {
      content: '→';
      position: absolute;
      left: 0;
      color: var(--accent);
      font-size: 9px;
    }

    .slow-resources {
      padding: 2.5mm 4mm;
      border-top: 1px solid var(--border);
      background: var(--surface);
    }

    .resource-list { margin-top: 1.5mm; }

    .resource-item {
      display: flex;
      align-items: center;
      gap: 2mm;
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      padding: 1.5mm 0;
      border-bottom: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .resource-item:last-child { border-bottom: none; }

    .resource-type {
      background: var(--accent-light);
      color: var(--accent);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 7.5px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      flex-shrink: 0;
      font-weight: 600;
    }

    .resource-url { flex: 1; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .resource-dur { color: var(--yellow); flex-shrink: 0; }
    .resource-size { color: var(--muted); flex-shrink: 0; }

    /* ─────────────────────────────────────────
       OPPORTUNITIES
    ───────────────────────────────────────── */
    .opp-section-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: flex;
      flex-direction: column;
        justify-content: flex-start;
    }

    .opp-section-body.compact {
      padding: 0 10mm 2mm;
      justify-content: flex-start;
    }

    .opp-summary-list {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .opp-summary-item {
      display: flex;
      align-items: flex-start;
      gap: 4mm;
      padding: 3.5mm 4mm;
      border-bottom: 1px solid var(--border);
    }

    .opp-summary-item.compact {
      padding: 2.5mm 4mm;
      gap: 3mm;
    }

    .opp-summary-item.compact .opp-num {
      font-size: 13px;
      min-width: 18px;
    }

    .opp-summary-item.compact .opp-text {
      font-size: 9px;
    }

    .opp-summary-item:first-child {
      border-top: 1px solid var(--border);
    }

    .opp-summary-item:nth-child(odd) {
      background: var(--surface);
    }

    .opp-num {
      font-family: 'DM Mono', monospace;
      font-size: 16px;
      font-weight: 600;
      color: var(--accent);
      opacity: 0.35;
      line-height: 1.25;
      flex-shrink: 0;
      min-width: 24px;
      text-align: right;
    }

    .opp-content {
      flex: 1;
      min-width: 0;
    }

    .opp-text {
      font-size: 10px;
      color: var(--text-secondary);
      line-height: 1.55;
    }

    .opp-overflow {
      margin-top: 4mm;
      padding: 3mm 4mm;
      background: var(--accent-light);
      border: 1px solid #fdba74;
      border-radius: 4px;
      font-size: 9.5px;
      color: var(--accent);
      font-weight: 500;
      text-align: center;
    }

    /* ─────────────────────────────────────────
       CLOSING PAGE — White background
    ───────────────────────────────────────── */
    .closing-page { background: var(--bg); padding: 0; color: var(--text); }

    .closing-body-wrap {
      flex: 1;
      padding: 10mm 14mm 6mm;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .closing-eyebrow {
      font-family: 'DM Mono', monospace;
      font-size: 9px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 4mm;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .closing-eyebrow::before {
      content: '';
      width: 24px;
      height: 2px;
      background: var(--accent);
    }

    .closing-title {
      font-size: 28px;
      font-weight: 800;
      color: var(--navy);
      line-height: 1.12;
      margin-bottom: 5mm;
      letter-spacing: -0.02em;
    }

    .closing-title span { color: var(--accent); }

    .closing-body {
      font-size: 11.5px;
      color: var(--text-secondary);
      line-height: 1.65;
      margin-bottom: 6mm;
    }

    .closing-body strong { color: var(--navy); font-weight: 700; }

    .closing-summary-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 3mm;
      margin-bottom: 6mm;
    }

    .closing-summary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 4mm 3mm;
      text-align: center;
    }

    .closing-summary-val {
      font-size: 26px;
      font-weight: 800;
      line-height: 1;
      font-family: 'DM Mono', monospace;
    }

    .closing-summary-val span {
      font-size: 14px;
      font-weight: 500;
      opacity: 0.5;
    }

    .closing-summary-lab {
      font-size: 8.5px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 2px;
    }

    .closing-section-label {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 3mm;
      font-weight: 600;
    }

    .closing-bullets {
      display: flex;
      flex-direction: column;
      gap: 2.5mm;
      margin-bottom: 6mm;
    }

    .closing-bullet {
      display: flex;
      align-items: flex-start;
      gap: 3mm;
      font-size: 10.5px;
      color: var(--text-secondary);
      line-height: 1.45;
    }

    .closing-bullet::before {
      content: '✓';
      color: var(--green);
      font-weight: 700;
      font-size: 11px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .closing-cta-card {
      background: var(--accent-light);
      border: 1px solid #fdba74;
      border-radius: 6px;
      padding: 6mm 7mm;
    }

    .closing-cta-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--navy);
      margin-bottom: 3mm;
    }

    .closing-cta-body {
      font-size: 10.5px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .closing-cta-body strong {
      color: var(--navy);
      font-weight: 700;
    }

    .closing-accent-bar {
      height: 6mm;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
      flex-shrink: 0;
      margin-top: auto;
    }

    /* ─────────────────────────────────────────
       FORM VALIDATION SECTION
    ───────────────────────────────────────── */
    .form-section-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .form-empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }

    .form-empty-icon { font-size: 36px; margin-bottom: 4mm; }
    .form-empty-text { font-size: 11px; color: var(--muted); max-width: 320px; line-height: 1.6; }

    .form-stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3mm;
      margin-bottom: 5mm;
    }

    .form-stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3.5mm 4mm;
      text-align: center;
    }

    .form-stat-card.warn { border-color: var(--yellow); background: var(--yellow-light); }
    .form-stat-card.critical { border-color: var(--red); background: var(--red-light); }

    .form-stat-val {
      font-size: 18px;
      font-weight: 800;
      color: var(--navy);
      line-height: 1;
      font-family: 'DM Mono', monospace;
    }

    .form-stat-card.warn .form-stat-val { color: var(--yellow); }
    .form-stat-card.critical .form-stat-val { color: var(--red); }

    .form-stat-label {
      font-size: 8.5px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 2px;
    }

    .form-cards-label {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 2.5mm;
      font-weight: 600;
    }

    .form-cards-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2.5mm;
    }

    .form-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3mm;
      font-size: 9px;
    }

    .form-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2mm;
    }

    .form-card-page {
      font-family: 'DM Mono', monospace;
      font-size: 9px;
      font-weight: 600;
      color: var(--navy);
    }

    .form-card-fields {
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      color: var(--muted);
      background: var(--surface2);
      padding: 1px 5px;
      border-radius: 3px;
    }

    .form-card-checks {
      display: flex;
      flex-wrap: wrap;
      gap: 2mm;
    }

    .form-check {
      font-size: 8px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
    }

    .form-check.pass { background: var(--green-light); color: var(--green); border: 1px solid #bbf7d0; }
    .form-check.fail { background: var(--red-light); color: var(--red); border: 1px solid #fecaca; }

    .form-missing {
      margin-top: 2mm;
      font-size: 8px;
      color: var(--red);
      font-weight: 500;
    }

    /* ─────────────────────────────────────────
       ECOMMERCE FLOW SECTION
    ───────────────────────────────────────── */
    .ecommerce-section-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2.5mm;
    }

    .ecommerce-empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 8mm 0;
    }

    .ecommerce-empty-icon { font-size: 36px; margin-bottom: 4mm; }
    .ecommerce-empty-text { font-size: 11px; color: var(--muted); max-width: 350px; line-height: 1.6; }
    .ecommerce-empty-note { margin-top: 2mm; font-size: 9px; color: var(--text-secondary); max-width: 360px; line-height: 1.5; }

    .ecommerce-stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2.5mm;
    }

    .ecommerce-stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3mm 3.5mm;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 3mm;
      min-height: 18mm;
    }

    .ecommerce-stat-card.pass { border-color: var(--green); background: var(--green-light); }
    .ecommerce-stat-card.warn { border-color: var(--yellow); background: var(--yellow-light); }
    .ecommerce-stat-card.fail { border-color: var(--red); background: var(--red-light); }

    .ecommerce-stat-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    .ecommerce-stat-label {
      font-size: 8.5px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 1px;
    }

    .ecommerce-stat-sub {
      font-size: 8.5px;
      color: var(--text-secondary);
      line-height: 1.35;
    }

    .ecommerce-stat-val {
      font-family: 'DM Mono', monospace;
      font-size: 16px;
      font-weight: 800;
      color: var(--navy);
      flex-shrink: 0;
    }

    .ecommerce-stat-card.pass .ecommerce-stat-val { color: var(--green); }
    .ecommerce-stat-card.warn .ecommerce-stat-val { color: var(--yellow); }
    .ecommerce-stat-card.fail .ecommerce-stat-val { color: var(--red); }

    .ecommerce-cards-label {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
      margin-top: 1mm;
      margin-bottom: 1mm;
      font-weight: 600;
    }

    .ecommerce-steps-grid,
    .ecommerce-primary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2.5mm;
    }

    .ecommerce-step-card,
    .ecommerce-primary-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 3mm;
      font-size: 9px;
    }

    .ecommerce-step-card.pass,
    .ecommerce-primary-card.pass { border-color: var(--green); background: var(--green-light); }
    .ecommerce-step-card.warn,
    .ecommerce-primary-card.warn { border-color: var(--yellow); background: var(--yellow-light); }
    .ecommerce-step-card.fail,
    .ecommerce-primary-card.fail { border-color: var(--red); background: var(--red-light); }

    .ecommerce-step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 2mm;
      margin-bottom: 1.5mm;
    }

    .ecommerce-step-name,
    .ecommerce-primary-title {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      font-weight: 600;
      color: var(--navy);
    }

    .ecommerce-step-badge {
      font-size: 8px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--surface2);
      color: var(--muted);
      white-space: nowrap;
    }

    .ecommerce-step-detail,
    .ecommerce-primary-line,
    .ecommerce-primary-note,
    .ecommerce-note {
      font-size: 8.5px;
      color: var(--text-secondary);
      line-height: 1.45;
    }

    .ecommerce-primary-card {
      min-height: 28mm;
    }

    .ecommerce-primary-line + .ecommerce-primary-line {
      margin-top: 1px;
    }

    .ecommerce-primary-link {
      display: block;
      margin-top: 1mm;
      font-size: 8px;
      color: var(--accent);
      word-break: break-all;
      text-decoration: underline;
    }

    .ecommerce-primary-note {
      margin-top: 1mm;
      color: var(--muted);
    }

    .ecommerce-meta-row {
      display: flex;
      gap: 2mm;
      align-items: flex-start;
      margin-top: 1mm;
    }

    .ecommerce-meta-label {
      font-family: 'DM Mono', monospace;
      font-size: 8.5px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      min-width: 60px;
      flex-shrink: 0;
    }

    .ecommerce-meta-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5mm;
    }

    .ecommerce-pill {
      font-size: 8px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--surface2);
      color: var(--navy);
    }

    .form-issues-list {
      display: flex;
      flex-direction: column;
      gap: 2.5mm;
    }

    .form-issue-item {
      display: flex;
      align-items: flex-start;
      gap: 3mm;
      padding: 3mm 4mm;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: var(--surface);
    }

    .form-issue-badge {
      font-family: 'DM Mono', monospace;
      font-size: 7px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 2px 5px;
      border-radius: 3px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .form-issue-badge.critical { background: var(--red-light); color: var(--red); }
    .form-issue-badge.warning { background: var(--yellow-light); color: var(--yellow); }
    .form-issue-badge.info { background: var(--accent-light); color: var(--accent); }

    .form-issue-content { flex: 1; }

    .form-issue-page {
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      font-weight: 600;
      color: var(--navy);
      display: block;
      margin-bottom: 1px;
    }

    .form-issue-msg {
      font-size: 9px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .form-overflow {
      margin-top: 3mm;
      padding: 2.5mm 4mm;
      background: var(--accent-light);
      border: 1px solid #fdba74;
      border-radius: 4px;
      font-size: 9px;
      color: var(--accent);
      font-weight: 500;
      text-align: center;
    }

    /* ─────────────────────────────────────────
       UI / UX SECTION
    ───────────────────────────────────────── */
    .uiux-section-body {
      padding: 0 10mm 4mm;
      flex: 1;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4mm;
      align-content: start;
    }

    .uiux-section-body-two-up {
      display: flex;
      flex-direction: column;
      gap: 4mm;
      padding-bottom: 5mm;
    }

    .uiux-issue-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4mm 5mm;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1 1 0;
    }

    .uiux-issue-card.empty {
      background: var(--surface);
      border-style: dashed;
    }

    .uiux-slot-badge {
      align-self: flex-start;
      font-family: 'DM Mono', monospace;
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent);
      background: var(--accent-light);
      border: 1px solid #fdba74;
      border-radius: 999px;
      padding: 1.5px 6px;
      margin-bottom: 3mm;
    }

    .uiux-issue-header {
      display: flex;
      align-items: center;
      gap: 3mm;
      margin-bottom: 2mm;
    }

    .uiux-severity-badge {
      font-family: 'DM Mono', monospace;
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.08em;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid;
      background: transparent;
    }

    .uiux-issue-category {
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .uiux-issue-pages {
      margin-left: auto;
      font-family: 'DM Mono', monospace;
      font-size: 8px;
      color: var(--muted);
    }

    .uiux-issue-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--navy);
      margin-bottom: 2mm;
    }

    .uiux-issue-desc {
      font-size: 9.5px;
      color: var(--text-secondary);
      line-height: 1.55;
      margin-bottom: 3mm;
    }

    .uiux-screenshot-placeholder {
      background: var(--surface);
      border: 2px dashed var(--border-bright);
      border-radius: 5px;
      padding: 4mm;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      min-height: 0;
    }

    .uiux-screenshot-placeholder.full-slot {
      min-height: 0;
    }

    .uiux-screenshot-label {
      font-family: 'DM Mono', monospace;
      font-size: 9px;
      color: var(--muted);
      letter-spacing: 0.05em;
    }

    .uiux-additional-space {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    `;
  }

module.exports = { getStyles };