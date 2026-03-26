/**
 * reportBuilder.js — Shared report generation logic
 * Builds HTML and generates PDF for both full and mini reports
 */

const fs = require('fs');
const { getStyles } = require('./styles');
const {
  initCoverImage,
  coverPage,
  executiveSummaryPage,
  scorecardAndOpportunitiesPage,
  pageBreakdownPages,
  formValidationPages,
  uiUxPages,
  closingPage,
} = require('./pages');
const { convertToPDF } = require('./pdfConverter');

/**
 * Build complete HTML report
 * @param {Object} report - Report data
 * @param {Object} options
 * @param {boolean} [options.includePageBreakdown=true] - Whether to include page breakdown section
 * @param {number}  [options.maxPages=6]   - Max pages shown in page breakdown
 * @param {number}  [options.maxImages=4]  - Max screenshot placeholders in UI/UX section
 * @returns {string} Complete HTML document
 */
function buildReportHTML(report, options = {}) {
  const { includePageBreakdown = true, maxPages = 6, maxImages = 4 } = options;
  const {
    meta,
    executiveSummary,
    pageBreakdown,
    opportunitySummary,
    categoryScorecard,
    formValidationSummary,
    uiUxIssues,
  } = report;
  const generatedDate = new Date(meta.generatedAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const pages = [
    coverPage(meta, executiveSummary, generatedDate),
    executiveSummaryPage(meta, executiveSummary, generatedDate),
    scorecardAndOpportunitiesPage(meta, categoryScorecard, opportunitySummary, generatedDate),
  ];

  if (includePageBreakdown) {
    pages.push(pageBreakdownPages(meta, pageBreakdown, generatedDate, maxPages));
    pages.push(formValidationPages(meta, formValidationSummary, generatedDate));
    pages.push(uiUxPages(meta, uiUxIssues, generatedDate, maxImages));
  }

  pages.push(closingPage(meta, executiveSummary));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${meta.reportTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
  <style>${getStyles()}</style>
  <style>@import url("https://fonts.googleapis.com/css2?family=Carlito:ital,wght@0,400;0,700;1,400;1,700&display=swap");.mainPageHeading{font-size:40px;color:#f26225;text-align:center;font-family: carlito;}.mainText{font-size:24px;font-family: carlito;line-height:56px;color:#000;text-align:center;margin-bottom:15px;}</style>
</head>
<body>
  ${pages.join('\n')}
</body>
</html>`;
}

/**
 * Generate PDF report from JSON data
 * @param {string} jsonPath - Path to input JSON file (relative to outputs/report-json/)
 * @param {string} outputPath - Path for output PDF (relative to outputs/report-final/)
 * @param {Object} options
 * @param {boolean} [options.includePageBreakdown=true]
 * @param {number}  [options.maxPages=6]
 * @param {number}  [options.maxImages=4]
 */
async function generateReport(jsonPath, outputPath, options = {}) {
  const { includePageBreakdown = true, maxPages = 6, maxImages = 4 } = options;
  await initCoverImage();
  const report = JSON.parse(fs.readFileSync(`outputs/report-json/${jsonPath}`, 'utf8'));
  const html = buildReportHTML(report, { includePageBreakdown, maxPages, maxImages });

  fs.mkdirSync('outputs/report-final', { recursive: true });

  const reportType = includePageBreakdown ? 'Full' : 'Mini';
  const breakdownPages = Math.ceil(Math.min(report.pageBreakdown.length, maxPages) / 3);
  const formPages = 1;
  const uiuxPageCount = 2;
  const pageCount = includePageBreakdown
    ? `${4 + breakdownPages + formPages + uiuxPageCount} pages`
    : '4 pages';

  console.log(`✅  ${reportType} report generated`);
  console.log(`📄  ${pageCount} (${includePageBreakdown ? 'with' : 'without'} page breakdown)`);

  await convertToPDF(html, `outputs/report-final/${outputPath}`);
}

module.exports = { buildReportHTML, generateReport };