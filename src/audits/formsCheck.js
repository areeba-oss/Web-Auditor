'use strict';

/**
 * formsCheck.js — Layer 4 audit: Forms Testing (v2.2)
 *
 *   Fully DOM-based validation. No AI/vision dependency.
 *   DOM truth is primary. AI vision is enhancement only — never the sole source.
 *   When API key is missing, DOM intrinsic rules give deterministic results.
 *
 * Form categories:
 *   'skip'   -> search boxes, login-only pairs
 *   'simple' -> newsletter/subscribe widgets (1-2 fields) — audit email only
 *   'full'   -> contact / lead / multi-field forms — full audit
 *
 * Intrinsic validation rules:
 *   Empty submit: form has required fields + no novalidate
 *     -> browser MUST block -> check validity.valid on each required input
 *   Email: field is type="email" + required
 *     -> browser MUST reject bad format -> check typeMismatch + validity.valid
 *   Custom UI: check error elements visible after submit attempt
 */

const MAX_FORMS        = 10;
const MAX_LINKS        = Number(process.env.FORMS_MAX_LINKS || 24);
const CRAWL_BUDGET_MS  = Number(process.env.FORMS_CRAWL_BUDGET_MS || 25_000);
const MAX_CRAWL_FORMS  = Number(process.env.FORMS_MAX_CRAWL_FORMS || MAX_FORMS);
const INTERACTION_WAIT = 900;
const POPUP_WAIT       = 1200;
const NAV_TIMEOUT      = 15_000;
const BOT_BLOCKED_STATUS = new Set([401, 403, 429]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHTS = {
  emptySubmit:    35,
  invalidEmail:   25,
  requiredFields: 15,
  errorMessages:  25,
};

// ─── DOM: find all forms + metadata ──────────────────────────────────────────

async function findForms(page, scopeSelector) {
  return page.evaluate(function(scopeSel) {

    function asLowerText(value) {
      if (value == null) return '';
      if (typeof value === 'string') return value.toLowerCase();
      if (typeof value === 'object' && value.baseVal != null) return String(value.baseVal).toLowerCase();
      return String(value).toLowerCase();
    }

    function isVisible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0;
    }

    // Classify: 'skip' | 'simple' | 'full'
    function classifyForm(form, inputs, submitBtn) {
      var action    = (form.action || '').toLowerCase();
      var formRole  = (form.getAttribute('role') || '').toLowerCase();
      var formCls   = asLowerText(form.className);
      var formId    = asLowerText(form.id);
      var submitTxt = ((submitBtn && (submitBtn.innerText || submitBtn.value)) || '').trim().toLowerCase();
      var innerTxt  = (form.innerText || '').slice(0, 500).toLowerCase();

      // SKIP: search forms
      if (formRole === 'search') return 'skip';
      if (/\/search|[?&]s=|[?&]q=/.test(action)) return 'skip';
      if (/\bsearch(-form)?\b/.test(formId) || /\bsearch(-form)?\b/.test(formCls)) return 'skip';
      if (inputs.length === 1) {
        var inp = inputs[0];
        var t = (inp.type || 'text').toLowerCase();
        var p = (inp.placeholder || '').toLowerCase();
        var n = (inp.name || inp.id || '').toLowerCase();
        if (t === 'search') return 'skip';
        if (/\b(search|query|keyword)\b/.test(n)) return 'skip';
        if (/^search\b|find products|look for/i.test(p)) return 'skip';
        if (/^search$/.test(submitTxt)) return 'skip';
      }

      // SKIP: login-only (email/username + password, nothing else)
      var hasPassword = inputs.some(function(i) { return i.type === 'password'; });
      if (hasPassword && inputs.length <= 2) return 'skip';

      // SIMPLE: newsletter/subscribe — 1 or 2 inputs, email-based
      var isSubscribeCtx = /subscribe|newsletter|sign.?up|notify|mailing list/i.test(submitTxt)
        || /subscribe|newsletter/.test(formCls)
        || /subscribe|newsletter/.test(formId)
        || /subscribe|newsletter/.test(action)
        || /newsletter|subscribe|stay (in touch|updated)|mailing list/i.test(innerTxt);

      if (inputs.length <= 2 && isSubscribeCtx) {
        var hasEmail = inputs.some(function(i) {
          return i.type === 'email' || /email/.test((i.name || i.id || '').toLowerCase());
        });
        if (hasEmail) return 'simple';
      }

      return 'full';
    }

    // Multi-step detection
    function detectMultiStep(form) {
      var stepIndicators = form.querySelectorAll(
        '[class*="step"], [class*="wizard"], [class*="progress"], [aria-label*="step" i], [data-step], [class*="StepIndicator"]'
      );
      var fieldsets = form.querySelectorAll('fieldset');
      var nextBtns = Array.from(form.querySelectorAll('button, input[type="submit"]')).filter(function(b) {
        var t = (b.innerText || b.value || '').trim().toLowerCase();
        return /^(next|continue|proceed|forward|go|weiter|suivant)$/i.test(t);
      });
      var stepDivs = Array.from(form.querySelectorAll('[data-step], [class*="step-"]'))
        .filter(function(el) { return el.tagName !== 'BUTTON'; });
      return {
        isMultiStep:    stepIndicators.length > 0 || nextBtns.length > 0 || stepDivs.length > 1,
        hasNextButton:  nextBtns.length > 0,
        nextButtonText: nextBtns[0] ? nextBtns[0].innerText.trim() : null,
        stepCount:      Math.max(stepIndicators.length, stepDivs.length, fieldsets.length),
      };
    }

    // Smart label — priority chain
    function getFormLabel(form, i) {
      var aria = form.getAttribute('aria-label') || form.getAttribute('data-form-name');
      if (aria) return aria;
      var pluginTitle = form.querySelector(
        '.gform_title, .nf-form-title, .wpcf7-form-title, .form-title, [class*="form-heading"], h2.title, h3.title'
      );
      if (pluginTitle && pluginTitle.innerText.trim()) return pluginTitle.innerText.trim();
      var legend = form.querySelector('legend');
      if (legend && legend.innerText.trim()) return legend.innerText.trim();
      var sib = form.previousElementSibling;
      for (var tries = 0; tries < 4 && sib; tries++) {
        var h = sib.matches('h1,h2,h3,h4') ? sib : sib.querySelector('h1,h2,h3,h4');
        if (h && h.innerText.trim()) return h.innerText.trim();
        sib = sib.previousElementSibling;
      }
      var internalH = form.querySelector('h1,h2,h3,h4');
      if (internalH && internalH.innerText.trim()) return internalH.innerText.trim();
      var pageH1 = document.querySelector('h1');
      if (pageH1 && pageH1.innerText.trim() && document.querySelectorAll('form').length <= 2)
        return pageH1.innerText.trim();
      var submitEl = form.querySelector('button[type="submit"], input[type="submit"]');
      var submitTxt = ((submitEl && (submitEl.innerText || submitEl.value)) || '').trim();
      if (submitTxt && submitTxt.length > 2 && submitTxt.length < 40) return submitTxt + ' form';
      return 'Form ' + (i + 1);
    }

    // Intrinsic rules — what should happen according to HTML spec
    function getIntrinsicRules(form, inputs) {
      var noValidate = form.hasAttribute('novalidate');
      var requiredInputs = inputs.filter(function(i) {
        return i.required || i.getAttribute('aria-required') === 'true';
      });
      var emailInputs = inputs.filter(function(i) {
        return i.type === 'email'
          || /email/.test((i.name || '').toLowerCase())
          || /email/.test((i.placeholder || '').toLowerCase())
          || i.getAttribute('autocomplete') === 'email';
      });
      var requiredEmails = emailInputs.filter(function(i) {
        return i.required || i.getAttribute('aria-required') === 'true';
      });
      return {
        noValidate,
        browserWillBlockEmpty: !noValidate && requiredInputs.length > 0,
        browserWillCatchEmail: !noValidate && requiredEmails.length > 0,
        requiredCount:         requiredInputs.length,
        emailCount:            emailInputs.length,
        requiredEmailCount:    requiredEmails.length,
        customValidationExpected: noValidate,
      };
    }

    function detectRegion(form) {
      if (form.closest('header, [role="banner"], .site-header, [class*="header"]')) return 'header';
      if (form.closest('footer, [role="contentinfo"], .site-footer, [class*="footer"]')) return 'footer';
      return 'body';
    }

    var root  = scopeSel ? document.querySelector(scopeSel) : document;
    var forms = Array.from((root || document).querySelectorAll('form'));

    return forms.map(function(form, i) {
      var allInputs = Array.from(form.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),textarea,select'
      ));
      var activeStep = form.querySelector('[class*="is-active"]')
        || form.querySelector('[class*="active"][class*="step"]')
        || form.querySelector('[aria-selected="true"]')
        || form.querySelector('[class*="current"][class*="step"]');
      var scopedInputs = Array.from((activeStep || form).querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),textarea,select'
      ));
      var visibleInputs = (scopedInputs.length > 0 ? scopedInputs : allInputs).filter(isVisible);

      var allBtns = Array.from(form.querySelectorAll(
        'button[type="submit"],input[type="submit"],button:not([type="button"]):not([type="reset"])'
      ));
      var visibleSubmitBtn = allBtns.find(isVisible);

      var category = classifyForm(form, visibleInputs, visibleSubmitBtn);
      if (category === 'skip') return null;

      var emailInput = visibleInputs.find(function(inp) {
        return inp.type === 'email'
          || /email/.test((inp.name || '').toLowerCase())
          || /email/.test((inp.placeholder || '').toLowerCase())
          || inp.getAttribute('autocomplete') === 'email';
      });
      var requiredInputs = visibleInputs.filter(function(inp) {
        return inp.required || inp.getAttribute('aria-required') === 'true';
      });

      var label     = getFormLabel(form, i).slice(0, 70);
      var multiStep = detectMultiStep(form);
      var intrinsic = getIntrinsicRules(form, visibleInputs);
      var region    = detectRegion(form);

      // Fingerprint: input names + action path + submit text
      // Simple (newsletter) forms: dedupe aggressively across all pages — same widget = one test
      var inputSig   = visibleInputs.map(function(inp) { return inp.name || inp.id || inp.type; }).sort().join('|');
      var actionPath = (function() { try { return new URL(form.action).pathname; } catch(e) { return form.action || ''; } })();
      var submitTxt  = ((visibleSubmitBtn && (visibleSubmitBtn.innerText || visibleSubmitBtn.value)) || '').trim().toLowerCase().slice(0, 30);
      var fingerprint;
      var dedupeKey;
      if (category === 'simple') {
        // All instances of the same subscribe widget on different pages collapse to one
        fingerprint = 'simple::' + visibleInputs.length + '::' + submitTxt + '::' + actionPath;
        dedupeKey = fingerprint;
      } else {
        fingerprint = inputSig + '::' + actionPath + '::' + submitTxt;
        // Shared chrome forms in header/footer should be tested once globally.
        // Body forms remain page-content oriented and can be discovered as unique across pages.
        dedupeKey = (region === 'header' || region === 'footer')
          ? ('shared::' + region + '::' + fingerprint)
          : fingerprint;
      }

      return {
        index:          i,
        label:          label,
        category:       category,
        visible:        isVisible(form),
        isMultiStep:    multiStep.isMultiStep,
        hasNextButton:  multiStep.hasNextButton,
        nextButtonText: multiStep.nextButtonText,
        stepCount:      multiStep.stepCount,
        hasSubmit:      !!visibleSubmitBtn,
        submitText:     visibleSubmitBtn ? (visibleSubmitBtn.innerText || '').trim().slice(0, 40) : null,
        hasEmail:       !!emailInput,
        emailId:        emailInput ? emailInput.id   : null,
        emailName:      emailInput ? emailInput.name : null,
        inputCount:     visibleInputs.length,
        requiredCount:  requiredInputs.length,
        intrinsic:      intrinsic,
        region:         region,
        scrollY:        Math.max(0, form.getBoundingClientRect().top + window.scrollY - 150),
        fingerprint:    fingerprint,
        dedupeKey:      dedupeKey,
      };
    })
    .filter(Boolean)
    .filter(function(f) { return f.visible && f.inputCount > 0 && f.hasSubmit; });
  }, scopeSelector || null);
}

