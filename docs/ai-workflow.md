# AI Workflow

## Overview

This is a spec for a system that takes an idea from a first conversation to a merge-ready pull request. Every requirement here (budgets, traces, retention) is enforced by code, not by prompts.

- **Runtime:** a hybrid. The Define stage runs interactively in Claude Code, because it needs a human in the conversation. Implement, Review and Publish run headless in GitHub Actions on an orchestrator built with the Claude Agent SDK.
- **Distribution:** this repo (`agent-runner`) is a tool, not a place where work happens. It ships two things under one version tag: a Claude Code plugin with the Define skill, and a reusable workflow (`workflow_call`) for the headless stages. Each **target repo** installs the plugin and adds a short caller workflow (see Distribution).
- **Source of truth:** GitHub, in the target repo, which must be private. Every stage reads its input from GitHub and writes its output back, so any stage can be re-run without repeating the whole pipeline.
- **Output:** a pull request to `main` in the target repo, linked to its issue and trace ID. Agents never merge; a human always does.

## Pipeline

The pipeline has four stages: Define, Implement, Review and Publish. Each one has a single input and a single output, both stored in GitHub.

**Every run ends at a human: a merge or an escalation.**

```mermaid
flowchart LR
    define["<b>Define</b><br/>Claude Code<br/>human confirms"]
    implement["<b>Implement</b><br/>GitHub Actions<br/>plan, code, tests"]
    review["<b>Review</b><br/>GitHub Actions<br/>fresh context"]
    publish["<b>Publish</b><br/>script, no LLM<br/>rebase, open PR"]
    escalate["<b>Escalate: needs-human</b><br/>budget out, review loop at 3,<br/>or rebase conflict"]
    merge(["<b>Human merges</b><br/>PR to main"])

    define -- issue --> implement
    implement -- branch --> review
    review -- approve --> publish
    review -- "changes requested, max 3 rounds" --> implement
    implement -- fails template check --> define
    implement --> escalate
    review --> escalate
    publish --> escalate
    publish -- PR opened --> merge

    classDef human stroke-width:2px
    class merge human
```

*Pipeline flow · 4 stages, 2 loops, 2 human endpoints*

Review can send work back to Implement up to 3 times, and a failed template check sends the issue back to Define. Every other path ends with a human merging the PR or picking up an escalation.

| Stage | Runs in | Input | Output |
| --- | --- | --- | --- |
| Define | Claude Code (interactive skill) | A short prompt, or an existing issue number on rework | An issue that follows the template, with a type label, trace ID, decision summary and session ID, plus a trace comment |
| Implement | GitHub Actions | The issue (plus the existing branch on rework) | Branch `<issue#>-<slug>`, the plan as an issue comment, local tests and lint passing, a trace comment |
| Review | GitHub Actions | The issue and the branch diff | A verdict (`approve` / `changes_requested`), findings as structured comments, a trace comment |
| Publish | GitHub Actions (script, no LLM) | An approved branch | A PR to `main` with a summary, `Closes #<issue>`, the trace ID and the plan |

### Trigger

The pipeline starts when the Define skill creates the issue. Define creates it with the human's own GitHub identity (through `gh`), not a bot. The caller workflow in the target repo runs on `issues.opened` only if both of these are true:

- the issue has a type label (`feature`, `bug` or `refactor`),
- the body contains a trace ID.

Hand-written issues normally lack a trace ID, so they don't start a run; to have one processed, take it through Define. This check is not a security boundary: anyone who can open a labelled issue with a trace ID can start a paid run. That is why target repos must be private, with only trusted collaborators.

The caller workflow also runs on `issues.labeled` for the `rerun:<stage>` labels (see Re-running a stage).

### Template check

Implement starts by checking the issue against `template/issue.yml` in two steps:

1. **Structure (script, no LLM):** every required heading is present and non-empty, and the type label and trace ID exist.
2. **Quality (single cheap call):** the model is given the same `issue.yml` and judges content, for example whether the acceptance criteria are actually testable.

If either step fails, the check comments on what is missing, adds `needs-definition` and stops. Running `/define <issue#>` updates that issue instead of creating a new one (see Define stage).

### Review loop

A `changes_requested` verdict sends the work back to Implement, with the findings as extra input. After 3 rounds the run escalates to a human.

### Re-running a stage

