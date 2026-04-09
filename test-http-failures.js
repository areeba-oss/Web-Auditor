require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditPageHealth } = require('./src/audits/basicHealthCheck');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Test URLs that likely have 4xx/5xx subrequests
  const testUrls = [
    'https://httpstat.us/200',      // Known to have controlled errors
    'https://www.getspeedbump.com', // Real site with potential errors
  ];

  for (const url of testUrls) {
    console.log(`\n\n════════════════════════════════════════`);
    console.log(`🔍 Testing: ${url}`);
    console.log(`════════════════════════════════════════\n`);

    try {
      const result = await auditPageHealth(context, url, 15000);

      console.log(`✅ HTTP: ${result.httpStatus}`);
      console.log(`📋 Title: ${result.pageTitle}`);
      console.log(`\n📊 Network Failures (LEGITIMATE - scored):`);
      
      if (result.failedRequests?.length > 0) {
        result.failedRequests.forEach((f, i) => {
          console.log(`  ${i + 1}. [${f.resourceType || 'unknown'}] ${f.url?.substring(0, 80)}`);
          console.log(`     └─ ${f.errorText} ${f.status ? `(HTTP ${f.status})` : ''}`);
          console.log(`     └─ Source: ${f.source || 'transport'}`);
        });
      } else {
        console.log('  (none)');
      }

      if (result.botBlockedRequests?.length > 0) {
        console.log(`\n⛔ Bot-Blocked Requests (FILTERED OUT from scoring):`);
        result.botBlockedRequests.forEach((f, i) => {
          console.log(`  ${i + 1}. [${f.resourceType || 'unknown'}] ${f.url?.substring(0, 80)}`);
          console.log(`     └─ ${f.errorText} ${f.status ? `(HTTP ${f.status})` : ''}`);
        });
      }

      console.log(`\n📊 Errors: ${result.consoleErrors?.length ?? 0}`);
      console.log(`⚠️  Warnings: ${result.consoleWarnings?.length ?? 0}`);
      console.log(`Score: ${result.score}/100 | Status: ${result.overallStatus}`);

    } catch (err) {
      console.error('❌ Error:', err.message);
    }
  }

  await browser.close();
  console.log('\n✅ Test complete\n');
})();
