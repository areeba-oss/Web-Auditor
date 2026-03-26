'use strict';

/**
 * aiClassifier.js — All Claude AI calls for the crawler.
 *
 * Exports:
 *   classifyUrlsWithAI(links, homepageUrl, pass?)   → { important, drillInto, skipped }
 *   shortlistPagesForAudit(pages, homepageUrl, limit?) → { shortlisted, selectionStrategy }
 */

const AI_MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 60;        // ~2400 tokens input per batch
const BATCH_DELAY_MS = 2000;  // wait between sequential batches to respect rate limits
const MAX_RETRIES = 3;        // retry attempts on 429
const RETRY_DELAY_MS = 8000;  // wait before retrying after a 429

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse JSON from Claude response — tries 3 strategies before throwing.
 */
function parseJSON(text) {
  // 1. Raw parse
  try { return JSON.parse(text.trim()); } catch {}

  // 2. ```json ... ``` code block
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try { return JSON.parse(blockMatch[1].trim()); } catch {}
  }

  // 3. Outermost { ... } — handles any leading/trailing prose
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
}

// ─── Core API caller with retry ───────────────────────────────────────────────

/**
 * Call Claude once and return parsed JSON.
 * Retries up to MAX_RETRIES times on 429 rate-limit errors with exponential backoff.
 */
async function callClaude(systemPrompt, userContent, attempt = 1) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  // Handle 429 rate limit — wait and retry
  if (res.status === 429) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`Rate limit hit after ${MAX_RETRIES} retries`);
    }
    const waitMs = RETRY_DELAY_MS * attempt; // 8s, 16s, 24s
    console.log(`   ⏳ Rate limit hit — waiting ${waitMs / 1000}s before retry (${attempt}/${MAX_RETRIES})...`);
    await sleep(waitMs);
    return callClaude(systemPrompt, userContent, attempt + 1);
  }

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);

  const text = (await res.json()).content?.[0]?.text || '';
  return parseJSON(text);
}

// ─── URL Classification ───────────────────────────────────────────────────────

/**
 * Classify a list of URLs — decide which ones are worth auditing.
 * Batches sequentially (not concurrently) to respect rate limits.
 *
 * @param {Array<{ url: string, text: string }>} links
 * @param {string} homepageUrl
 * @param {'initial'|'subpages'} pass
 *
 * @returns {Promise<{
 *   important: Array<{ url, category, tier, reasoning }>,
 *   drillInto: string[],
 *   skipped: number
 * }>}
 */