// ─── DOM: detect open popup ───────────────────────────────────────────────────

async function detectOpenPopup(page) {
  return page.evaluate(function() {
    var selectors = [
      '[role="dialog"]', '[aria-modal="true"]',
      '.modal', '.modal-dialog', '.modal-content',
      '[class*="dialog"]', '[class*="drawer"]', '[class*="slide-in"]',
      '[class*="overlay"]', '[class*="lightbox"]', '[class*="popup"]',
    ];
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 50 && r.height > 50
        && s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0;
    }
    for (var si = 0; si < selectors.length; si++) {
      var visible = Array.from(document.querySelectorAll(selectors[si])).find(isVisible);
      if (visible) {
        var hasFormTag = !!visible.querySelector('form');
        var visibleInputs = Array.from(visible.querySelectorAll(
          'input:not([type="hidden"]),textarea,select'
        )).filter(isVisible);
        var hasSubmit = !!Array.from(visible.querySelectorAll(
          'button[type="submit"],input[type="submit"],button:not([type="button"]):not([type="reset"])'
        )).find(isVisible);
        return {
          found: true,
          selector: selectors[si],
          hasForm: hasFormTag || (visibleInputs.length >= 2 && hasSubmit),
        };
      }
    }
    return { found: false };
  });
}

// ─── DOM: collect crawl triggers ──────────────────────────────────────────────