Adding a `rerun:<stage>` label (or a workflow dispatch) re-runs that stage from its stored input. Each re-run gets a new trace ID, linked to the old one through `previous_trace_id`.

### Concurrency and a moving `main`

- Runs on the same issue are serialised with an Actions `concurrency` group per issue (`cancel-in-progress: false`). Runs on different issues go in parallel.
- Implement branches from the latest `main`. Before Publish, the orchestrator rebases onto `main`. A clean rebase re-runs tests and opens the PR; a conflict escalates and is never auto-resolved.
- The pipeline's job ends when the PR is open. The PR's normal CI is the final check, and keeping the PR up to date is the human's job from there.

## Define stage

Define is the `define` skill from the `agent-runner` plugin. It runs in the human's main Claude Code session, inside the target repo. Claude Code requires a plugin skill's main file to be `skills/define/SKILL.md`, so `SKILL.md` stays short (frontmatter, allowed scripts, the steps below) and points to `DEFINER.md` next to it for the full instructions.

The skill gets the session ID through Claude Code's `${CLAUDE_SESSION_ID}` substitution, and the plugin's location through `${CLAUDE_PLUGIN_ROOT}`. Both are substituted into the skill text, not set as shell variables, so the skill passes them to its scripts as arguments.

**Prerequisite:** the user-level `grilling` skill. The `/grill-me` command is a user-only alias (`disable-model-invocation: true`) that forwards to it, so the definer calls `grilling` directly. The skill checks for it at startup and stops with an install hint if it is missing. It also stops if the target repo is public (see Constraints).

### New issue: `/define <prompt>`

1. **Interview.** Call the `grilling` skill on the prompt. The definer may call the explorer and prototyper along the way.
2. **Gap check.** Compare the conversation against `template/issue.yml`. List every required section the conversation can't fill (most often the rejected options for the Decision summary, and Out of scope), and ask only about those. Never invent a decision to fill a section.
3. **Draft.** Generate the trace ID (W3C style, 32 hex characters), read the session ID, propose the type label, and render the full issue from `issue.yml`.
4. **Confirm.** Show the rendered issue. Create it only on an explicit "yes"; any other reply is an edit request, and the draft is shown again.
5. **Create.** Create the issue in the current repo (from `gh repo view`) with `gh issue create`, under the human's identity, then post the Define trace comment (see Traceability and storage).

### Rework: `/define <issue#>`

Used after the template check adds `needs-definition`.

1. Read the issue body and the template check's comment.
2. Run the gap check against the existing issue and interview only about what is missing or rejected.
3. Show the rewritten issue and wait for an explicit "yes".
4. Update the body in place, remove `needs-definition` and add `rerun:implement`. The new run gets a new trace ID, linked to the old one through `previous_trace_id`.

Editing an issue by hand never starts a run, because the caller workflow doesn't listen to `issues.edited`.

### Prototypes

The prototyper pushes each prototype to the target repo as `proto/<slug>-<n>`, and the issue's Links section lists them. Implement may read them. A scheduled job deletes `proto/*` branches whose issue is closed.

## Distribution

`agent-runner` ships both halves of the pipeline from one repo, versioned together with tags (`v1`, `v1.2.0`, …), so an issue written by Define always matches what that version's template check expects.

| Part | Contents | How a target repo uses it |
| --- | --- | --- |
| Claude Code plugin | `.claude-plugin/` manifest and marketplace, `skills/define/` (`SKILL.md` + `DEFINER.md`), `agents/EXPLORER.md` and `agents/PROTOTYPER.md`, `template/issue.yml`, and the bundled scripts `scripts/check-issue.mjs` (structure check) and `scripts/define-trace.mjs` (trace comment) | `/plugin marketplace add ajorquera/agent-runner`, then `/plugin install agent-runner`; run as `/agent-runner:define` |
| Reusable workflow | `.github/workflows/pipeline.yml` (`on: workflow_call`): template check, Implement, Review, Publish | A short caller workflow on `issues.opened` and `issues.labeled` that runs `uses: ajorquera/agent-runner/.github/workflows/pipeline.yml@v1` and passes the Anthropic API key as a secret |

`agent-runner` itself stays public, because a public repo's reusable workflow can be called from any repo. Target repos must be private (see Constraints).

