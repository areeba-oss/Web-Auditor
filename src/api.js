'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { buildReport } = require('./reporter');
const { buildReportHTML } = require('./generators/reportBuilder');
const { initCoverImage } = require('./generators/pages');

const ROOT_DIR = path.resolve(__dirname, '..');
const AUDITOR_PATH = path.join(__dirname, 'auditor.js');
const OUTPUT_JSON_DIR = path.join(ROOT_DIR, 'outputs', 'report-json');
const OUTPUT_FINAL_DIR = path.join(ROOT_DIR, 'outputs', 'report-final');
const OUTPUT_TMP_DIR = path.join(ROOT_DIR, 'outputs', 'tmp');
const PORT = Number(process.env.PORT || 3000);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve('');
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString();
    } catch {
      return null;
    }
  }
}

function runAuditProcess(targetUrl, resultsPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDITOR_PATH, targetUrl], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        AUDIT_OUTPUT_FILE: resultsPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const message = stderr.trim() || stdout.trim() || `Audit process exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

async function buildHtmlReport(targetUrl, mode = 'full') {
  const requestId = crypto.randomUUID();
  const resultsPath = path.join(OUTPUT_TMP_DIR, `audit-results-${requestId}.json`);
  const reportJsonPath = path.join(OUTPUT_JSON_DIR, `api-report-${requestId}.json`);
  const reportHtmlPath = path.join(OUTPUT_FINAL_DIR, `api-report-${requestId}.html`);
  const includePageBreakdown = mode !== 'mini';

  await fs.mkdir(OUTPUT_TMP_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_JSON_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_FINAL_DIR, { recursive: true });

  await runAuditProcess(targetUrl, resultsPath);

  const rawResults = JSON.parse(await fs.readFile(resultsPath, 'utf8'));
  const pages = Array.isArray(rawResults) ? rawResults : (rawResults.pages ?? [rawResults]);
  const report = buildReport(pages);

  await initCoverImage();
  const html = buildReportHTML(report, { includePageBreakdown });

  await Promise.all([
    fs.writeFile(reportJsonPath, JSON.stringify(report, null, 2), 'utf8'),
    fs.writeFile(reportHtmlPath, html, 'utf8'),
  ]);

  return { html, report, reportJsonPath, reportHtmlPath, resultsPath };
}

function createErrorPage(title, message, details = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: linear-gradient(135deg, #0f172a, #111827);
      color: #e5e7eb;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      max-width: 900px;
      width: 100%;
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { margin: 0 0 12px; line-height: 1.6; color: #cbd5e1; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 12px;
      padding: 16px;
      color: #fca5a5;
      overflow-x: auto;
    }
    .hint { color: #94a3b8; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${details ? `<pre>${escapeHtml(details)}</pre>` : ''}
    <p class="hint">Endpoint: GET /audit?url=https://example.com or POST {"url":"https://example.com"}</p>
  </div>
</body>
</html>`;
}

async function handleAuditRequest(req, res, urlObject) {
  try {
    let targetUrl = null;
    let mode = 'full';

    if (req.method === 'GET') {
      targetUrl = normalizeUrl(urlObject.searchParams.get('url'));
      mode = (urlObject.searchParams.get('mode') || 'full').toLowerCase();
    } else if (req.method === 'POST') {
      const bodyText = await getRequestBody(req);
      if (bodyText) {
        const body = JSON.parse(bodyText);
        targetUrl = normalizeUrl(body.url || body.websiteUrl || body.targetUrl);
        mode = String(body.mode || 'full').toLowerCase();
      }
    }

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(createErrorPage('Invalid request', 'Provide a valid website URL in the url query parameter or request body.'));
      return;
    }

    if (!['full', 'mini'].includes(mode)) mode = 'full';

    const startedAt = Date.now();
    const { html, report, reportHtmlPath } = await buildHtmlReport(targetUrl, mode);
    const elapsedMs = Date.now() - startedAt;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Audit-Url': targetUrl,
      'X-Audit-Mode': mode,
      'X-Audit-Duration-Ms': String(elapsedMs),
      'X-Report-Path': path.relative(ROOT_DIR, reportHtmlPath).replace(/\\/g, '/'),
      'X-Report-Score': String(report?.executiveSummary?.overallScore ?? ''),
    });
    res.end(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(createErrorPage('Audit failed', 'The auditor could not complete the request.', message));
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const urlObject = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && urlObject.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Web Auditor API</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; padding: 40px; }
    .wrap { max-width: 760px; margin: 0 auto; }
    code, pre { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 2px 6px; }
    pre { padding: 16px; overflow-x: auto; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Web Auditor API</h1>
    <p>Use <code>GET /audit?url=https://example.com</code> or <code>POST /audit</code> with JSON <code>{"url":"https://example.com"}</code>.</p>
    <p>The response is the generated HTML report used by the PDF pipeline.</p>
    <pre>${escapeHtml(`curl "http://localhost:${PORT}/audit?url=https://example.com"`)}
${escapeHtml(`curl -X POST http://localhost:${PORT}/audit -H "Content-Type: application/json" -d '{"url":"https://example.com"}'`)}</pre>
  </div>
</body>
</html>`);
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && urlObject.pathname === '/audit') {
      handleAuditRequest(req, res, urlObject);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Web Auditor API listening on http://localhost:${PORT}`);
    console.log(`Audit endpoint: http://localhost:${PORT}/audit?url=https://example.com`);
  });
}

module.exports = { createServer, buildHtmlReport };
