#!/bin/sh
set -eu

test_root="$(pwd)"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/usage-panel-package.XXXXXX")"
export PACKAGE_TEST_ROOT="$test_root"
export PACKAGE_TEST_STATE="$state_root/main-state"
package_passes=0
counted_sequence=0

run_counted() {
  counted_sequence=$((counted_sequence + 1))
  counted_log="$state_root/counted-$counted_sequence.log"
  if "$@" > "$counted_log" 2>&1; then
    :
  else
    counted_status=$?
    cat "$counted_log"
    return "$counted_status"
  fi
  cat "$counted_log"
  counted_passes="$(awk '/^  ok   / { count += 1 } END { print count + 0 }' "$counted_log")"
  package_passes=$((package_passes + counted_passes))
}

package_pass() {
  package_passes=$((package_passes + 1))
  echo "  ok   $1"
}

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

run_counted node test/package.test.js selftest
if [ "${PACKAGE_TEST_SKIP_COUNT_REGRESSION:-0}" != "1" ]; then
  run_counted node test/package-count.test.js
fi
run_counted node test/client-release.test.js

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
while [ ! -f "$interrupt_marker" ] && [ "$attempt" -lt 10 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
if [ ! -f "$interrupt_marker" ]; then
  kill -TERM "$interrupt_pid" 2>/dev/null || true
  wait "$interrupt_pid" 2>/dev/null || true
  echo "interruption setup did not reach its bounded pause" >&2
  exit 1
fi
package_pass "interruption setup reaches its bounded pause"
run_counted env PACKAGE_TEST_ROOT="$interrupt_root" PACKAGE_TEST_STATE="$interrupt_state" \
PACKAGE_TEST_VERIFY_LABEL=interruption \
  node test/package.test.js verify-dirty
kill -TERM "$interrupt_pid"
interrupt_status=0
wait "$interrupt_pid" || interrupt_status=$?
if [ "$interrupt_status" -ne 143 ]; then
  echo "interrupted setup exited $interrupt_status instead of 143" >&2
  exit 1
fi
package_pass "interrupted setup preserves the expected signal exit"
run_counted env PACKAGE_TEST_ROOT="$interrupt_root" PACKAGE_TEST_STATE="$interrupt_state" \
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
  PACKAGE_TEST_VERIFY_LABEL=assertion_failure \
    node test/package.test.js verify-dirty > "$state_root/assertion-dirty.log"
  node -e "require('assert').fail('simulated package assertion failure')" \
    2> "$state_root/assertion-error.log"
) || assertion_status=$?
if [ "$assertion_status" -ne 1 ]; then
  echo "simulated assertion exited $assertion_status instead of 1" >&2
  exit 1
fi
package_pass "simulated assertion failure preserves its failing exit"
run_counted cat "$state_root/assertion-dirty.log"
run_counted env PACKAGE_TEST_ROOT="$assertion_root" PACKAGE_TEST_STATE="$assertion_state" \
PACKAGE_TEST_VERIFY_LABEL=assertion_failure PACKAGE_TEST_VERIFY_STATUS=1 \
  node test/package.test.js verify-clean

node test/package.test.js setup
package_pass "final package fixture setup completes"
mkdir -p "$state_root/archive" "$state_root/extracted"
npm_config_cache="$state_root/npm-cache" npm pack --json --ignore-scripts \
  --pack-destination "$state_root/archive" > "$state_root/inventory.json"
package_pass "actual customer archive builds"
archive_name="$(node test/package.test.js archive-name "$state_root/inventory.json")"
tar -xzf "$state_root/archive/$archive_name" -C "$state_root/extracted"
package_pass "actual customer archive extracts"
run_counted node test/package.test.js inspect "$state_root/inventory.json" "$state_root/extracted/package"

if [ "${PACKAGE_TEST_EXTRA_PASS:-0}" = "1" ]; then
  package_pass "injected count-regression check executes"
fi
if [ "${PACKAGE_TEST_FORCE_FAILURE:-0}" = "1" ]; then
  echo "simulated package failure before success summary" >&2
  exit 97
fi

echo
echo "$package_passes passed, 0 failed"