async function collectTriggers(page, baseUrl) {
  return page.evaluate(function(base) {
    function cssEscapeSafe(s) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
      return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }
    function buildStableSelector(el) {
      if (!el || !el.tagName) return null;
      if (el.id) return '#' + cssEscapeSafe(el.id);
      var testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
      if (testId) return el.tagName.toLowerCase() + '[data-testid="' + cssEscapeSafe(testId) + '"]';

      var path = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        var tag = node.tagName.toLowerCase();
        var cls = (node.className || '').trim().split(/\s+/)
          .filter(function(c) { return c && !c.includes(':'); })
          .slice(0, 2)
          .map(cssEscapeSafe);
        var seg = tag + (cls.length ? '.' + cls.join('.') : '');

        if (node.parentElement) {
          var siblings = Array.from(node.parentElement.children).filter(function(s) { return s.tagName === node.tagName; });
          if (siblings.length > 1) {
            var idx = siblings.indexOf(node) + 1;
            seg += ':nth-of-type(' + idx + ')';
          }
        }

        path.unshift(seg);
        if (node.parentElement && node.parentElement.id) {
          path.unshift('#' + cssEscapeSafe(node.parentElement.id));
          break;
        }
        node = node.parentElement;
        depth += 1;
      }
      return path.join(' > ');
    }

    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0;
    }
    var triggers = [];
    var seen = new Set();

    Array.from(document.querySelectorAll('a[href]')).filter(isVisible).forEach(function(a) {
      var href = a.href;
      if (!href || /^(javascript:|mailto:|tel:)/.test(href)) return;
      try {
        var u = new URL(href), b = new URL(base);
        if (u.origin !== b.origin) return;
        if (u.pathname === b.pathname && !u.hash) return;
      } catch(e) { return; }
      if (seen.has(href)) return;
      seen.add(href);
      var text = (a.innerText || '').trim().slice(0, 50) || a.getAttribute('aria-label') || href.split('/').pop();
      triggers.push({ type: 'link', href: href, text: text, selector: null });
    });

    var btnKeywords = /contact|form|sign.?up|register|get.?start|subscribe|book|schedule|demo|quote|apply|request|inquir|feedback|consult|trial/i;
    var modalCls    = /modal|popup|dialog|drawer|overlay|open/i;
    var hasModalAttr = function(el) {
      return !!(
        el.getAttribute('aria-controls') ||
        el.getAttribute('aria-haspopup') ||
        el.getAttribute('data-modal') ||
        el.getAttribute('data-open') ||
        el.getAttribute('data-target') ||
        el.getAttribute('data-bs-target') ||
        el.getAttribute('data-toggle') ||
        el.getAttribute('data-bs-toggle')
      );
    };
    Array.from(document.querySelectorAll(
      'button,[role="button"],a[href="#"],input[type="button"],[class*="btn"],[class*="cta"]'
    )).filter(isVisible).forEach(function(el) {
      var text = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.value || '';
      var cls = el.className || '';
      var attrText = (el.getAttribute('aria-controls') || '') + ' ' + (el.getAttribute('data-target') || '') + ' ' + (el.getAttribute('data-bs-target') || '');
      if (!btnKeywords.test(text) && !btnKeywords.test(cls) && !modalCls.test(cls) && !modalCls.test(attrText) && !hasModalAttr(el)) return;
      var sel = buildStableSelector(el);
      if (!sel || seen.has(sel)) return;
      seen.add(sel);
      triggers.push({ type: 'button', href: null, text: text || 'open', selector: sel });
    });

    return triggers;
  }, baseUrl);
}

// ─── Probe a trigger ─────────────────────────────────────────────────────────

async function probeTrigger(context, baseUrl, trigger, knownFingerprints) {
  const discovered = [];
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(baseUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    try { await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 4000 }); } catch {}

    if (trigger.type === 'link') {
      const navRes = await page.goto(trigger.href, { waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(() => null);
      if (!navRes || navRes.status() >= 400) return [];
      try { await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 4000 }); } catch {}
      await sleep(800);
      const forms    = await findFormsWithRetry(page);
      const newForms = forms.filter((f) => !knownFingerprints.has(f.dedupeKey || f.fingerprint));
      if (newForms.length > 0)
        discovered.push({ forms: newForms, source: 'link:' + trigger.href, pageUrl: trigger.href, popupSelector: null });

    } else if (trigger.type === 'button') {
      const newPagePromise = new Promise((resolve) => context.once('page', (p) => resolve(p)));
      const beforeUrl = page.url();
      try { await page.click(trigger.selector, { timeout: 5000 }); }
      catch { await page.evaluate((s) => { var el = document.querySelector(s); if (el) el.click(); }, trigger.selector); }
      await sleep(POPUP_WAIT);

      const newTab = await Promise.race([newPagePromise, sleep(1200).then(() => null)]);
      if (newTab) {
        try {
          await newTab.waitForLoadState('load', { timeout: 8000 });
          const forms    = await findFormsWithRetry(newTab);
          const newForms = forms.filter((f) => !knownFingerprints.has(f.dedupeKey || f.fingerprint));
          if (newForms.length > 0)
            discovered.push({ forms: newForms, source: 'new-tab:' + trigger.text, pageUrl: newTab.url(), popupSelector: null });
        } finally { await newTab.close().catch(() => {}); }
        return discovered;
      }

      await sleep(400);
      if (page.url() !== beforeUrl) {
        try { await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 4000 }); } catch {}
        await sleep(600);
        const forms    = await findFormsWithRetry(page);
        const newForms = forms.filter((f) => !knownFingerprints.has(f.dedupeKey || f.fingerprint));
        if (newForms.length > 0)
          discovered.push({ forms: newForms, source: 'nav:' + trigger.text, pageUrl: page.url(), popupSelector: null });
        return discovered;
      }

      const popup = await detectOpenPopup(page);
      if (popup.found && popup.hasForm) {
        const forms    = await findForms(page, popup.selector);
        const allForms = forms.length > 0 ? forms : await findForms(page, null);
        const newForms = allForms.filter((f) => !knownFingerprints.has(f.dedupeKey || f.fingerprint));
        if (newForms.length > 0)
          discovered.push({ forms: newForms, source: 'popup:' + trigger.text, pageUrl: baseUrl,
            popupSelector: popup.selector, keepOpen: true, openedBy: trigger });
      }
    }
  } catch {} // best-effort per trigger
  finally {
    if (!discovered.some((d) => d.keepOpen)) await page.close().catch(() => {});
  }
  return discovered;
}

// ─── Find forms with retry ────────────────────────────────────────────────────

async function findFormsWithRetry(page) {
  let forms = await findForms(page, null);
  if (forms.length > 0) return forms;
  try { await page.waitForSelector('form', { timeout: 4000 }); forms = await findForms(page, null); } catch {}
  if (forms.length > 0) return forms;
  try {
    await page.waitForSelector('input:not([type="hidden"]),textarea', { timeout: 4000 });
    await sleep(600);
    forms = await findForms(page, null);
  } catch {}
  if (forms.length > 0) return forms;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await sleep(1200);
  return findForms(page, null);
}

// ─── Get visible email input ──────────────────────────────────────────────────

