#!/bin/sh
set -eu

test_root="$(pwd)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/usage-panel-package.XXXXXX")"
export PACKAGE_TEST_ROOT="$test_root"
export PACKAGE_TEST_STATE="$state_root/main-state"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  node test/package.test.js cleanup || status=1
  case "$state_root" in
    "${TMPDIR:-/tmp}"/usage-panel-package.*) rm -rf "$state_root" ;;
    *) echo "refusing to remove unsafe package-test state path" >&2; status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

node test/package.test.js selftest
node test/client-release.test.js

interrupt_root="$state_root/interruption-root"
interrupt_state="$state_root/interruption-state"
interrupt_marker="$state_root/interruption-ready"
mkdir -p "$interrupt_root" "$interrupt_state"
PACKAGE_TEST_ROOT="$interrupt_root" \
PACKAGE_TEST_STATE="$interrupt_state" \
PACKAGE_TEST_PAUSE_AFTER=5 \
PACKAGE_TEST_PAUSE_FILE="$interrupt_marker" \
  node test/package.test.js setup &
interrupt_pid=$!
attempt=0
while [ ! -f "$interrupt_marker" ] && [ "$attempt" -lt 100 ]; do
  sleep 0.05
  attempt=$((attempt + 1))
done
if [ ! -f "$interrupt_marker" ]; then
  kill -TERM "$interrupt_pid" 2>/dev/null || true
  wait "$interrupt_pid" 2>/dev/null || true
  echo "interruption setup did not reach its bounded pause" >&2
  exit 1
fi
kill -TERM "$interrupt_pid"
interrupt_status=0
wait "$interrupt_pid" || interrupt_status=$?
if [ "$interrupt_status" -ne 143 ]; then
  echo "interrupted setup exited $interrupt_status instead of 143" >&2
  exit 1
fi
PACKAGE_TEST_ROOT="$interrupt_root" PACKAGE_TEST_STATE="$interrupt_state" \
  node test/package.test.js verify-clean

assertion_root="$state_root/assertion-root"
assertion_state="$state_root/assertion-state"
mkdir -p "$assertion_root" "$assertion_state"
assertion_status=0
(
  set -eu
  export PACKAGE_TEST_ROOT="$assertion_root"
  export PACKAGE_TEST_STATE="$assertion_state"
  assertion_cleanup() {
    assertion_exit=$?
    trap - EXIT HUP INT TERM
    node test/package.test.js cleanup || assertion_exit=1
    exit "$assertion_exit"
  }
  trap assertion_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  node test/package.test.js setup
  node -e "require('assert').fail('simulated package assertion failure')" \
    2> "$state_root/assertion-error.log"
) || assertion_status=$?
if [ "$assertion_status" -ne 1 ]; then
  echo "simulated assertion exited $assertion_status instead of 1" >&2
  exit 1
fi
PACKAGE_TEST_ROOT="$assertion_root" PACKAGE_TEST_STATE="$assertion_state" \
PACKAGE_TEST_VERIFY_LABEL=assertion_failure PACKAGE_TEST_VERIFY_STATUS=1 \
  node test/package.test.js verify-clean

node test/package.test.js setup
mkdir -p "$state_root/archive" "$state_root/extracted"
npm_config_cache="$state_root/npm-cache" npm pack --json --ignore-scripts \
  --pack-destination "$state_root/archive" > "$state_root/inventory.json"
archive_name="$(node test/package.test.js archive-name "$state_root/inventory.json")"
tar -xzf "$state_root/archive/$archive_name" -C "$state_root/extracted"
node test/package.test.js inspect "$state_root/inventory.json" "$state_root/extracted/package"

echo
echo "14 passed, 0 failed"
