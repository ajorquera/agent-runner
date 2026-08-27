#!/usr/bin/env bash
# Black-box test for .github/workflows/agent-run.yml (per issue #12 Testing Decisions).
#
# Seam: the trigger boundary only. Fires the same repository_dispatch call a real
# caller would make, then verifies success/failure via `gh run view --json conclusion`
# and asserts the GitHub-visible side effect the dispatched payload asked for
# (a PR containing a unique marker). Never asserts on internal workflow step
# structure, step names, or step count.
#
# Requires: `gh` authenticated with a token that can dispatch workflow_dispatch/
# repository_dispatch events, read Actions runs, and read PRs on this repo
# (a maintainer token — not the caller-facing trigger token, which only has
# Contents:write and can't read run status or PRs).
#
# Usage:
#   scripts/test-agent-run.sh success   # expect the run to conclude "success" and open a marked PR
#   scripts/test-agent-run.sh failure   # expect the run to conclude "failure"

set -euo pipefail

REPO="ajorquera/agent-runner"
WORKFLOW="agent-run.yml"
POLL_INTERVAL=15
MAX_WAIT_SECONDS=1500   # 25min: workflow's own 20min timeout-minutes default + buffer

scenario="${1:-success}"
nonce="agent-run-test-$(date +%s)-$$"

log() { echo "[test-agent-run] $*" >&2; }

case "$scenario" in
  success)
    prompt="This is an automated test run. Open a pull request against the default branch of this repo. The PR title must contain exactly this token: ${nonce}. Make a trivial one-line change to scripts/.agent-run-test-scratch (create it if missing) as the PR's content — nothing else."
    ;;
  failure)
    prompt="This is an automated test run. Immediately exit with a non-zero status without making any changes, commits, or PRs. Do not attempt the task in any other way. Token: ${nonce}."
    ;;
  *)
    echo "usage: $0 [success|failure]" >&2
    exit 2
    ;;
esac

log "dispatching event agent-run (scenario=${scenario}, nonce=${nonce})"
dispatch_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh api "repos/${REPO}/dispatches" \
  -f event_type=agent-run \
  -f "client_payload[prompt]=${prompt}" \
  -f "client_payload[nonce]=${nonce}"

log "locating the run this dispatch started"
run_id=""
deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$deadline" ]; do
  run_id="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --event repository_dispatch \
    --json databaseId,createdAt --jq \
    "[.[] | select(.createdAt >= \"${dispatch_time}\")] | sort_by(.createdAt) | .[0].databaseId // empty")"
  [ -n "$run_id" ] && break
  sleep 5
done

if [ -z "$run_id" ]; then
  log "FAIL: no run appeared for this dispatch within 120s"
  exit 1
fi
log "tracking run ${run_id}"

log "polling for a terminal conclusion (timeout ${MAX_WAIT_SECONDS}s)"
conclusion=""
deadline=$((SECONDS + MAX_WAIT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  status_json="$(gh run view "$run_id" --repo "$REPO" --json status,conclusion)"
  status="$(echo "$status_json" | jq -r .status)"
  if [ "$status" = "completed" ]; then
    conclusion="$(echo "$status_json" | jq -r .conclusion)"
    break
  fi
  sleep "$POLL_INTERVAL"
done

if [ -z "$conclusion" ]; then
  log "FAIL: run ${run_id} did not reach a terminal status within ${MAX_WAIT_SECONDS}s"
  exit 1
fi
log "run ${run_id} concluded: ${conclusion}"

if [ "$conclusion" != "$scenario" ]; then
  log "FAIL: expected conclusion '${scenario}', got '${conclusion}' (run https://github.com/${REPO}/actions/runs/${run_id})"
  exit 1
fi

if [ "$scenario" = "success" ]; then
  log "asserting the GitHub-visible side effect: a PR titled with ${nonce}"
  pr_number="$(gh pr list --repo "$REPO" --state all --search "${nonce} in:title" --json number --jq '.[0].number // empty')"
  if [ -z "$pr_number" ]; then
    log "FAIL: no PR found with title containing ${nonce}"
    exit 1
  fi
  log "found PR #${pr_number} — closing it (test artifact, not a real change)"
  gh pr close "$pr_number" --repo "$REPO" --delete-branch >/dev/null 2>&1 || true
fi

log "PASS (scenario=${scenario}, run=${run_id})"
