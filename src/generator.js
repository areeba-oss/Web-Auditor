const { generateReport } = require('./generators/reportBuilder');

// ─── CLI Entry ───────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
const reportType = process.argv[3] || 'full'; // Default to 'full'

if (!inputPath) {
  console.error('Usage: node src/generator.js <input.json> [full|mini]');
  console.error('  Examples:');
  console.error('    node src/generator.js report.json        # Generates full report');
  console.error('    node src/generator.js report.json full   # Generates full report');
  console.error('    node src/generator.js report.json mini   # Generates mini report');
  process.exit(1);
}

// Validate report type
const normalizedType = reportType.toLowerCase();
if (!['full', 'mini'].includes(normalizedType)) {
  console.error(`Error: Invalid report type "${reportType}". Use "full" or "mini".`);
  process.exit(1);
}

// Generate report based on type
const isFull = normalizedType === 'full';
const outputFile = isFull ? 'report.pdf' : 'report-mini.pdf';

generateReport(inputPath, outputFile, { includePageBreakdown: isFull }).catch((err) => {
  console.error('Failed to generate report:', err.message);
  process.exit(1);
});