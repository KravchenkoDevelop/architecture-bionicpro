'use strict';
/**
 * jest-text-reporter.js
 * Custom Jest reporter that writes a human-readable summary to
 * frontend/test_results.txt after each test run.
 *
 * Configured in package.json under "jest" → "reporters".
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'test_results.txt');

class TextReporter {
  constructor(globalConfig, options) {
    this._globalConfig = globalConfig;
  }

  onRunComplete(contexts, results) {
    const now = new Date().toLocaleString('ru-RU', { hour12: false });
    const lines = [
      '='.repeat(72),
      'BionicPRO Frontend — Automated Test Results',
      `Run at : ${now}`,
      `Suite  : frontend/src/components/__tests__/`,
      '='.repeat(72),
      '',
      'Tested requirements:',
      '  [1] UI shows "Get My Report" button when authenticated',
      '  [2] Unauthenticated users see login screen (no report button)',
      '  [3] Report button calls GET /reports with Bearer token',
      '  [4] 401/403 response shows auth error message (not crash)',
      '  [5] 404 response shows "not ready yet" message',
      '  [6] Report data is displayed correctly in the UI',
      '',
      'Results:',
      '-'.repeat(72),
    ];

    let totalPassed = 0;
    let totalFailed = 0;

    results.testResults.forEach((suite) => {
      const suiteName = path.relative(process.cwd(), suite.testFilePath);
      lines.push(`  Suite: ${suiteName}`);

      suite.testResults.forEach((test) => {
        const passed  = test.status === 'passed';
        const mark    = passed ? '✓ PASS' : '✗ FAIL';
        const duration = `${test.duration ?? 0}ms`;
        lines.push(`    ${mark}  [${duration}]  ${test.fullName}`);

        if (!passed && test.failureMessages && test.failureMessages.length > 0) {
          test.failureMessages.forEach((msg) => {
            msg.split('\n').slice(0, 6).forEach((l) => {
              lines.push(`             ${l}`);
            });
          });
        }

        if (passed) totalPassed++;
        else totalFailed++;
      });
    });

    const total   = totalPassed + totalFailed;
    const verdict = totalFailed === 0
      ? 'ALL TESTS PASSED ✓'
      : `${totalFailed} TEST(S) FAILED ✗`;

    lines.push(
      '',
      '='.repeat(72),
      `  Total: ${total}  |  Passed: ${totalPassed}  |  Failed: ${totalFailed}`,
      `  Verdict: ${verdict}`,
      '='.repeat(72),
      '',
    );

    fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
    console.log(`\n  📄  Results saved → ${OUTPUT_FILE}`);
  }
}

module.exports = TextReporter;
