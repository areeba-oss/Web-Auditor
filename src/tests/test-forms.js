'use strict';

/**
 * test-forms.js — Quick test for formsCheck (Layer 4)
 * Usage:   node test-forms.js <url>
 * Example: node test-forms.js https://hubspot.com/contact
 */

require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditForms } = require('../audits/formsCheck');

const url = process.argv[2];
if (!url) {
  console.error('❌  Usage: node test-forms.js <url>');
  process.exit(1);
}

const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const HEADLESS = String(process.env.FORMS_HEADLESS || '').toLowerCase() === 'true';

const CHROME_USER_AGENT =
  process.env.CHROME_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

(async () => {
  const start = Date.now();
  console.log(`\n📋 Forms Audit: ${url}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: CHROME_PATH,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: CHROME_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'Asia/Karachi',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  try {
    const r = await auditForms(context, url);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const banner =
      r.overallStatus === 'healthy'  ? '✅ HEALTHY' :
      r.overallStatus === 'warning'  ? '⚠️  WARNING' : '🔴 CRITICAL';

    console.log(`\n${banner}  (Score: ${r.score}/100)  —  ${elapsed}s`);
    console.log(`Forms found: ${r.formsFound}  |  Tested: ${r.formsTested ?? 0}\n`);

    if (r.formsFound === 0 && r.overallStatus === 'healthy') {
      console.log('ℹ️  No testable forms on this page — try a contact/signup page\n');
      return;
    }

    // ── Per-form results ──────────────────────────────────────────────────────
    for (const form of (r.formResults ?? [])) {
      const icon = form.score === 100 ? '✅' : form.score >= 60 ? '⚠️ ' : '❌';
      console.log(`${'─'.repeat(54)}`);
      console.log(`${icon} Form: "${form.label}"  (Score: ${form.score}/100)`);
      console.log(`${'─'.repeat(54)}`);

      // 1. Empty submit
      console.log(`\n  1. EMPTY SUBMIT VALIDATION`);
      if (!form.emptySubmit.tested) {
        console.log(`     ⚠️  Not tested`);
      } else if (form.emptySubmit.validationShown) {
        console.log(`     ✅  Validation shown  [${form.emptySubmit.method}]`);
        if (form.emptySubmit.detail) {
          const details = Array.isArray(form.emptySubmit.detail)
            ? form.emptySubmit.detail
            : [form.emptySubmit.detail];
          details.slice(0, 3).forEach((d) => {
            const msg = typeof d === 'string' ? d : `${d.field}: "${d.msg}"`;
            console.log(`        └─ ${msg.slice(0, 90)}`);
          });
        }
      } else {
        console.log(`     ❌  No validation shown on empty submit`);
        if (form.emptySubmit.method === 'unclear') {
          console.log(`        └─ Has required fields but validation not triggered visually`);
        }
      }

      // 2. Invalid email
      console.log(`\n  2. INVALID EMAIL HANDLING`);
      const interrupted = (form.issues ?? []).some((i) => i.code === 'FORM_TEST_INTERRUPTED');
      if (!form.invalidEmail.tested) {
        console.log(`     —   No email field on this form`);
      } else if (form.invalidEmail.inconclusive || interrupted) {
        console.log(`     ⚠️  Invalid email verdict inconclusive (test interrupted)`);
        if (form.invalidEmail.detail) {
          console.log(`        └─ ${form.invalidEmail.detail.slice(0, 90)}`);
        }
      } else if (form.invalidEmail.caught) {
        console.log(`     ✅  Invalid email caught`);
        if (form.invalidEmail.detail) {
          console.log(`        └─ ${form.invalidEmail.detail.slice(0, 90)}`);
        }
      } else {
        console.log(`     ❌  No client-side email format validation detected`);
        if (form.invalidEmail.detail) {
          console.log(`        └─ ${form.invalidEmail.detail.slice(0, 90)}`);
        }
      }

      // 3. Error / success messages
      console.log(`\n  3. ERROR / SUCCESS MESSAGES`);
      if (form.errorMessages.visible) {
        const clarity = form.errorMessages.clear ? '✅  Clear & specific' : '⚠️   Visible but vague';
        console.log(`     ${clarity}`);
        if (form.errorMessages.detail) {
          console.log(`        └─ ${form.errorMessages.detail.slice(0, 100)}`);
        }
      } else {
        console.log(`     ❌  Error messages not visible`);
        if (form.errorMessages.detail) {
          console.log(`        └─ ${form.errorMessages.detail.slice(0, 100)}`);
        }
      }

      const success = form.successMessages;
      if (success?.visible) {
        const successLine = success.clear ? '     ✅  Success/confirmation visible' : '     ⚠️   Success visible but vague';
        console.log(successLine);
        if (success.detail) {
          console.log(`        └─ ${success.detail.slice(0, 100)}`);
        }
      } else {
        console.log('     ℹ️  Success/confirmation not observed in safe validation flow');
      }
    }

    // ── Issues ────────────────────────────────────────────────────────────────
    if (r.issues?.length > 0) {
      console.log(`\n${'─'.repeat(54)}`);
      console.log('ISSUES:');
      for (const issue of r.issues) {
        const icon = issue.type === 'critical' ? '🔴' : issue.type === 'warning' ? '🟠' : 'ℹ️ ';
        console.log(`  ${icon} [${issue.code}] ${issue.message}`);
      }
    }

    console.log(`\n${'─'.repeat(54)}\n`);

  } finally {
    await browser.close();
  }
})();