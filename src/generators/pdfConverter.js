/**
 * pdfConverter.js — Sends complete HTML to the PDF API and writes the result.
 */

const fs = require('fs');
const https = require('https');

function convertToPDF(htmlContent, outPath = 'outputs/report-final/report.pdf') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ html: htmlContent });

    const options = {
      hostname: 'n8n.spctek.com',
      path: '/pdf-generate/pdf',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        fs.writeFileSync(outPath, pdfBuffer);
        console.log(`✅  PDF written to: ${outPath} (${(pdfBuffer.length / 1024).toFixed(0)} KB)`);
        resolve(outPath);
      });
    });

    req.on('error', (err) => {
      console.error('❌  PDF conversion error:', err.message);
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

module.exports = { convertToPDF };