'use strict';

/**
 * formsCheck.js — Layer 4 audit: Forms Testing
 *
 * Handles:
 *   - Single-step forms
 *   - Multi-step / paginated forms (wizard-style, step indicators)
 *
 * Checks:
 *   1. Empty submit validation  — does form block submission + show errors?
 *   2. Invalid email handling   — does bad email get caught?
 *   3. Error / success message  — are feedback messages visible & clear?
 *
 * Strategy:
 *   - DOM detects form type (single vs multi-step)
 *   - Playwright interacts with VISIBLE inputs only (current step)
 *   - Screenshot before/after each interaction
 *   - AI Vision confirms what visually changed
 *   - DOM validity check as primary signal, AI as confirmation
 */

const sharp = require('sharp');

const AI_MODEL       = 'claude-haiku-4-5-20251001';
const MAX_TOKENS     = 1200;
const MAX_FORMS      = 5;
const MAX_IMG_HEIGHT = 7800;
const INTERACTION_WAIT = 800;  // ms after click/type before screenshot

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) { try { return JSON.parse(block[1].trim()); } catch {} }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  throw new Error(`Non-JSON: ${text.slice(0, 150)}`);
}

async function resizeIfNeeded(buffer) {
  const meta = await sharp(buffer).metadata();
  if ((meta.height ?? 0) > MAX_IMG_HEIGHT) {
    return sharp(buffer).resize({ height: MAX_IMG_HEIGHT, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
  }
  return buffer;
}

async function takeScreenshot(page) {
  let buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: true });
  buf = await resizeIfNeeded(buf);
  return buf.toString('base64');
}

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHTS = {
  emptySubmit:   40,
  invalidEmail:  30,
  errorMessages: 30,
};

// ─── DOM: detect form type + extract metadata ─────────────────────────────────

async function findForms(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    // ── Detect multi-step form signals ──────────────────────────────────────
    function detectMultiStep(form) {
      // Signal 1: step indicator elements
      const stepIndicators = form.querySelectorAll(
        '[class*="step"], [class*="wizard"], [class*="progress"], ' +
        '[aria-label*="step" i], [data-step], [class*="StepIndicator"]'
      );

      // Signal 2: multiple fieldsets (common pattern)
      const fieldsets = form.querySelectorAll('fieldset');

      // Signal 3: "Next" / "Continue" button instead of final submit
      const allBtns = Array.from(form.querySelectorAll('button, input[type="submit"]'));
      const nextBtns = allBtns.filter((b) => {
        const t = (b.innerText || b.value || '').trim().toLowerCase();
        return /^(next|continue|proceed|forward|go|weiter|suivant)$/i.test(t);
      });

      // Signal 4: hidden steps (divs with display:none siblings)
      const stepDivs = Array.from(form.querySelectorAll('[data-step], [class*="step-"]'))
        .filter((el) => el.tagName !== 'BUTTON');

      return {
        isMultiStep: stepIndicators.length > 0 || nextBtns.length > 0 || stepDivs.length > 1,
        hasNextButton: nextBtns.length > 0,
        nextButtonText: nextBtns[0]?.innerText?.trim() || null,
        stepCount: Math.max(stepIndicators.length, stepDivs.length, fieldsets.length),
      };
    }

    const forms = Array.from(document.querySelectorAll('form'));

    return forms
      .map((form, i) => {
        // Only count VISIBLE inputs on the CURRENT step/page
        const allInputs = Array.from(form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'
        ));

        // For multi-step forms that render ALL steps in DOM simultaneously (e.g. Stripe),
        // find the ACTIVE step container and only count its inputs
        const activeStepEl =
          form.querySelector('[class*="is-active"]') ||
          form.querySelector('[class*="active"][class*="step"]') ||
          form.querySelector('[aria-selected="true"]') ||
          form.querySelector('[class*="current"][class*="step"]');

        const scopeEl = activeStepEl || form;
        const scopedInputs = Array.from(scopeEl.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'
        ));

        // Use scoped inputs if found, else fall back to all visible
        const visibleInputs = (scopedInputs.length > 0 ? scopedInputs : allInputs).filter(isVisible);

        // Submit or Next button — whichever is visible
        const allBtns = Array.from(form.querySelectorAll(
          'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])'
        ));
        const visibleSubmitBtn = allBtns.find(isVisible);

        const emailInput = visibleInputs.find(
          (i) => i.type === 'email' || i.name?.toLowerCase().includes('email') || i.placeholder?.toLowerCase().includes('email')
        );

        // Is whole form visible?
        const formVisible = isVisible(form);

        // Get label
        const legend    = form.querySelector('legend')?.innerText?.trim();
        const heading   = form.closest('section, [class*="section"], div')?.querySelector('h1,h2,h3,h4')?.innerText?.trim();
        const ariaLabel = form.getAttribute('aria-label') || form.getAttribute('data-form-name');
        const label     = legend || ariaLabel || heading || `Form ${i + 1}`;

        const multiStep = detectMultiStep(form);

        return {
          index:           i,
          label:           label.slice(0, 60),
          visible:         formVisible,
          isMultiStep:     multiStep.isMultiStep,
          hasNextButton:   multiStep.hasNextButton,
          nextButtonText:  multiStep.nextButtonText,
          stepCount:       multiStep.stepCount,
          hasSubmit:       !!visibleSubmitBtn,
          submitText:      visibleSubmitBtn?.innerText?.trim().slice(0, 40) || null,
          hasEmail:        !!emailInput,
          emailId:         emailInput?.id   || null,
          emailName:       emailInput?.name || null,
          inputCount:      visibleInputs.length,
          scrollY:         Math.max(0, form.getBoundingClientRect().top + window.scrollY - 150),
        };
      })
      .filter((f) => f.visible && f.inputCount > 0 && f.hasSubmit);
  });
}