async function getVisibleEmailInput(page, formIndex) {
  return page.evaluate(function(idx) {
    var form = document.querySelectorAll('form')[idx];
    if (!form) return null;
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }
    var emailEl = Array.from(form.querySelectorAll('input')).filter(isVisible).find(function(i) {
      return i.type === 'email'
        || /email|e-mail/.test((i.name || '').toLowerCase())
        || /email|e-mail/.test((i.id || '').toLowerCase())
        || /email|e-mail|your email/.test((i.placeholder || '').toLowerCase())
        || i.getAttribute('autocomplete') === 'email';
    });
    return emailEl ? { id: emailEl.id, name: emailEl.name, type: emailEl.type } : null;
  }, formIndex);
}

// ─── Click visible submit button ─────────────────────────────────────────────

async function clickVisibleSubmitButton(page, formIndex) {
  const sel = await page.evaluate(function(idx) {
    var form = document.querySelectorAll('form')[idx];
    if (!form) return null;
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0 && !el.disabled;
    }
    var btns = Array.from(form.querySelectorAll(
      'button[type="submit"],input[type="submit"],button:not([type="button"]):not([type="reset"]):not([class*="back"]):not([class*="dismiss"]):not([class*="close"])'
    )).filter(isVisible);
    var primary = btns.find(function(b) {
      var t = (b.innerText || b.value || '').trim().toLowerCase();
      return /^(continue|next|submit|proceed|send|get started|book|apply|subscribe|register|sign up)/.test(t);
    }) || btns[0];
    if (!primary) return null;
    if (primary.id) return '#' + primary.id;
    var cls = (primary.className || '').trim().split(/\s+/).find(function(c) { return c && !c.includes(' '); });
    if (cls) return '.' + CSS.escape(cls);
    return 'form:nth-child(' + (idx + 1) + ') [type="submit"]';
  }, formIndex);
  if (!sel) return false;
  try { await page.click(sel, { timeout: 5000 }); return true; }
  catch { await page.evaluate(function(s) { var el = document.querySelector(s); if (el) el.click(); }, sel); return true; }
}

// ─── Check DOM validation state ──────────────────────────────────────────────

async function checkValidationState(page, formIndex) {
  return page.evaluate(function(idx) {
    var form = document.querySelectorAll('form')[idx];
    if (!form) {
      return {
        any: false,
        nativeCount: 0,
        customCount: 0,
        ariaCount: 0,
        cssInvalidCount: 0,
        method: 'none',
        validationMessages: [],
        errorTexts: [],
      };
    }
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }

    var inputs = Array.from(form.querySelectorAll('input,textarea,select')).filter(isVisible);
    var invalidNative = inputs.filter(function(i) { return i.validity && !i.validity.valid; });

    var errorEls = Array.from(form.querySelectorAll(
      '[class*="error"]:not(form),[class*="invalid"],[class*="danger"],' +
      '[role="alert"],[aria-invalid="true"],[class*="validation"],' +
      '[class*="field-message"],[class*="help-text"],[class*="feedback"],' +
      '[class*="form-text"],[class*="error-message"],[class*="errMsg"],' +
      '.invalid-feedback,.field-error,.input-error'
    )).filter(isVisible).filter(function(el) { return el.innerText && el.innerText.trim().length > 0; });

    var ariaErrors = inputs
      .filter(function(i) { return i.getAttribute('aria-invalid') === 'true'; })
      .map(function(i) {
        var id = i.getAttribute('aria-describedby');
        var descEl = id ? document.getElementById(id) : null;
        return descEl && descEl.innerText ? descEl.innerText.trim() : null;
      }).filter(Boolean);

    var cssInvalidCount = inputs.filter(function(i) {
      try { return i.matches(':invalid'); } catch(e) { return false; }
    }).length;

    var validationMessages = invalidNative
      .filter(function(i) { return i.validationMessage; }).slice(0, 5)
      .map(function(i) { return { field: i.name || i.id || i.type, msg: i.validationMessage }; });

    var errorTexts = errorEls.slice(0, 5).map(function(el) { return el.innerText.trim().slice(0, 100); })
      .concat(ariaErrors.slice(0, 3));

    var any = invalidNative.length > 0 || errorEls.length > 0 || ariaErrors.length > 0 || cssInvalidCount > 0;

    return {
      any:               any,
      nativeCount:       invalidNative.length,
      customCount:       errorEls.length,
      ariaCount:         ariaErrors.length,
      cssInvalidCount:   cssInvalidCount,
      method: invalidNative.length > 0 ? 'html5-native'
            : errorEls.length > 0      ? 'custom-ui'
            : ariaErrors.length > 0    ? 'aria'
            : cssInvalidCount > 0      ? 'css-pseudo'
            : 'none',
      validationMessages: validationMessages,
      errorTexts:         errorTexts,
    };
  }, formIndex);
}

// ─── Check visible success state in/near form ───────────────────────────────

async function checkSuccessState(page, formIndex) {
  return page.evaluate(function(idx) {
    var form = document.querySelectorAll('form')[idx];
    if (!form) return { visible: false, clear: false, detail: null };
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    }

    var pool = [form];
    var parent = form.parentElement;
    if (parent) pool.push(parent);

    var sels = [
      '[role="status"]',
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[class*="success"]',
      '[class*="thank"]',
      '[class*="submitted"]',
      '[class*="confirmation"]',
      '[class*="alert-success"]',
      '[class*="notice-success"]',
      '[data-status="success"]'
    ];

    var nodes = [];
    pool.forEach(function(root) {
      sels.forEach(function(sel) {
        nodes = nodes.concat(Array.from(root.querySelectorAll(sel)));
      });
    });

    var messages = nodes
      .filter(isVisible)
      .map(function(el) { return (el.innerText || '').trim(); })
      .filter(function(t) { return t.length > 0; });

    var phraseNode = Array.from((parent || form).querySelectorAll('p,div,span,h1,h2,h3,h4,li'))
      .filter(isVisible)
      .map(function(el) { return (el.innerText || '').trim(); })
      .find(function(t) {
        return /thank you|thanks|success|submitted|sent successfully|message sent|we received|done/i.test(t);
      });

    if (phraseNode) messages.push(phraseNode);

    var visible = messages.length > 0;
    var clear = messages.some(function(t) { return t.length >= 8; });
    return {
      visible: visible,
      clear: clear,
      detail: visible ? messages[0].slice(0, 120) : null,
    };
  }, formIndex);
}

// ─── Read email field validity object directly ────────────────────────────────

async function checkEmailFieldValidity(page, sel) {
  return page.evaluate(function(s) {
    var el = document.querySelector(s);
    if (!el) return { found: false };
    return {
      found:        true,
      valid:        el.validity ? el.validity.valid        : null,
      typeMismatch: el.validity ? el.validity.typeMismatch : null,
      valueMissing: el.validity ? el.validity.valueMissing : null,
      cssInvalid:   el.matches(':invalid'),
      ariaInvalid:  el.getAttribute('aria-invalid') === 'true',
      value:        el.value,
    };
  }, sel);
}

// ─── Check required field marking ────────────────────────────────────────────

