#!/usr/bin/env node
'use strict';

/**
 * Command-line entry point.
 *
 *   usage-panel              start the dashboard
 *   usage-panel detect       print detected harnesses and exit
 *   usage-panel --version
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');
const [, , command, ...rest] = process.argv;

function option(name) {
  const index = rest.indexOf('--' + name);
  const value = index >= 0 ? rest[index + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

async function readCode() {
  if (!rest.includes('--code-stdin') || process.stdin.isTTY) {
    throw new Error('use --code-stdin and pipe the short-lived enrollment code on stdin');
  }
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  const code = value.replace(/[\r\n]+$/, '').trim();
  if (!code) throw new Error('enrollment code must not be empty');
  return code;
}

async function enroll() {
  const client = require(path.join(ROOT, 'src', 'sync', 'client'));
  const runtimeConfig = require(path.join(ROOT, 'src', 'core', 'runtime-config'));
  const endpoint = option('endpoint');
  if (!endpoint) throw new Error('--endpoint is required');
  const enrolled = await client.enroll({
    endpoint,
    code: await readCode(),
    label: option('label') || undefined,
    allowInsecure: rest.includes('--allow-insecure')
  });
  runtimeConfig.saveEnrollment({
    endpoint,
    deviceCredential: enrolled.deviceCredential,
    deviceId: enrolled.deviceId,
    allowInsecure: rest.includes('--allow-insecure')
  });
  console.log('This device is enrolled and its credential was saved in protected per-user storage without printing it.');
}

/** Print detected harnesses in a readable table and exit. */
function printDetection() {
  const { scan } = require(path.join(ROOT, 'src', 'detect'));
  const result = scan({ proxy: { host: '127.0.0.1', port: 8898, enabled: false } });

  console.log('\nDetected harnesses on ' + result.hostname + ' (' + result.platform + ')\n');
  if (!result.detected.length) {
    console.log('  none found');
  }
  for (const h of result.detected) {
    const capture = h.capabilities.quota === 'official' ? 'official api + logs'
      : h.capabilities.tokens === 'proxy' ? 'capture proxy'
        : h.capabilities.tokens === 'server-api' ? 'server api required'
          : 'not capturable';
    console.log('  ' + h.label.padEnd(16)
      + (h.binPath ? 'installed' : 'no binary').padEnd(12)
      + (h.homePath ? h.homeSource : 'no data dir').padEnd(24)
      + capture);
  }
  if (result.missing.length) {
    console.log('\n  not installed: ' + result.missing.map((m) => m.label).join(', '));
  }
  console.log('');
}

switch (command) {
  case 'detect':
    printDetection();
    break;

  case 'enroll':
    enroll().catch((err) => { console.error(err.message || 'enrollment failed'); process.exit(1); });
    break;

  case '--version':
  case '-v':
    console.log(require(path.join(ROOT, 'package.json')).version);
    break;

  case '--help':
  case '-h':
    console.log([
      '',
      'usage-panel — local AI subscription usage dashboard',
      '',
      '  usage-panel             start the dashboard (http://localhost:8899)',
      '  usage-panel detect      list harnesses detected on this machine',
      '  usage-panel enroll --endpoint URL --code-stdin [--label NAME]',
      '                          endpoints with a path use /v1; bare origins use /api/v1',
      '  usage-panel --version',
      ''
    ].join('\n'));
    break;

  default:
    if (command && command.startsWith('-')) {
      console.error('unknown option: ' + command + ' (try --help)');
      process.exit(1);
    }
    if (command) {
      console.error('unknown command: ' + command + ' (try --help)');
      process.exit(1);
    }
    require(path.join(ROOT, 'refresher.js'));
}