// ─── Get CURRENTLY VISIBLE email input ───────────────────────────────────────
// Multi-step forms show different inputs per step — must query live DOM

async function getVisibleEmailInput(page, formIndex) {
  return page.evaluate((idx) => {
    const form = document.querySelectorAll('form')[idx];
    if (!form) return null;

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }

    const candidates = Array.from(form.querySelectorAll('input')).filter(isVisible);
    const emailEl = candidates.find(
      (i) => i.type === 'email'
        || i.name?.toLowerCase() === 'email'
        || i.name?.toLowerCase().includes('email')
        || i.id?.toLowerCase().includes('email')
        || i.placeholder?.toLowerCase().includes('email')
        || i.placeholder?.toLowerCase().includes('@')
        || i.getAttribute('autocomplete') === 'email'
    );

    return emailEl ? { id: emailEl.id, name: emailEl.name, type: emailEl.type } : null;
  }, formIndex);
}

// ─── Click the visible submit/next button ─────────────────────────────────────
// Returns selector string used, or null if not found
// Uses page.click() directly — avoids stale handle timeout

async function clickVisibleSubmitButton(page, formIndex) {
  const sel = await page.evaluate((idx) => {
    const form = document.querySelectorAll('form')[idx];
    if (!form) return null;

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
        && !el.disabled;
    }

    // Find active step container first (Stripe-style multi-step)
    const activeStep = form.querySelector(
      '[class*="is-active"] [class*="continue"], [class*="active"] [class*="continue"], ' +
      '[class*="current"] button[type="submit"], [class*="current"] button[type="button"]'
    );

    const btns = Array.from(form.querySelectorAll(
      'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"]):not([class*="back"]):not([class*="dismiss"]):not([class*="close"])'
    )).filter(isVisible);

    // Prefer Continue/Next/Submit buttons — skip Back/Dismiss
    const primary = btns.find((b) => {
      const t = (b.innerText || b.value || '').trim().toLowerCase();
      return /^(continue|next|submit|proceed|send|get started|book)/.test(t);
    }) || btns[0];

    if (!primary) return null;

    // Build a unique selector
    if (primary.className) {
      const cls = primary.className.trim().split(/\s+/)
        .filter(c => c && !c.includes(' '))[0];
      if (cls) return `.${cls}`;
    }
    if (primary.id) return `#${primary.id}`;
    if (primary.type === 'submit') return `form:nth-child(${idx + 1}) [type="submit"]`;
    return null;
  }, formIndex);

  if (!sel) return false;

  try {
    await page.click(sel, { timeout: 5000 });
    return true;
  } catch {
    // Fallback: evaluate click directly
    await page.evaluate((s) => document.querySelector(s)?.click(), sel);
    return true;
  }
}

