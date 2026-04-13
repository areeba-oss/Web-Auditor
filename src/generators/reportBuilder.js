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
  ecommercePages,
  uiUxPages,
  closingPage,
} = require('./pages');
const { convertToPDF } = require('./pdfConverter');

/**
 * Build complete HTML report
 * @param {Object} report - Report data
 * @param {Object} options
 * @param {boolean} [options.includePageBreakdown=true] - Whether to include page breakdown section
 * @param {number}  [options.maxPages=6]  - Max pages shown in page breakdown
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
  const hasFormsData = (formValidationSummary?.totalForms ?? 0) > 0;
  const hasEcommerceData = !!(report.ecommerceSummary?.blocked || report.ecommerceSummary?.hasEcommerce);
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
    if (hasFormsData) pages.push(formValidationPages(meta, formValidationSummary, generatedDate));
    if (hasEcommerceData) {
      const ecommercePage = ecommercePages(meta, report.ecommerceSummary, generatedDate);
      if (ecommercePage) pages.push(ecommercePage);
    }
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
  <style>.mainPageHeading{font-size:40px;color:#e8590c;text-align:center;font-family:'Inter',sans-serif;}.mainText{font-size:24px;font-family:'Inter',sans-serif;line-height:56px;color:#000;text-align:center;margin-bottom:15px;}</style>
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

  const htmlOutputPath = `outputs/report-final/${outputPath.replace(/\.pdf$/i, '.html')}`;
  fs.writeFileSync(htmlOutputPath, html, 'utf8');

  const reportType = includePageBreakdown ? 'Full' : 'Mini';
  const breakdownPages = Math.ceil(Math.min(report.pageBreakdown.length, maxPages) / 3);
  const hasFormsData = (report.formValidationSummary?.totalForms ?? 0) > 0;
  const hasEcommerceData = !!(report.ecommerceSummary?.blocked || report.ecommerceSummary?.hasEcommerce);
  const formPages = includePageBreakdown && hasFormsData ? 1 : 0;
  const ecommercePageCount = includePageBreakdown
    ? (hasEcommerceData ? 1 : 0)
    : 0;
  const uiuxPageCount = includePageBreakdown ? 2 : 0;
  const pageCount = includePageBreakdown
    ? `${4 + breakdownPages + formPages + ecommercePageCount + uiuxPageCount} pages`
    : '4 pages';

  console.log(`✅  ${reportType} report generated`);
  console.log(`📄  ${pageCount} (${includePageBreakdown ? 'with' : 'without'} page breakdown)`);
  console.log(`🧾  HTML written to: ${htmlOutputPath}`);

  await convertToPDF(html, `outputs/report-final/${outputPath}`);
}

module.exports = { buildReportHTML, generateReport };