async function classifyUrlsWithAI(links, homepageUrl, pass = 'initial') {
  const system = `You are a website audit expert. Your job is to look at a list of URLs from a website and identify which pages are worth auditing.

Return ONLY valid JSON — no explanation, no markdown, no extra text.

Return this exact structure:
{
  "important": [
    {
      "url": "https://...",
      "category": "home|about|contact|services|pricing|team|faq|portfolio|careers|blog|industries|partners|service-page|other",
      "tier": 1,
      "reasoning": "one short phrase"
    }
  ],
  "drillInto": ["https://..."],
  "skipped": 0
}

Rules:
- "tier" must be: 1 (core business page), 2 (individual service/product sub-page), or 3 (soft extra like blog listing, partners)
- "drillInto" = service/solution HUB pages that LIST multiple services — their sub-pages should also be crawled (e.g. /services, /solutions, /what-we-do)
- Include each individual service page (e.g. /services/seo, /services/web-design) as tier 2
- Include blog/news ONLY as a top-level listing page — never individual posts
- SKIP: login, admin, legal/privacy/terms/cookies, pagination, author pages, tag pages, individual blog posts, media files, search pages, account pages
- SKIP: pages that look like duplicates or tracking variants
- Be generous — if a real user would visit it to learn about the business, include it
- "skipped" = integer count of URLs you chose not to include`;

  // Split into sequential batches
  const batches = [];
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    batches.push(links.slice(i, i + BATCH_SIZE));
  }

  console.log(`   Sending ${links.length} URLs in ${batches.length} batch(es) of ~${BATCH_SIZE} — sequential...`);

  // Merge target
  const merged = { important: [], drillInto: [], skipped: 0 };
  const seenUrls = new Set();

  // ── Run batches ONE AT A TIME with a delay between each ──────────────────
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    // Delay between batches (skip before first batch)
    if (batchIdx > 0) {
      console.log(`   ⏸  Waiting ${BATCH_DELAY_MS / 1000}s before batch ${batchIdx + 1}...`);
      await sleep(BATCH_DELAY_MS);
    }

    console.log(`   📦 Batch ${batchIdx + 1}/${batches.length} (${batch.length} URLs)...`);

    const urlList = batch
      .map((l, i) => `${batchIdx * BATCH_SIZE + i + 1}. ${l.url}${l.text ? ` [anchor: "${l.text}"]` : ''}`)
      .join('\n');

    const user = `Homepage: ${homepageUrl}
Pass type: ${pass === 'subpages' ? 'Service sub-pages drill (focus on individual service pages)' : 'Initial full-site scan'}
Batch: ${batchIdx + 1} of ${batches.length}

URLs to classify:
${urlList}`;

    try {
      const data = await callClaude(system, user);

      for (const item of (data.important || [])) {
        if (item.url && !seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          merged.important.push(item);
        }
      }
      for (const url of (data.drillInto || [])) {
        if (url && !merged.drillInto.includes(url)) merged.drillInto.push(url);
      }
      merged.skipped += data.skipped || 0;

      console.log(`      ✓ ${(data.important || []).length} selected, ${data.skipped || 0} skipped`);
    } catch (err) {
      console.warn(`   ⚠️  Batch ${batchIdx + 1} failed after retries: ${err.message}`);
    }
  }

  return merged;
}

// ─── Audit Shortlisting ───────────────────────────────────────────────────────

/**
 * From all discovered pages, pick the top N most audit-worthy ones.
 *
 * @param {Map<string, PageMeta>} pages
 * @param {string} homepageUrl
 * @param {number} limit  — how many to shortlist (default 10)
 *
 * @returns {Promise<{
 *   shortlisted: Array<{ rank, url, category, tier, auditPriority, auditReason }>,
 *   selectionStrategy: string
 * }>}
 */
async function shortlistPagesForAudit(pages, homepageUrl, limit = 10) {
  const allPages = [...pages.values()].map((p, i) => ({
    n: i + 1,
    url: p.url,
    category: p.category,
    tier: p.tier,
    reasoning: p.reasoning,
  }));

  const system = `You are a website audit strategist. Given a list of pages discovered on a website,
select the top ${limit} pages that give the most valuable and comprehensive audit coverage.

Return ONLY valid JSON — no explanation, no markdown.

Return this exact structure:
{
  "shortlisted": [
    {
      "rank": 1,
      "url": "https://...",
      "category": "same category as input",
      "tier": 1,
      "auditPriority": "critical|high|medium",
      "auditReason": "one sentence — why this page matters for the audit"
    }
  ],
  "selectionStrategy": "one sentence explaining the overall selection approach"
}

Selection criteria — pick pages that together cover:
1. Full core user journey (home → services → contact/pricing)
2. At least one representative page per major service cluster
3. Decision pages where users convert (pricing, contact, main CTA destinations)
4. Pages most likely to reveal performance, UX, or content issues
5. Diversity — avoid picking 10 nearly-identical service pages

Priority levels:
- "critical" = homepage, pricing, contact, main services hub
- "high"     = key service pages, about, portfolio/case studies
- "medium"   = supporting pages, blog index, extras

Always include home + contact/pricing if present.
Never exceed ${limit} pages.`;

  const pageList = allPages
    .map((p) => `${p.n}. [T${p.tier}] [${p.category}] ${p.url}${p.reasoning ? ` — ${p.reasoning}` : ''}`)
    .join('\n');

  const user = `Homepage: ${homepageUrl}
Total pages discovered: ${allPages.length}
Shortlist target: ${limit} pages

All discovered pages:
${pageList}`;

  return callClaude(system, user);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyUrlsWithAI,
  shortlistPagesForAudit,
};