// ─── Check DOM validation state after submit attempt ─────────────────────────

async function checkValidationState(page, formIndex) {
  return page.evaluate((idx) => {
    const form = document.querySelectorAll('form')[idx];
    if (!form) return { any: false };

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }

    // HTML5 native validation — check all visible inputs
    const inputs = Array.from(form.querySelectorAll('input, textarea, select')).filter(isVisible);
    const invalidNative = inputs.filter((i) => i.validity && !i.validity.valid);

    // Custom error elements that are NOW visible
    const errorEls = Array.from(form.querySelectorAll(
      '[class*="error"]:not(form), [class*="invalid"], [class*="danger"], ' +
      '[role="alert"], [aria-invalid="true"], [class*="validation"], ' +
      '[class*="field-message"], [class*="help-text"], [class*="feedback"]'
    )).filter(isVisible).filter((el) => el.innerText?.trim().length > 0);

    // aria-describedby connections (accessibility error pattern)
    const ariaErrors = inputs
      .filter((i) => i.getAttribute('aria-invalid') === 'true')
      .map((i) => {
        const descId = i.getAttribute('aria-describedby');
        const descEl = descId ? document.getElementById(descId) : null;
        return descEl?.innerText?.trim() || null;
      })
      .filter(Boolean);

    const validationMessages = invalidNative
      .filter((i) => i.validationMessage)
      .slice(0, 3)
      .map((i) => ({ field: i.name || i.id || i.type, msg: i.validationMessage }));

    const errorTexts = [
      ...errorEls.slice(0, 3).map((el) => el.innerText.trim().slice(0, 80)),
      ...ariaErrors.slice(0, 2),
    ];

    return {
      any:                invalidNative.length > 0 || errorEls.length > 0 || ariaErrors.length > 0,
      nativeCount:        invalidNative.length,
      customCount:        errorEls.length,
      ariaCount:          ariaErrors.length,
      method:             invalidNative.length > 0 ? 'html5-native' : errorEls.length > 0 ? 'custom-ui' : 'aria',
      validationMessages,
      errorTexts,
    };
  }, formIndex);
}

// ─── Test a single form ───────────────────────────────────────────────────────

