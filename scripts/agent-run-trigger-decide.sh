#!/usr/bin/env bash
# Pure decision logic for the reusable agent-run-trigger.yml workflow,
# factored out for unit testing.
#
# Usage: agent-run-trigger-decide.sh <label_name> <issue_labels_csv>
#   label_name        the label that was just added (github.event.label.name)
#   issue_labels_csv   comma-separated list of the issue's current labels
#
# Prints one of: skip | busy | dispatch
set -euo pipefail

label_name="${1:?label_name required}"
issue_labels_csv="${2:-}"

phase_labels=("agent:explore" "agent:design" "agent:implement" "agent:review")

is_phase_label=false
for phase in "${phase_labels[@]}"; do
  if [[ "$label_name" == "$phase" ]]; then
    is_phase_label=true
    break
  fi
done

if [[ "$is_phase_label" != true ]]; then
  echo "skip"
  exit 0
fi

IFS=',' read -ra labels <<< "$issue_labels_csv"
for existing in "${labels[@]:-}"; do
  if [[ "$existing" == "agent:in-progress" ]]; then
    echo "busy"
    exit 0
  fi
done

echo "dispatch"
