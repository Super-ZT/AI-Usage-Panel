#!/bin/sh
set -eu

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must point to a disposable PostgreSQL database}"

release_state="$(mktemp -d "${TMPDIR:-/tmp}/usage-panel-release-gate.XXXXXX")"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  case "$release_state" in
    "${TMPDIR:-/tmp}"/usage-panel-release-gate.*) rm -rf "$release_state" ;;
    *) echo "refusing to remove unsafe release-gate path" >&2; status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

npm test
npm run accuracy:codex
timeout 30 npm audit --audit-level=low
timeout 30 npm audit --prefix server --omit=dev --audit-level=low

mkdir -p "$release_state/archive" "$release_state/extracted"
npm_config_cache="$release_state/npm-cache" npm pack --json --ignore-scripts \
  --pack-destination "$release_state/archive" > "$release_state/inventory.json"
archive_name="$(node test/package.test.js archive-name "$release_state/inventory.json")"
tar -xzf "$release_state/archive/$archive_name" -C "$release_state/extracted"
node test/package.test.js inspect "$release_state/inventory.json" "$release_state/extracted/package"

node - "$release_state/inventory.json" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const inventory = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const archive = path.join(path.dirname(process.argv[2]), 'archive', inventory.filename);
console.log('release archive entries: ' + inventory.files.length);
console.log('release archive sha256: ' + crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
console.log('release archive manifest:');
for (const file of inventory.files.map((entry) => entry.path).sort()) console.log('  ' + file);
NODE

echo "release safety gate passed"
