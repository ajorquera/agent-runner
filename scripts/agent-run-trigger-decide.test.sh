#!/usr/bin/env bash
# Unit tests for agent-run-trigger-decide.sh. No framework dependency — plain
# bash assertions, run directly by CI (see .github/workflows/test.yml).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
decide="$script_dir/agent-run-trigger-decide.sh"

failures=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $desc (expected '$expected', got '$actual')"
    failures=$((failures + 1))
  else
    echo "ok: $desc"
  fi
}

for phase in explore design implement review; do
  actual="$("$decide" "agent:$phase" "")"
  assert_eq "agent:$phase with no other labels dispatches" "dispatch" "$actual"
done

actual="$("$decide" "some-other-label" "")"
assert_eq "non-phase label is skipped" "skip" "$actual"

actual="$("$decide" "bug" "agent:explore,priority:high")"
assert_eq "non-phase label is skipped even with other labels present" "skip" "$actual"

actual="$("$decide" "agent:explore" "agent:in-progress")"
assert_eq "phase label with agent:in-progress present is busy" "busy" "$actual"

actual="$("$decide" "agent:implement" "bug,agent:in-progress,priority:high")"
assert_eq "agent:in-progress detected among other unrelated labels" "busy" "$actual"

actual="$("$decide" "agent:review" "bug,priority:high")"
assert_eq "phase label with unrelated labels (no in-progress) dispatches" "dispatch" "$actual"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi

echo "all tests passed"