async function checkRequiredFields(page, formIndex) {
  return page.evaluate(function(idx) {
    var form = document.querySelectorAll('form')[idx];
    if (!form) return { total: 0, requiredCount: 0, markedRequired: 0, ok: true };
    function isVisible(el) {
      var r = el.getBoundingClientRect();
      var s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }
    var inputs = Array.from(form.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),textarea,select'
    )).filter(isVisible);
    var required = inputs.filter(function(i) {
      return i.required || i.getAttribute('aria-required') === 'true';
    });
    var labelled = required.filter(function(inp) {
      var lbl = inp.id ? document.querySelector('label[for="' + inp.id + '"]') : inp.closest('label');
      var lt  = (lbl && lbl.innerText) ? lbl.innerText : '';
      var wt  = (inp.closest('[class*="field"],[class*="form-group"],[class*="input-wrap"]') || {}).innerText || '';
      return lt.includes('*') || /required/i.test(lt) || wt.includes('*');
    });
    return {
      total:          inputs.length,
      requiredCount:  required.length,
      markedRequired: labelled.length,
      ok:             required.length === 0 || labelled.length === required.length,
    };
  }, formIndex);
}

// ─── Test a single form ───────────────────────────────────────────────────────

async function testForm(page, formMeta, formSource) {
  const isSimple  = formMeta.category === 'simple';
  const intrinsic = formMeta.intrinsic;

  const result = {
    index:          formMeta.index,
    label:          formMeta.label,
    category:       formMeta.category,
    source:         formSource,
    isMultiStep:    formMeta.isMultiStep,
    hasEmail:       formMeta.hasEmail,
    emptySubmit:    { tested: false, validationShown: false, method: null, detail: null, intrinsicExpected: intrinsic.browserWillBlockEmpty },
    invalidEmail:   { tested: false, caught: false, inconclusive: false, detail: null, intrinsicExpected: intrinsic.browserWillCatchEmail },
    requiredFields: { total: 0, requiredCount: 0, markedOk: true },
    errorMessages:  { visible: false, clear: false, detail: null },
    successMessages:{ visible: false, clear: false, detail: null },
    score:          100,
    issues:         [],
  };

  try {
    await page.evaluate(function(idx) {
      var el = document.querySelectorAll('form')[idx];
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }, formMeta.index);
    await sleep(400);

    console.log('      Type: ' + (formMeta.isMultiStep ? 'multi-step' : 'single-step')
      + ' | Category: ' + formMeta.category
      + ' | Inputs: ' + formMeta.inputCount
      + ' | required: ' + intrinsic.requiredCount
      + ' | novalidate: ' + intrinsic.noValidate);

    // Required field marking (full forms only)
    if (!isSimple) {
      const reqCheck = await checkRequiredFields(page, formMeta.index);
      result.requiredFields = { total: reqCheck.total, requiredCount: reqCheck.requiredCount, markedOk: reqCheck.ok };
      if (!reqCheck.ok && reqCheck.requiredCount > 0) {
        const unmarked = reqCheck.requiredCount - reqCheck.markedRequired;
        result.score -= Math.round(WEIGHTS.requiredFields * (unmarked / reqCheck.requiredCount));
        result.issues.push({ type: 'warning', code: 'REQUIRED_NOT_MARKED',
          message: '"' + formMeta.label + '" — ' + unmarked + ' required field(s) not visually marked' });
      }
    }

    // ── TEST 1: Empty submit ──────────────────────────────────────────────
    result.emptySubmit.tested = true;
    await clickVisibleSubmitButton(page, formMeta.index);
    await sleep(INTERACTION_WAIT);

    const afterEmpty     = await checkValidationState(page, formMeta.index);

    if (afterEmpty.any) {
      result.emptySubmit.validationShown = true;
      result.emptySubmit.method         = afterEmpty.method;
      result.emptySubmit.detail         = afterEmpty.validationMessages.length
        ? afterEmpty.validationMessages : afterEmpty.errorTexts;
    }

    // Intrinsic fallback: browser should have blocked — check native validity directly
    if (!result.emptySubmit.validationShown && intrinsic.browserWillBlockEmpty) {
      const nativeBlocked = await page.evaluate(function(idx) {
        var form = document.querySelectorAll('form')[idx];
        if (!form) return false;
        return Array.from(form.querySelectorAll('input,textarea,select')).some(function(i) {
          return i.validity && !i.validity.valid;
        });
      }, formMeta.index);
      if (nativeBlocked) {
        result.emptySubmit.validationShown = true;
        result.emptySubmit.method         = 'html5-native (intrinsic)';
        result.emptySubmit.detail         = 'Form has ' + intrinsic.requiredCount + ' required field(s) — native browser validation active';
      }
    }

    // ── TEST 2: Invalid email ─────────────────────────────────────────────
    const liveEmail = await getVisibleEmailInput(page, formMeta.index);

    if (liveEmail) {
      result.invalidEmail.tested = true;
      const liveEmailType = String(liveEmail.type || 'text').toLowerCase();
      const sel = liveEmail.id   ? '#' + liveEmail.id
                : liveEmail.name ? '[name="' + liveEmail.name + '"]'
                : 'input[type="email"]';

      try {
        const emailEl = await page.$(sel) || await page.$('input[type="email"]');
        if (emailEl) {
          // Type bad email and blur
          await emailEl.click({ clickCount: 3 });
          await emailEl.fill('');
          await emailEl.type('notanemail@@bad', { delay: 15 });
          await emailEl.press('Tab');
          await sleep(400);

          // Read blur-time validity — accurate regardless of novalidate
          // (novalidate only suppresses browser UI tooltips + blocks submit,
          //  but el.validity.typeMismatch is still set correctly after user input)
          const validityAfterBlur = await checkEmailFieldValidity(page, sel);
          const stateAfterBlur    = await checkValidationState(page, formMeta.index);

          // For novalidate forms: fire framework events + temporarily strip novalidate
          // so we can get a clean native validity read on submit
          if (intrinsic.noValidate) {
            // 1. Fire events that frameworks listen to (React, Vue, Angular, jQuery validate)
            await page.evaluate(function(s) {
              var el = document.querySelector(s);
              if (!el) return;
              ['input', 'change', 'focusout', 'blur'].forEach(function(evt) {
                el.dispatchEvent(new Event(evt, { bubbles: true }));
              });
            }, sel);
            await sleep(300);

            // 2. Temporarily remove novalidate so browser runs native check on submit
            //    This tells us: does the FIELD ITSELF have a valid email format?
            //    It does NOT affect the site's custom JS — those still run.
            await page.evaluate(function(idx) {
              var form = document.querySelectorAll('form')[idx];
              if (form) form.removeAttribute('novalidate');
            }, formMeta.index);
          }

          // Submit with bad email
          await clickVisibleSubmitButton(page, formMeta.index);
          await sleep(INTERACTION_WAIT);
          if (intrinsic.noValidate) await sleep(400);

          const validityAfterSubmit = await checkEmailFieldValidity(page, sel);
          const stateAfterSubmit    = await checkValidationState(page, formMeta.index);

          // Restore novalidate so page state is clean for screenshot
          if (intrinsic.noValidate) {
            await page.evaluate(function(idx) {
              var form = document.querySelectorAll('form')[idx];
              if (form) form.setAttribute('novalidate', '');
            }, formMeta.index);
          }

          // ── Ground truth checks — ordered by reliability ──────────────────
          // 1. typeMismatch after blur: browser confirmed bad email format in the field
          //    (blur validity is unaffected by novalidate — always accurate)
          const nativeMismatch = validityAfterBlur.typeMismatch === true
                              || validityAfterSubmit.typeMismatch === true;

          // 2. validity.valid false — field is in invalid state
          const nativeInvalid  = validityAfterBlur.valid === false
                              || validityAfterSubmit.valid === false;

          // 3. CSS :invalid on the field
          const cssCaught      = validityAfterBlur.cssInvalid || validityAfterSubmit.cssInvalid;

          // 4. aria-invalid on the field (custom validation)
          const ariaCaught     = validityAfterBlur.ariaInvalid || validityAfterSubmit.ariaInvalid;

          // 5. Custom error UI appeared in form
          const customCaught   = stateAfterBlur.customCount > 0 || stateAfterSubmit.customCount > 0;

          // 6. Page-level toast / alert outside form (some custom validators render here)
          const globalAlert = await page.evaluate(function() {
            function isVisible(el) {
              var r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }
            return Array.from(document.querySelectorAll(
              '[role="alert"],[class*="toast"],[class*="snack"],[class*="notification"],[class*="banner"]'
            )).filter(isVisible)
              .filter(function(el) { return el.innerText && el.innerText.trim().length > 0; })
              .map(function(el) { return el.innerText.trim().slice(0, 100); })[0] || null;
          });

          result.invalidEmail.caught = nativeMismatch || nativeInvalid || cssCaught
                                    || ariaCaught || customCaught || !!globalAlert;

          // Best detail message — most specific wins
          const msgs = (stateAfterSubmit.validationMessages || []).concat(stateAfterBlur.validationMessages || []);
          const errs = (stateAfterSubmit.errorTexts || []).concat(stateAfterBlur.errorTexts || []);
          if (msgs.length > 0) {
            result.invalidEmail.detail = msgs[0].msg;
          } else if (globalAlert) {
            result.invalidEmail.detail = 'Page alert: ' + globalAlert;
          } else if (customCaught) {
            result.invalidEmail.detail = errs[0] || 'Custom UI error shown';
          } else if (nativeMismatch || nativeInvalid || cssCaught) {
            result.invalidEmail.detail = 'Native browser validation: typeMismatch=' + validityAfterBlur.typeMismatch;
          } else {
            result.invalidEmail.detail = intrinsic.noValidate
              ? 'novalidate form — no custom JS email validation detected'
              : (liveEmailType !== 'email'
                ? 'Email-like field uses type="' + liveEmailType + '" with no client-side format validation detected'
                : 'No client-side email validation detected (native or custom)');
          }

        }
      } catch (err) {
        result.invalidEmail.detail = 'Test error: ' + err.message.slice(0, 60);
      }
    } else if (formMeta.hasEmail && formMeta.isMultiStep) {
      result.invalidEmail.tested  = true;
      result.invalidEmail.caught  = true;
      result.invalidEmail.detail  = 'Email field on later step — not tested in current view';
    }

    // ── DOM-only message assessment ───────────────────────────────────────
    result.errorMessages.visible = afterEmpty.any;
    result.errorMessages.clear   = afterEmpty.errorTexts.length > 0 || afterEmpty.validationMessages.length > 0;
    result.errorMessages.detail  = afterEmpty.errorTexts[0]
      || (afterEmpty.validationMessages[0] && afterEmpty.validationMessages[0].msg)
      || null;

    result.successMessages = await checkSuccessState(page, formMeta.index);

    // ── Scoring ───────────────────────────────────────────────────────────
    // For simple forms with no required fields: empty submit block isn't expected — don't penalize
    const emptySubmitExpected = intrinsic.requiredCount > 0;
    if (!result.emptySubmit.validationShown && emptySubmitExpected) {
      result.score -= WEIGHTS.emptySubmit;
      result.issues.push({ type: 'critical', code: 'EMPTY_SUBMIT_NO_VALIDATION',
        message: '"' + formMeta.label + '" — no validation on empty submit' });
    } else if (!result.emptySubmit.validationShown && !emptySubmitExpected) {
      // Simple form without required fields — note it but don't penalize
      result.issues.push({ type: 'info', code: 'NO_REQUIRED_FIELDS',
        message: '"' + formMeta.label + '" — no required fields set, empty submit not blocked (expected for this form type)' });
    }

    // Email: penalize only if an email field exists and validation is expected
    const emailValidationExpected = !isSimple || intrinsic.emailCount > 0;
    if (result.invalidEmail.tested && !result.invalidEmail.caught && !result.invalidEmail.inconclusive && emailValidationExpected) {
      result.score -= WEIGHTS.invalidEmail;
      result.issues.push({ type: 'warning', code: 'INVALID_EMAIL_NOT_CAUGHT',
        message: '"' + formMeta.label + '" — no client-side email format validation detected' });
    }

    // Error message scoring skipped for simple newsletter forms (they're minimal by design)
    const shouldExpectErrorMessages = emptySubmitExpected || (result.invalidEmail.tested && emailValidationExpected);
    if (!isSimple) {
      if (shouldExpectErrorMessages && !result.errorMessages.visible) {
        result.score -= Math.round(WEIGHTS.errorMessages * 0.5);
        result.issues.push({ type: 'warning', code: 'ERROR_MESSAGES_NOT_VISIBLE',
          message: '"' + formMeta.label + '" — error messages not clearly visible' });
      } else if (shouldExpectErrorMessages && !result.errorMessages.clear) {
        result.score -= Math.round(WEIGHTS.errorMessages * 0.2);
        result.issues.push({ type: 'info', code: 'ERROR_MESSAGES_VAGUE',
          message: '"' + formMeta.label + '" — errors shown but wording could be more specific' });
      }

      if (!result.successMessages.visible) {
        result.issues.push({ type: 'info', code: 'SUCCESS_MESSAGE_NOT_OBSERVED',
          message: '"' + formMeta.label + '" — no visible success/confirmation message observed during safe validation flow' });
      } else if (!result.successMessages.clear) {
        result.issues.push({ type: 'info', code: 'SUCCESS_MESSAGE_VAGUE',
          message: '"' + formMeta.label + '" — success/confirmation message visible but vague' });
      }
    }

    // Confidence guardrail: if a form exposes very little assertable validation surface,
    // avoid reporting a perfect score even when no strict rule was violated.
    const assertedChecks = [
      emptySubmitExpected,
      result.invalidEmail.tested && emailValidationExpected,
      shouldExpectErrorMessages,
      result.successMessages.visible,
    ].filter(Boolean).length;

    if (assertedChecks <= 1) {
      result.score = Math.min(result.score, 70);
      result.issues.push({
        type: 'warning',
        code: 'LOW_VALIDATION_COVERAGE',
        message: '"' + formMeta.label + '" — limited validation signals available; confidence in form QA is low',
      });
    }

    result.score = Math.max(0, result.score);

  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const interrupted = /Target page, context or browser has been closed/i.test(msg);
    if (interrupted) {
      const hadInvalidEmailFalseNegative = result.issues.some((i) => i.code === 'INVALID_EMAIL_NOT_CAUGHT');
      if (hadInvalidEmailFalseNegative) {
        result.issues = result.issues.filter((i) => i.code !== 'INVALID_EMAIL_NOT_CAUGHT');
        result.score = Math.min(100, result.score + WEIGHTS.invalidEmail);
      }
      if (result.invalidEmail.tested && !result.invalidEmail.caught) {
        result.invalidEmail.inconclusive = true;
        result.invalidEmail.detail = 'Inconclusive: test interrupted before final invalid-email verdict';
      }
      result.score = Math.min(result.score, 60);
      result.issues.push({ type: 'warning', code: 'FORM_TEST_INTERRUPTED',
        message: '"' + formMeta.label + '": test interrupted by page/context closure; result may be partial' });
    } else {
      result.score = 0;
      result.issues.push({ type: 'critical', code: 'FORM_TEST_CRASHED',
        message: '"' + formMeta.label + '": ' + msg.slice(0, 100) });
    }
  }

  return result;
}
// ─── Main export ──────────────────────────────────────────────────────────────