Scripts are written in TypeScript under `src/` and bundled with esbuild into self-contained `scripts/*.mjs`, which are committed. Installing a plugin only clones the repo and never runs `npm install`, so the bundles must carry their dependencies. Run `npm run build` after any change under `src/`. The reusable workflow uses the same bundles, so the local and Actions structure checks are the same code.

## Human touchpoints

There are two required human actions and one forced escalation. Nothing else in the pipeline waits for a person.

1. **Confirm in Define (start gate).** The Define skill shows the fully rendered issue and creates it only after the human replies with an explicit "yes". Any other reply is treated as an edit request. That confirmation replaces the vague exit criterion "no remaining doubt".
2. **Merge (end gate).** A human reviews and merges every PR. Branch protection on `main` requires human approval, so agents can't merge.
3. **Escalation.** The run stops when any of these happens: the review loop reaches 3 rounds, a budget runs out at the root, or the rebase before Publish conflicts. When it stops, the orchestrator pushes the branch as WIP, posts a trace comment with the trace ID, and adds the `needs-human` label.

There is no gate for approving the plan. The plan is posted on the issue and included in the PR, so the human sees it at merge. Add a plan gate only if evaluation shows wrong plans are a frequent cause of failure.

## Issue template

Every issue from Define must have these sections. They are defined once, in `template/issue.yml` (heading, required flag, one-line description of what belongs there). The Define skill renders issues from that file and the template check grades against it, so the two can't drift apart; both ship under the same version tag.

| Section | Contents |
| --- | --- |
| Problem / motivation | Why this matters |
| Proposed solution | The agreed design |
| Decision summary | Decisions made in Define, including options that were rejected and why. This is the permanent record of the conversation. |
| Acceptance criteria | Concrete, testable conditions for done |
| Out of scope | What we explicitly decided not to do |
| Links | Trace ID, Claude Code session ID of the Define conversation, prototype branches (`proto/<slug>-<n>`) |
| Type label | `feature`, `bug` or `refactor`. It decides which extra instructions Implement and Review get (see Agents). |

## Agents

There are six agents, and each is defined in its own `<AGENT>.md`. In the headless stages the orchestrator enforces an allow-list of which agent may call which. An agent can't spawn anything outside its row, so an implementer can't spawn another implementer. The definer is a skill, not a subagent, because a subagent can't hold a conversation with the human; its row is guidance in its instructions, not enforced by code.

| Agent | Stage | Role | May call |
| --- | --- | --- | --- |
| definer (`skills/define/SKILL.md` + `DEFINER.md`) | Define | Runs the `grilling` interview, explores the codebase, prototypes, writes the issue | explorer, prototyper |
| explorer (`EXPLORER.md`) | Any | Read-only codebase search that returns a summary | Nothing (leaf) |
| prototyper (`PROTOTYPER.md`) | Define | Builds a throwaway prototype on branch `proto/<slug>-<n>` and pushes it | Nothing (leaf) |
| implementer (`IMPLEMENT.md`) | Implement | Plans, edits code, runs tests and lint | explorer, test-writer |
| test-writer (`TEST-WRITER.md`) | Implement | Writes tests for the acceptance criteria | explorer |
| reviewer (`REVIEWER.md`) | Review | Checks the change against acceptance criteria, conventions and coverage | explorer |

- **Depth:** in practice the deepest chain is 2 (stage agent → helper → explorer). The depth limit is a backstop.
- **Reviewer independence:** the reviewer starts with a fresh context and sees only the issue and the diff, never the implementer's transcript. That stops it from simply agreeing with the implementer's reasoning.
- **Template check:** this is a single call inside Implement, not an agent.

### Instructions by type label

Every label uses the same agents and budgets. The label only adds a section to the implementer's and reviewer's instructions.

| Label | Implementer must | Reviewer checks |
| --- | --- | --- |
| `bug` | First write a failing test that reproduces the bug, then fix it | The reproduction test exists and fails without the fix |
| `refactor` | Keep behaviour the same; existing tests pass without being edited | Rejects test-file changes unless they're justified |
| `feature` | Write tests for every acceptance criterion | Every criterion has a test |

The config allows separate budgets, models or agents per label. Use them only when evaluation data shows a difference.

## Budgets

Budgets are hierarchical, so each run has a hard upper bound on cost: no run can use more than 10M tokens.

### How budgets work

