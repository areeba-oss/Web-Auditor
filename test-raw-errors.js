require('dotenv').config();
const { chromium } = require('playwright-core');
const { auditPageHealth } = require('./src/audits/basicHealthCheck');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  const testUrls = [
    'https://example.com',
    'https://www.google.com',
    'https://github.com',
  ];

  for (const url of testUrls) {
    console.log(`\n\n════════════════════════════════════════`);
    console.log(`Testing: ${url}`);
    console.log(`════════════════════════════════════════\n`);

    try {
      const result = await auditPageHealth(context, url, 10000);

      console.log('✅ HTTP Status:', result.httpStatus);
      console.log('📋 Page Title:', result.pageTitle);
      console.log('\n🔴 CONSOLE ERRORS (RAW):');
      if (result.consoleErrors?.length > 0) {
        result.consoleErrors.forEach((e, i) => {
          console.log(`  ${i + 1}. ${e}`);
        });
      } else {
        console.log('  (none)');
      }

      console.log('\n⚠️  CONSOLE WARNINGS (RAW):');
      if (result.consoleWarnings?.length > 0) {
        result.consoleWarnings.forEach((w, i) => {
          console.log(`  ${i + 1}. ${w}`);
        });
      } else {
        console.log('  (none)');
      }

      console.log('\n❌ NETWORK FAILURES (LEGITIMATE - scored):');
      if (result.failedRequests?.length > 0) {
        result.failedRequests.slice(0, 5).forEach((f, i) => {
          console.log(`  ${i + 1}. ${f.url}`);
          console.log(`     Error: ${f.errorText}`);
        });
        if (result.failedRequests.length > 5) {
          console.log(`  ... and ${result.failedRequests.length - 5} more`);
        }
      } else {
        console.log('  (none)');
      }

      if (result.botBlockedRequests?.length > 0) {
        console.log('\n⛔ BOT-BLOCKED REQUESTS (FILTERED OUT):');
        result.botBlockedRequests.slice(0, 3).forEach((f, i) => {
          console.log(`  ${i + 1}. ${f.url?.substring(0, 100)}`);
          console.log(`     Error: ${f.errorText}`);
        });
        if (result.botBlockedRequests.length > 3) {
          console.log(`  ... and ${result.botBlockedRequests.length - 3} more`);
        }
      }

      console.log('\n📊 Summary:');
      console.log(`  Errors: ${result.consoleErrors?.length ?? 0}`);
      console.log(`  Warnings: ${result.consoleWarnings?.length ?? 0}`);
      console.log(`  Network Failures: ${result.failedRequests?.length ?? 0}`);
      console.log(`  Score: ${result.score}/100`);
      console.log(`  Status: ${result.overallStatus}`);

    } catch (err) {
      console.error('❌ Error:', err.message);
    }
  }

  await browser.close();
  console.log('\n✅ Test complete\n');
})();