function logFormResult(result) {
  const icon = result.score === 100 ? '✅' : result.score >= 60 ? '⚠️ ' : '❌';
  const emailIcon = !result.invalidEmail.tested
    ? '—'
    : result.invalidEmail.inconclusive
      ? '⚠️'
      : (result.invalidEmail.caught ? '✅' : '❌');
  console.log(
    '      ' + icon + ' Score:' + result.score
    + '  empty:' + (result.emptySubmit.validationShown ? '✅' : '❌')
    + '(dom-expected:' + (result.emptySubmit.intrinsicExpected ? 'Y' : 'N') + ')'
    + '  email:' + emailIcon
    + '(dom-expected:' + (result.invalidEmail.intrinsicExpected ? 'Y' : 'N') + ')'
    + '  msgs:' + (result.errorMessages.visible ? (result.errorMessages.clear ? '✅' : '⚠️') : '❌')
    + '  [' + result.category + ']'
  );
}

async function auditForms(context, url, timeout) {
  timeout = timeout || 20_000;
  const mainPage = await context.newPage();
  const allFormResults = [];

  try {
    await mainPage.setViewportSize({ width: 1440, height: 900 });
    const response   = await mainPage.goto(url, { waitUntil: 'load', timeout });
    const httpStatus = response ? response.status() : null;

    if (!httpStatus) {
      return { url, httpStatus, overallStatus: 'critical', score: 0, formsFound: 0, formResults: [],
        issues: [{ type: 'critical', code: 'PAGE_LOAD_FAILED', message: 'HTTP ' + httpStatus }] };
    }

    if (BOT_BLOCKED_STATUS.has(httpStatus)) {
      return {
        url,
        httpStatus,
        overallStatus: 'warning',
        score: 60,
        formsFound: 0,
        formsTested: 0,
        formResults: [],
        issues: [{
          type: 'warning',
          code: 'PAGE_BOT_BLOCKED',
          message: 'HTTP ' + httpStatus + ' indicates bot/rate-limit protection; form audit could not proceed from this entry page',
        }],
      };
    }

    if (httpStatus >= 400) {
      return { url, httpStatus, overallStatus: 'critical', score: 0, formsFound: 0, formResults: [],
        issues: [{ type: 'critical', code: 'PAGE_LOAD_FAILED', message: 'HTTP ' + httpStatus }] };
    }

    try { await mainPage.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

    // Phase 1: main page
    console.log('   🔍 Phase 1: scanning main page...');
    const mainForms = await findFormsWithRetry(mainPage);
    const simpleCount = mainForms.filter((f) => f.category === 'simple').length;
    const fullCount   = mainForms.filter((f) => f.category === 'full').length;
    console.log('   📋 Found ' + mainForms.length + ' form(s) on main page (' + simpleCount + ' simple, ' + fullCount + ' full)');

    const knownFingerprints = new Set(mainForms.map((f) => f.dedupeKey || f.fingerprint));

    // Phase 2: crawl
    console.log('   🕷️  Phase 2: crawling links & buttons...');
    const triggers = await collectTriggers(mainPage, url);
    const formIntentRx = /contact|form|sign.?up|register|get.?start|subscribe|book|schedule|demo|quote|apply|request|inquir|feedback|consult|trial|support|help/i;
    const prioritizedTriggers = [...triggers].sort((a, b) => {
      const score = (t) => {
        const hay = (t.text || '') + ' ' + (t.href || '');
        const hasIntent = formIntentRx.test(hay) ? 2 : 0;
        const isButton = t.type === 'button' ? 1 : 0;
        return hasIntent + isButton;
      };
      return score(b) - score(a);
    });
    const toProbe  = prioritizedTriggers.slice(0, MAX_LINKS);
    console.log('   🔗 Probing ' + toProbe.length + ' trigger(s)...');

    const extraSources = [];
    const crawlStartedAt = Date.now();
    let discoveredViaCrawl = 0;
    for (const trigger of toProbe) {
      if (Date.now() - crawlStartedAt >= CRAWL_BUDGET_MS) {
        console.log('      ⏱️  Crawl budget reached (' + CRAWL_BUDGET_MS + 'ms), stopping trigger probe');
        break;
      }
      if (discoveredViaCrawl >= MAX_CRAWL_FORMS) {
        console.log('      ✅ Reached crawl form target (' + MAX_CRAWL_FORMS + '), stopping trigger probe');
        break;
      }
      const label = (trigger.text || trigger.href || '?').slice(0, 40);
      process.stdout.write('      -> ' + trigger.type + ': "' + label + '"... ');
      try {
        const found = await probeTrigger(context, url, trigger, knownFingerprints);
        if (found.length > 0) {
          const n = found.reduce((a, s) => a + s.forms.length, 0);
          discoveredViaCrawl += n;
          console.log('found ' + n + ' new form(s)');
          found.forEach((src) => {
            src.forms.forEach((f) => knownFingerprints.add(f.dedupeKey || f.fingerprint));
            extraSources.push(src);
          });
        } else { console.log('—'); }
      } catch { console.log('err'); }
    }

    // Phase 3: test
    console.log('\n   🧪 Phase 3: testing forms...');

    const regionPriority = { body: 0, header: 1, footer: 2 };
    const sortedMainForms = [...mainForms].sort((a, b) => {
      const da = regionPriority[a.region] ?? 9;
      const db = regionPriority[b.region] ?? 9;
      return da - db;
    });

    for (const formMeta of sortedMainForms.slice(0, MAX_FORMS)) {
      console.log('\n   📄 "' + formMeta.label + '" [' + formMeta.category + '] inputs:' + formMeta.inputCount + ' email:' + formMeta.hasEmail + ' required:' + formMeta.requiredCount + ' novalidate:' + formMeta.intrinsic.noValidate);
      const testPage = await context.newPage();
      try {
        await testPage.setViewportSize({ width: 1440, height: 900 });
        await testPage.goto(url, { waitUntil: 'load', timeout });
        try { await testPage.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

        const liveForms = await findForms(testPage, null);
        const liveForm = liveForms.find((f) => (f.dedupeKey || f.fingerprint) === (formMeta.dedupeKey || formMeta.fingerprint))
          || liveForms.find((f) => f.fingerprint === formMeta.fingerprint)
          || liveForms[formMeta.index]
          || liveForms[0];

        if (!liveForm) {
          allFormResults.push({
            index: formMeta.index,
            label: formMeta.label,
            category: formMeta.category,
            source: 'main-page',
            isMultiStep: formMeta.isMultiStep,
            hasEmail: formMeta.hasEmail,
            emptySubmit: { tested: false, validationShown: false, method: null, detail: null, intrinsicExpected: formMeta.intrinsic.browserWillBlockEmpty },
            invalidEmail: { tested: false, caught: false, inconclusive: false, detail: null, intrinsicExpected: formMeta.intrinsic.browserWillCatchEmail },
            requiredFields: { total: formMeta.inputCount, requiredCount: formMeta.requiredCount, markedOk: false },
            errorMessages: { visible: false, clear: false, detail: null },
            successMessages: { visible: false, clear: false, detail: null },
            score: 0,
            issues: [{ type: 'critical', code: 'FORM_NOT_RELOCATED', message: '"' + formMeta.label + '" — form could not be relocated on fresh page state' }],
          });
          console.warn('      Form not found on fresh page state');
          continue;
        }

        const result = await testForm(testPage, liveForm, 'main-page');
        allFormResults.push(result);
        logFormResult(result);
      } catch (err) {
        const msg = String(err.message || err);
        const interrupted = /Target page, context or browser has been closed/i.test(msg);
        allFormResults.push({
          index: formMeta.index,
          label: formMeta.label,
          category: formMeta.category,
          source: 'main-page',
          isMultiStep: formMeta.isMultiStep,
          hasEmail: formMeta.hasEmail,
          emptySubmit: { tested: false, validationShown: false, method: null, detail: null, intrinsicExpected: formMeta.intrinsic.browserWillBlockEmpty },
          invalidEmail: { tested: false, caught: false, inconclusive: interrupted, detail: interrupted ? 'Inconclusive: form test interrupted before invalid-email verdict' : null, intrinsicExpected: formMeta.intrinsic.browserWillCatchEmail },
          requiredFields: { total: formMeta.inputCount, requiredCount: formMeta.requiredCount, markedOk: false },
          errorMessages: { visible: false, clear: false, detail: null },
          successMessages: { visible: false, clear: false, detail: null },
          score: interrupted ? 60 : 0,
          issues: [{
            type: interrupted ? 'warning' : 'critical',
            code: interrupted ? 'FORM_TEST_INTERRUPTED' : 'FORM_TEST_CRASHED',
            message: '"' + formMeta.label + '": ' + msg.slice(0, 120),
          }],
        });
        console.warn('      ⚠️  Main-page form test failed: ' + msg.slice(0, 80));
      } finally {
        await testPage.close().catch(() => {});
      }
    }

    let extraCount = allFormResults.length;
    const runtimeIssues = [];
    for (const src of extraSources) {
      if (extraCount >= MAX_FORMS) break;
      const sortedSourceForms = [...src.forms].sort((a, b) => {
        const da = regionPriority[a.region] ?? 9;
        const db = regionPriority[b.region] ?? 9;
        return da - db;
      });
      for (const formMeta of sortedSourceForms) {
        if (extraCount >= MAX_FORMS) break;
        extraCount++;
        console.log('\n   📄 "' + formMeta.label + '" [' + formMeta.category + '] source:' + src.source);
        let testPage = null;
        try {
          testPage = await context.newPage();
        } catch (err) {
          runtimeIssues.push({
            type: 'warning',
            code: 'FORMS_CONTEXT_INTERRUPTED',
            message: 'Form crawl context interrupted while opening a new page: ' + String(err.message || err).slice(0, 120),
          });
          console.warn('      ⚠️  Could not open new page: ' + String(err.message || err).slice(0, 80));
          break;
        }
        try {
          await testPage.setViewportSize({ width: 1440, height: 900 });
          await testPage.goto(src.pageUrl, { waitUntil: 'load', timeout });
          try { await testPage.waitForFunction(() => document.body && document.body.innerText.trim().length > 100, { timeout: 4000 }); } catch {}
          if (src.openedBy && src.popupSelector) {
            try {
              await testPage.click(src.openedBy.selector, { timeout: 5000 });
              await sleep(POPUP_WAIT);
              const popup = await detectOpenPopup(testPage);
              if (!popup.found) throw new Error('Popup did not reopen');
            } catch (e) {
              console.warn('      Could not reopen popup: ' + e.message.slice(0, 60));
              await testPage.close(); continue;
            }
          }
          await sleep(600);
          const liveForms = await findForms(testPage, null);
          const liveForm  = liveForms.find((f) => f.fingerprint === formMeta.fingerprint)
                          || liveForms[formMeta.index] || liveForms[0];
          if (!liveForm) { console.warn('      Form not found on reopened page'); await testPage.close(); continue; }
          const result = await testForm(testPage, liveForm, src.source);
          allFormResults.push(result);
          logFormResult(result);
        } finally { await testPage.close().catch(() => {}); }
      }
    }

    // Aggregate
    const totalFound = mainForms.length + extraSources.reduce((n, s) => n + s.forms.length, 0);

    if (allFormResults.length === 0) {
      return { url, httpStatus, overallStatus: 'healthy', score: 100, formsFound: 0, formResults: [],
        issues: [{ type: 'info', code: 'NO_FORMS', message: 'No testable forms found' }] };
    }

    const avgScore  = Math.round(allFormResults.reduce((s, f) => s + f.score, 0) / allFormResults.length);
    const allIssues = allFormResults.flatMap((f) => f.issues).concat(runtimeIssues);
    const criticals = allIssues.filter((i) => i.type === 'critical');
    const warnings  = allIssues.filter((i) => i.type === 'warning');

    return {
      url, httpStatus,
      overallStatus: criticals.length > 0 ? 'critical' : warnings.length > 0 ? 'warning' : 'healthy',
      score: avgScore, formsFound: totalFound, formsTested: allFormResults.length,
      formResults: allFormResults, issues: allIssues,
    };

  } catch (err) {
    return { url, httpStatus: null, overallStatus: 'critical', score: 0, formsFound: 0, formResults: [],
      issues: [{ type: 'critical', code: 'AUDIT_FATAL', message: 'Forms crashed: ' + err.message }],
      fatalError: err.message };
  } finally {
    await mainPage.close().catch(() => {});
  }
}

module.exports = { auditForms };