async function testForm(page, formMeta) {
  const result = {
    index:        formMeta.index,
    label:        formMeta.label,
    isMultiStep:  formMeta.isMultiStep,
    hasEmail:     formMeta.hasEmail,
    emptySubmit:  { tested: false, validationShown: false, method: null, detail: null },
    invalidEmail: { tested: false, caught: false, detail: null },
    errorMessages: { visible: false, clear: false, detail: null },
    aiAnalysis:   null,
    score:        100,
    issues:       [],
  };

  try {
    // Scroll form into view
    await page.evaluate((idx) => {
      document.querySelectorAll('form')[idx]?.scrollIntoView({ behavior: 'instant', block: 'center' });
    }, formMeta.index);
    await sleep(400);

    const isMultiStep = formMeta.isMultiStep;
    console.log(`      Type: ${isMultiStep ? '🔢 multi-step' : '📄 single-step'}`);

    // ── Screenshot BEFORE ────────────────────────────────────────────────
    const beforeShot = await takeScreenshot(page);

    // ── TEST 1: Empty submit ─────────────────────────────────────────────
    result.emptySubmit.tested = true;

    await clickVisibleSubmitButton(page, formMeta.index);
    await sleep(INTERACTION_WAIT);

    const afterEmpty = await checkValidationState(page, formMeta.index);
    const afterEmptyShot = await takeScreenshot(page);

    if (afterEmpty.any) {
      result.emptySubmit.validationShown = true;
      result.emptySubmit.method         = afterEmpty.method;
      result.emptySubmit.detail         = afterEmpty.validationMessages.length
        ? afterEmpty.validationMessages
        : afterEmpty.errorTexts;
    }

    // ── TEST 2: Invalid email ────────────────────────────────────────────
    let afterEmailShot = null;

    // For multi-step: email might be on step 1 (current) or later step
    // We test whatever email input is CURRENTLY VISIBLE
    const liveEmailInfo = await getVisibleEmailInput(page, formMeta.index);

    if (liveEmailInfo) {
      result.invalidEmail.tested = true;

      // Build selector from live info
      const sel = liveEmailInfo.id   ? `#${liveEmailInfo.id}`
                : liveEmailInfo.name ? `[name="${liveEmailInfo.name}"]`
                : 'input[type="email"]';

      try {
        const emailEl = await page.$(sel) || await page.$('input[type="email"]');

        if (emailEl) {
          // Clear → type bad email → blur to trigger validation
          await emailEl.click({ clickCount: 3 });
          await emailEl.fill('');
          await emailEl.type('notanemail@@bad', { delay: 15 });
          await emailEl.press('Tab');
          await sleep(400);

          // Check immediately after blur (catches on-blur validation)
          const afterBlur = await checkValidationState(page, formMeta.index);

          // Also try submitting with bad email
          await clickVisibleSubmitButton(page, formMeta.index);
          await sleep(INTERACTION_WAIT);

          const afterEmailSubmit = await checkValidationState(page, formMeta.index);

          // Check native validity directly on the element
          const nativeInvalid = await page.evaluate((s) => {
            const el = document.querySelector(s);
            return el ? !el.validity?.valid : false;
          }, sel);

          const caught = afterBlur.any || afterEmailSubmit.any || nativeInvalid;
          result.invalidEmail.caught = caught;

          // Detail message
          const msgs = [...(afterEmailSubmit.validationMessages || []), ...(afterBlur.validationMessages || [])];
          const errs = [...(afterEmailSubmit.errorTexts || []), ...(afterBlur.errorTexts || [])];
          result.invalidEmail.detail = msgs[0]?.msg || errs[0] || (caught ? 'Validation triggered' : null);

          afterEmailShot = await takeScreenshot(page);
        }
      } catch (err) {
        result.invalidEmail.detail = `Test error: ${err.message.slice(0, 60)}`;
      }
    } else if (formMeta.hasEmail && isMultiStep) {
      // Email field not on current step — note it but don't penalize
      result.invalidEmail.tested  = true;
      result.invalidEmail.caught  = true;  // assume present on another step
      result.invalidEmail.detail  = 'Email field on later step — not tested in current view';
    }

    // ── AI Vision analysis ───────────────────────────────────────────────
    try {
      result.aiAnalysis = await analyzeFormWithAI(
        beforeShot, afterEmptyShot, afterEmailShot, formMeta
      );

      const ai = result.aiAnalysis;

      // AI overrides DOM if DOM missed something
      if (!result.emptySubmit.validationShown && ai?.emptySubmit?.validationVisible) {
        result.emptySubmit.validationShown = true;
        result.emptySubmit.method  = 'ai-detected';
        result.emptySubmit.detail  = ai.emptySubmit.description;
      }
      if (result.invalidEmail.tested && !result.invalidEmail.caught && ai?.invalidEmail?.caught) {
        result.invalidEmail.caught = true;
        result.invalidEmail.detail = ai.invalidEmail.description;
      }

      result.errorMessages.visible = ai?.errorMessages?.visible ?? afterEmpty.any;
      result.errorMessages.clear   = ai?.errorMessages?.clear   ?? false;
      result.errorMessages.detail  = ai?.errorMessages?.description ?? null;

    } catch (err) {
      // AI failed — use DOM results only
      result.errorMessages.visible = afterEmpty.any;
      result.errorMessages.detail  = 'AI analysis unavailable';
      console.warn(`      ⚠️  AI failed: ${err.message.slice(0, 60)}`);
    }

    // ── Score ────────────────────────────────────────────────────────────
    if (!result.emptySubmit.validationShown) {
      result.score -= WEIGHTS.emptySubmit;
      result.issues.push({ type: 'critical', code: 'EMPTY_SUBMIT_NO_VALIDATION',
        message: `"${formMeta.label}" — no validation on empty submit` });
    }

    if (result.invalidEmail.tested && !result.invalidEmail.caught) {
      result.score -= WEIGHTS.invalidEmail;
      result.issues.push({ type: 'warning', code: 'INVALID_EMAIL_NOT_CAUGHT',
        message: `"${formMeta.label}" — invalid email accepted without error` });
    }

    if (!result.errorMessages.visible) {
      result.score -= Math.round(WEIGHTS.errorMessages * 0.5);
      result.issues.push({ type: 'warning', code: 'ERROR_MESSAGES_NOT_VISIBLE',
        message: `"${formMeta.label}" — error messages not clearly visible` });
    } else if (!result.errorMessages.clear) {
      result.score -= Math.round(WEIGHTS.errorMessages * 0.2);
      result.issues.push({ type: 'info', code: 'ERROR_MESSAGES_VAGUE',
        message: `"${formMeta.label}" — errors shown but wording could be more specific` });
    }

    result.score = Math.max(0, result.score);

  } catch (err) {
    result.score = 0;
    result.issues.push({ type: 'critical', code: 'FORM_TEST_CRASHED',
      message: `"${formMeta.label}": ${err.message.slice(0, 100)}` });
  }

  return result;
}

