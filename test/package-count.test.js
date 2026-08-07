'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function run(overrides = {}) {
  return spawnSync('sh', ['test/package.test.sh'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: Object.assign({}, process.env, {
      PACKAGE_TEST_SKIP_COUNT_REGRESSION: '1'
    }, overrides)
  });
}

function tally(result) {
  const matches = [...String(result.stdout || '').matchAll(/^(\d+) passed, 0 failed$/gm)];
  assert.strictEqual(matches.length, 1, 'expected exactly one computed success summary');
  return Number(matches[0][1]);
}

const baseline = run();
assert.strictEqual(baseline.status, 0, baseline.stderr || baseline.stdout);
const baselineTally = tally(baseline);

const extra = run({ PACKAGE_TEST_EXTRA_PASS: '1' });
assert.strictEqual(extra.status, 0, extra.stderr || extra.stdout);
assert.strictEqual(tally(extra), baselineTally + 1, 'executed check did not change the reported tally');
assert.match(extra.stdout, /^  ok   injected count-regression check executes$/m);
console.log('  ok   computed package tally changes with executed checks');

const failed = run({ PACKAGE_TEST_FORCE_FAILURE: '1' });
assert.strictEqual(failed.status, 97, failed.stderr || failed.stdout);
assert.doesNotMatch(failed.stdout, /^\d+ passed, 0 failed$/m);
assert.match(failed.stderr, /simulated package failure before success summary/);
console.log('  ok   package failure cannot print a success summary');