- **Carved out:** when a parent spawns a child, the child's tokens and calls come out of the parent's remaining budget. If the parent doesn't set an amount, the child gets 50% of what the parent has left.
- **Max calls** counts every call in the subtree, not just direct children.
- **Max depth** is measured from the root of the run (the stage agent is depth 0).
- **Token counting:** all input, including cache reads, plus output. This is conservative and simple to explain. The cost of a run is its root's usage.

### Starting values

| Agent | Tokens (subtree) | Max calls (subtree) | Max depth |
| --- | --- | --- | --- |
| implementer | 3M | 10 | 2 |
| test-writer | 50% of what the parent has left (default) | 3 | — |
| reviewer | 1M | 4 | 2 |
| explorer | 300k | 0 | Leaf |
| template check | Single call, about 30k | 0 | — |
| definer | Recorded only, not enforced (interactive) | — | — |

- **Rework rounds:** each Implement round after a review gets 50% of the first round's budget.
- **Per-run cap:** the whole run stops at 10M tokens, regardless of what is left at stage level.
- **Recalibration:** after about 20 runs, set each cap to roughly the 90th percentile of what successful runs used, times 1.5.

### When a budget runs out

1. **Hard stop.** The orchestrator, not the model, cuts the agent off at its cap. The agent gets one final turn from a small reserved budget to return `{status: "budget_exhausted", done: [...], remaining: [...], state: "..."}`.
2. **The parent decides.** That report comes back to the parent as a normal tool result. The parent can continue with the partial work or pass the failure up.
3. **At the root:** the orchestrator pushes the branch as WIP, posts a trace comment with `status: budget_exhausted`, adds `needs-human` and stops.
4. **No automatic top-up.** Re-running with a larger budget is a human decision, made with `rerun:<stage>`. The re-run resumes from the pushed branch.
5. **Depth limit:** a spawn past the limit is refused immediately with an error. The agent continues without that sub-agent, and nothing else stops.

## Traceability and storage

Any PR can be traced back to its decisions permanently, using GitHub alone. Raw transcripts are kept for 30 days for debugging.

### Trace model

Each pipeline run gets a unique `trace_id`. Every agent call is a span with `span_id` and `parent_span_id`, so the run can be rebuilt as a tree. The fields follow OpenTelemetry naming, so a tracing backend can be added later without changing the data.

### Two retention tiers

| Data | Where | Retention |
| --- | --- | --- |
| Decision summary | Issue body | Permanent |
| Implementation plan | Issue comment | Permanent |
| Review verdicts and findings | PR review comments | Permanent |
| Trace metadata (one JSON comment per stage) | Issue (Define, Implement) or PR (Review, Publish) | Permanent |
| Implement, Review and Publish transcripts | GitHub Actions artifacts (`retention-days: 30`), linked from the trace comment | 30 days |
| Define transcript | Local Claude Code session (`cleanupPeriodDays`); session ID recorded in the issue | About 30 days |

The path PR → review → plan → issue → decisions works forever without opening a transcript. After 30 days the transcript links stop working, which is expected.

### Define's trace comment

Define has no orchestrator, so a bundled script posts its trace comment right after the issue is created. It finds the session's transcript at `~/.claude/projects/<project>/<session-id>.jsonl` (or under `CLAUDE_CONFIG_DIR`, if that is set) and adds up input (including cache reads) and output tokens for the session so far, following the counting rule in Budgets. `calls` is the number of subagents spawned. If the transcript can't be read or its format has changed, the script still posts the comment, with `"tokens": null`, and never blocks issue creation. Claude Code documents the transcript format as internal and subject to change, and doesn't document the token fields at all, so this fallback is expected to be needed sometimes.

### Trace comment format

Each stage posts one comment with a collapsible, machine-readable block. The headless stages post it as the workflow's bot; Define posts it as the human.

```
<details><summary>Trace: implement · 412k tokens · 7 calls · ok</summary>

{"trace_id":"…","span_id":"…","parent_span_id":"…","previous_trace_id":null,
 "stage":"implement","agent":"implementer","tokens":412000,"calls":7,"max_depth":2,
 "status":"ok","transcript":"<artifact-url>","children":[…]}
</details>
```

Repo collaborators can edit these comments, so treat them as records, not tamper-proof evidence. Move the metadata to a database only if querying it through the GitHub API becomes painful.

### Constraints