// ─── AI Vision ────────────────────────────────────────────────────────────────

const FORM_VISION_SYSTEM = `You are a QA engineer reviewing form validation screenshots.
You will receive 2-3 screenshots: before interaction, after empty submit, and optionally after invalid email.

Return ONLY valid JSON — no markdown, no extra text.

{
  "emptySubmit": {
    "validationVisible": true,
    "description": "e.g. 'Red borders on required fields, 3 inline error messages shown below fields'"
  },
  "invalidEmail": {
    "caught": true,
    "description": "e.g. 'Please enter a valid email address shown below the email field'"
  },
  "errorMessages": {
    "visible": true,
    "clear": true,
    "description": "e.g. 'Inline red text below each field, specific messages like This field is required'"
  },
  "generalObservations": "other UX observations or null"
}

Rules:
- validationVisible: ANY visual change = true (red borders, error text, highlights, shake animation)
- caught: email error shown after bad email entry = true
- errorMessages.visible: error text actually on screen = true
- errorMessages.clear: message is specific + helpful (not just 'Error' or 'Invalid') = true
- If screenshots look identical → validationVisible: false`;

async function analyzeFormWithAI(beforeB64, afterEmptyB64, afterEmailB64, formMeta, attempt = 1) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const content = [
    { type: 'text',  text: `Form: "${formMeta.label}" | Multi-step: ${formMeta.isMultiStep} | Has email: ${formMeta.hasEmail}` },
    { type: 'text',  text: '📸 BEFORE (initial state):' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: beforeB64 } },
    { type: 'text',  text: '📸 AFTER EMPTY SUBMIT:' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: afterEmptyB64 } },
  ];

  if (afterEmailB64) {
    content.push({ type: 'text',  text: '📸 AFTER INVALID EMAIL ("notanemail@@bad"):' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: afterEmailB64 } });
  }

  content.push({ type: 'text', text: 'Compare screenshots and report validation feedback visible.' });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: MAX_TOKENS, system: FORM_VISION_SYSTEM,
      messages: [{ role: 'user', content }] }),
  });

  if (res.status === 429) {
    if (attempt > 3) throw new Error('Rate limit');
    await sleep(8000 * attempt);
    return analyzeFormWithAI(beforeB64, afterEmptyB64, afterEmailB64, formMeta, attempt + 1);
  }
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);

  return parseJSON((await res.json()).content?.[0]?.text || '');
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function auditForms(context, url, timeout = 20_000) {
  const page = await context.newPage();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response   = await page.goto(url, { waitUntil: 'load', timeout });
    const httpStatus = response?.status() ?? null;

    if (!httpStatus || httpStatus >= 400) {
      return { url, httpStatus, overallStatus: 'critical', score: 0, formsFound: 0, formResults: [],
        issues: [{ type: 'critical', code: 'PAGE_LOAD_FAILED', message: `HTTP ${httpStatus}` }] };
    }

    try { await page.waitForFunction(() => document.body?.innerText?.trim().length > 100, { timeout: 5000 }); }
    catch {}

    // Wait for JS-rendered forms — try up to 3 times with increasing delays
    // Covers: lazy-loaded forms, iframe embeds that inject form HTML, SPA route transitions
    let forms = await findForms(page);

    if (forms.length === 0) {
      console.log(`   ⏳ No forms yet — waiting for JS render...`);

      // Round 1: wait for any <form> element to appear in DOM
      try {
        await page.waitForSelector('form', { timeout: 5000 });
        forms = await findForms(page);
      } catch {}

      // Round 2: still nothing — wait for visible input fields (some forms skip <form> tag)
      if (forms.length === 0) {
        try {
          await page.waitForSelector('input:not([type="hidden"]), textarea', { timeout: 5000 });
          await page.waitForTimeout(800); // let surrounding form structure render
          forms = await findForms(page);
        } catch {}
      }

      // Round 3: scroll down — some forms are below fold and lazy-load on scroll
      if (forms.length === 0) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(1500);
        forms = await findForms(page);
      }
    }

    console.log(`   📋 Found ${forms.length} testable form(s)${forms.filter(f => f.isMultiStep).length ? ` (${forms.filter(f => f.isMultiStep).length} multi-step)` : ''}`);

    if (forms.length === 0) {
      return { url, httpStatus, overallStatus: 'healthy', score: 100, formsFound: 0, formResults: [],
        issues: [{ type: 'info', code: 'NO_FORMS', message: 'No testable forms found — page may use an iframe embed or require user interaction to reveal form' }] };
    }

    const toTest     = forms.slice(0, MAX_FORMS);
    const formResults = [];

    for (const formMeta of toTest) {
      console.log(`   🧪 Form ${formMeta.index + 1}: "${formMeta.label}" [inputs:${formMeta.inputCount} email:${formMeta.hasEmail} multiStep:${formMeta.isMultiStep}]`);

      // Reload for clean state before each form
      if (formMeta.index > 0) {
        await page.goto(url, { waitUntil: 'load', timeout });
        try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}
      }

      const result = await testForm(page, formMeta);
      formResults.push(result);

      const icon = result.score === 100 ? '✅' : result.score >= 60 ? '⚠️ ' : '❌';
      console.log(`      ${icon} Score:${result.score}  empty:${result.emptySubmit.validationShown ? '✅' : '❌'}  email:${result.invalidEmail.tested ? (result.invalidEmail.caught ? '✅' : '❌') : '—'}  msgs:${result.errorMessages.visible ? '✅' : '❌'}`);
    }

    const avgScore  = Math.round(formResults.reduce((s, f) => s + f.score, 0) / formResults.length);
    const allIssues = formResults.flatMap((f) => f.issues);
    const criticals = allIssues.filter((i) => i.type === 'critical');
    const warnings  = allIssues.filter((i) => i.type === 'warning');

    return {
      url, httpStatus,
      overallStatus: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
      score: avgScore, formsFound: forms.length, formsTested: toTest.length, formResults, issues: allIssues,
    };

  } catch (err) {
    return { url, httpStatus: null, overallStatus: 'critical', score: 0, formsFound: 0, formResults: [],
      issues: [{ type: 'critical', code: 'AUDIT_FATAL', message: `Forms crashed: ${err.message}` }],
      fatalError: err.message };
  } finally {
    await page.close();
  }
}

module.exports = { auditForms };