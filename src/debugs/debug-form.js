'use strict';
require('dotenv').config();
const { chromium } = require('playwright-core');

const url = process.argv[2] || 'https://stripe.com/contact/sales';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 5000 }); } catch {}

  const info = await page.evaluate(() => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }

    const form = document.querySelector('form');
    if (!form) return { error: 'No form found' };

    const allInputs    = Array.from(form.querySelectorAll('input, textarea, select'));
    const visInputs    = allInputs.filter(isVisible);
    const allBtns      = Array.from(form.querySelectorAll('button, input[type="submit"]'));
    const visBtns      = allBtns.filter(isVisible);

    return {
      totalInputs:   allInputs.length,
      visibleInputs: visInputs.length,
      visInputDetails: visInputs.map(i => ({
        type: i.type, name: i.name, id: i.id,
        placeholder: i.placeholder?.slice(0,30),
        required: i.required,
        tagName: i.tagName,
      })),
      totalBtns:   allBtns.length,
      visibleBtns: visBtns.length,
      visBtnDetails: visBtns.map(b => ({
        text: b.innerText?.trim().slice(0,40) || b.value,
        type: b.type, id: b.id,
        classes: b.className?.slice(0,60),
        disabled: b.disabled,
      })),
      // Step indicators
      stepEls: Array.from(form.querySelectorAll('[class*="step"], [data-step], [class*="wizard"]'))
        .slice(0,5).map(el => ({ tag: el.tagName, class: el.className?.slice(0,50), text: el.innerText?.trim().slice(0,30) })),
    };
  });

  console.log('\n🔍 Form Debug:', url, '\n');
  console.log(`Inputs  — total:${info.totalInputs}  visible:${info.visibleInputs}`);
  console.log(`Buttons — total:${info.totalBtns}  visible:${info.visibleBtns}`);
  console.log('\nVisible inputs:');
  (info.visInputDetails||[]).forEach((i,n) => console.log(`  ${n+1}. [${i.type}] name="${i.name}" id="${i.id}" placeholder="${i.placeholder}" required:${i.required}`));
  console.log('\nVisible buttons:');
  (info.visBtnDetails||[]).forEach((b,n) => console.log(`  ${n+1}. text="${b.text}" type=${b.type} disabled:${b.disabled} class="${b.classes}"`));
  console.log('\nStep elements:');
  (info.stepEls||[]).forEach((s,n) => console.log(`  ${n+1}. <${s.tag}> class="${s.class}" text="${s.text}"`));

  await browser.close();
})();