- Each target repo must stay private, with only trusted collaborators. Anyone with read access can download the artifacts, and anyone who can open a labelled issue with a trace ID can start a paid run (see Trigger). The `agent-runner` tool repo itself is public.
- The target repo's (or its org's) artifact retention limit must not be set below 30 days.

## Security

Even a confused or compromised agent can change only its own branch, and a human still has to merge.

- **The orchestrator owns git.** Agents edit files in the workspace. The orchestrator commits and pushes, only to the run's branch `<issue#>-<slug>`. Agents never hold a token that can push.
- **Minimal token permissions:** `contents: write` (for the orchestrator's push), `issues: write` and `pull-requests: write`. Nothing else.
- **Branch protection on `main`** requires human approval.
- **Define runs as the human.** It creates issues and pushes `proto/*` branches with the human's own `gh` credentials, in an interactive session the human is watching. No bot credentials are kept on the human's machine.
- **Agent environment:** only the Anthropic API key is passed in. There are no deploy or cloud secrets. Test credentials are limited to dedicated test accounts.
- **Network:** package registries and the Anthropic API are allowed; everything else is blocked where the runner setup allows it.
- **The reviewer is read-only.** It has no write tools and can't run arbitrary commands; at most it can run the test suite.

## Evaluation

A scheduled GitHub Action collects the trace comments and GitHub outcomes into a weekly report. Once there are about 20 merged runs, a replay benchmark is added to test prompt changes.

| Metric group | Metrics | Source |
| --- | --- | --- |
| Process | Tokens per stage; review loops per run; escalation rate and cause (review loop, budget, rebase); budget exhaustion by level; time from issue to PR; template-check rejections | Trace comments |
| Outcome | PR merged as-is; size of human edits before merge (commits, lines); closed without merge; CI failures on the PR; reverted or linked to a bug within 30 days | GitHub |
| Regression benchmark (later) | Replay a fixed set of 10–20 past issues after any change to a prompt, model or budget, and compare process and outcome metrics with the baseline | Replay runs |

Until the benchmark exists, treat changes to `IMPLEMENT.md`, `REVIEWER.md` or the budgets as experiments, and judge them by the weekly report.

## Resolved questions

All four open questions from the first draft are now answered.

| Question | Answer | Section |
| --- | --- | --- |
| Where are agent transcripts stored, and for how long? | Actions artifacts for 30 days (headless stages); local Claude Code session for Define. Decisions and trace metadata are kept in GitHub permanently. | Traceability and storage |
| What are the concrete budget values per stage? | Implementer 3M tokens / 10 calls, reviewer 1M / 4, explorer 300k, a 10M cap per run; recalibrated after about 20 runs | Budgets |
| Where must a human approve before the pipeline continues? | Confirming the issue in Define, and merging the PR. Escalation on an exhausted review loop, an exhausted budget or a rebase conflict. | Human touchpoints |
| Does each issue label map to a different setup? | Only the instructions change; budgets can be set per label but start the same | Agents |

### Define design decisions

Settled in a grilling session before building the Define stage.

| Decision | Answer | Rejected and why |
| --- | --- | --- |
| How is the definer packaged? | A skill in the main Claude Code session | Subagent: can't talk to the human. Separate SDK program: loses the session ID and `/resume`. |
| Who creates the issue? | The human, through `gh` | Bot via workflow dispatch or a local App token: more moving parts for a single-maintainer setup |
| What does the trigger check? | Type label and trace ID only | Signed trace ID or maintainer-only label: extra complexity; private target repos cover the risk |
| How is `agent-runner` distributed? | Public tool repo: a Claude Code plugin plus a reusable workflow, versioned together | Copying the skill into each repo, or a user-level install: they drift from the template check |
| Where is the template defined? | One `template/issue.yml`, read by Define and by the template check | Issue forms or prose in two places: they drift |
| How does the interview work? | The user-level `grilling` (what `/grill-me` forwards to), then a gap check against `issue.yml` | Bundling its own interview: duplicates a trusted skill |
| How does rework work? | `/define <n>` updates the issue in place and adds `rerun:implement` | Listening to `issues.edited`: every typo fix would start a paid run. A new issue: splits the history. |
| Where do prototypes live? | Pushed as `proto/<slug>-<n>`, linked in the issue, deleted once it closes; Implement may read them | Local only: Implement can't see them |
| Are Define's tokens recorded? | Yes, read from the local session transcript; `null` if unreadable | Omitting them: the weekly report can't show what Define costs |
