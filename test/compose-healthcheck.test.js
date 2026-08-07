'use strict';

/**
 * Static + Compose-render regression for Caddy HTTPS health checks.
 * The check must use PUBLIC_DOMAIN for both name resolution and TLS SNI so
 * internal staging domains (and later real domains) work; Host-only probes
 * against https://127.0.0.1 fail with TLS internal error.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const composePath = path.join(repoRoot, 'ops', 'compose.yaml');
const dockerfileSource = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const entrypointSource = fs.readFileSync(path.join(repoRoot, 'server', 'container-entrypoint.sh'), 'utf8');

let passed = 0;
const failures = [];

/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + (err && err.message));
  }
}

console.log('compose caddy healthcheck tests\n');

const composeSource = fs.readFileSync(composePath, 'utf8');
const caddyBlockMatch = composeSource.match(/(?:^|\n) {2}caddy:\n([\s\S]*?)(?=\n {2}[a-z]|\n[a-z]|\nvolumes:|\nnetworks:|\nsecrets:)/);
assert.ok(caddyBlockMatch, 'caddy service block missing from ops/compose.yaml');
const caddyBlock = caddyBlockMatch[1];

test('caddy healthcheck uses PUBLIC_DOMAIN in the HTTPS URL (TLS SNI)', () => {
  assert.match(
    caddyBlock,
    /https:\/\/\$\$PUBLIC_DOMAIN\/health/,
    'healthcheck URL must target PUBLIC_DOMAIN so TLS SNI matches the certificate name'
  );
  assert.doesNotMatch(
    caddyBlock,
    /https:\/\/127\.0\.0\.1\//,
    'healthcheck must not open HTTPS to the IP literal (SNI becomes 127.0.0.1)'
  );
});

test('caddy healthcheck pins DNS for PUBLIC_DOMAIN to loopback inside the container', () => {
  assert.match(
    caddyBlock,
    /--resolve\s+"\$\$PUBLIC_DOMAIN:443:127\.0\.0\.1"/,
    'healthcheck must resolve PUBLIC_DOMAIN:443 to 127.0.0.1 without relying on external DNS'
  );
});

test('published HTTP/HTTPS binds stay loopback-only by default', () => {
  assert.match(composeSource, /HTTP_BIND:-\$\{?127\.0\.0\.1:8080\}?|HTTP_BIND:-127\.0\.0\.1:8080/);
  assert.match(composeSource, /HTTPS_BIND:-\$\{?127\.0\.0\.1:8443\}?|HTTPS_BIND:-127\.0\.0\.1:8443/);
  // Explicit default form used in this repo:
  assert.match(composeSource, /"\$\{HTTP_BIND:-127\.0\.0\.1:8080\}:80"/);
  assert.match(composeSource, /"\$\{HTTPS_BIND:-127\.0\.0\.1:8443\}:443"/);
});

test('healthcheck does not rely on Host header alone against an IP URL', () => {
  assert.doesNotMatch(
    caddyBlock,
    /header=.*Host:.*https:\/\/127\.0\.0\.1/,
    'Host header cannot fix TLS SNI when the URL host is 127.0.0.1'
  );
});

test('collector image keeps its server-only PostgreSQL dependency manifest', () => {
  assert.match(dockerfileSource, /COPY server\/package\.json server\/package-lock\.json \.\//);
  assert.match(dockerfileSource, /npm ci --omit=dev --ignore-scripts/);
  const serverManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'package.json'), 'utf8'));
  const serverLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'package-lock.json'), 'utf8'));
  assert.strictEqual(serverManifest.dependencies.pg, '8.16.3');
  assert.strictEqual(serverLock.packages['node_modules/pg'].version, '8.16.3');
});

test('collector root setup is minimal and always drops to the node user before the server starts', () => {
  assert.doesNotMatch(dockerfileSource, /^USER node$/m,
    'the entrypoint needs root only to copy the root-readable mounted secret');
  assert.match(entrypointSource, /mktemp -d \/tmp\/usage-panel-runtime\.XXXXXX/);
  assert.match(entrypointSource, /exec runuser -u node -- node/);
  assert.ok(entrypointSource.indexOf('exec runuser -u node -- node') > entrypointSource.indexOf('chown -R node:node'));
});

test('backup recipient conflicts fail instead of silently overriding the environment', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-secret-conflict-'));
  try {
    const file = path.join(scratch, 'secrets.env');
    fs.writeFileSync(file, 'BACKUP_RECIPIENT=age1-file-value\n');
    const result = spawnSync('sh', ['-c', '. "$1"; load_usage_panel_secrets', 'sh',
      path.join(repoRoot, 'ops', 'lib', 'secrets.sh')], {
      encoding: 'utf8', env: { ...process.env, USAGE_PANEL_SECRETS_FILE: file, BACKUP_RECIPIENT: 'age1-env-value' }
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /BACKUP_RECIPIENT conflicts/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
if (docker.status === 0) {
  test('docker compose config preserves domain SNI healthcheck for an internal domain', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-panel-compose-'));
    try {
      const secrets = path.join(scratch, 'secrets.env');
      const password = path.join(scratch, 'postgres-password');
      const backups = path.join(scratch, 'backups');
      const identity = path.join(scratch, 'age-identity.txt');
      fs.writeFileSync(secrets, 'DATABASE_URL=postgresql://usage_panel:x@postgres:5432/usage_panel\n');
      fs.writeFileSync(password, 'disposable-compose-password\n');
      fs.mkdirSync(backups);
      fs.writeFileSync(identity, 'disposable-age-identity\n');
      const env = {
        ...process.env,
        PUBLIC_DOMAIN: 'usage-panel.internal',
        CADDY_TLS_MODE: 'internal',
        USAGE_PANEL_SECRETS_FILE: secrets,
        POSTGRES_PASSWORD_FILE: password,
        BACKUP_DIR: backups,
        BACKUP_IDENTITY_FILE: identity,
        HTTP_BIND: '127.0.0.1:18080',
        HTTPS_BIND: '127.0.0.1:18443',
      };
      const rendered = spawnSync(
        'docker',
        ['compose', '-f', composePath, '--profile', 'restore', 'config'],
        { encoding: 'utf8', env, cwd: repoRoot }
      );
      assert.strictEqual(rendered.status, 0, rendered.stderr || rendered.stdout);
      const out = rendered.stdout;
      assert.match(out, /PUBLIC_DOMAIN:\s*usage-panel\.internal/);
      assert.match(
        out,
        /--resolve\s+"\$\$PUBLIC_DOMAIN:443:127\.0\.0\.1"|--resolve "\$\$PUBLIC_DOMAIN:443:127\.0\.0\.1"/
      );
      // Compose may fold the shell string; require domain URL and forbid IP HTTPS URL.
      assert.match(out, /https:\/\/\$\$PUBLIC_DOMAIN\/health/);
      assert.doesNotMatch(out, /https:\/\/127\.0\.0\.1\/health/);
      assert.match(out, /host_ip:\s*127\.0\.0\.1/);
      assert.match(out, /file:\s*[^\n]*age-identity\.txt/);
      assert.match(out, /target:\s*\/run\/secrets\/backup-identity/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
} else {
  console.log('  skip docker compose config render (docker compose unavailable)');
}

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.error(f.name + ':', f.err && f.err.stack ? f.err.stack : f.err);
  process.exit(1);
}
