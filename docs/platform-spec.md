# Cloud AI agent runner — platform spec (v1)

Handoff-ready spec for running Claude Code / Claude Agent SDK agents in containers, scoped to this repo. Source: [wayfinder map #1](https://github.com/ajorquera/agent-runner/issues/1).

## Scope

Single repo only (`ajorquera/agent-runner`) — no multi-tenant design. Agents in scope: Claude Code / Claude Agent SDK only. Trigger for v1 is manual/API (`repository_dispatch`); event-driven GitHub-webhook trigger is a noted extension point, not built now.

## Platform

GitHub Actions, GitHub-hosted runners. Chosen over the research pick as a stakeholder override — repo already lives on GitHub, isolation trusted as GitHub-operated infra, zero new vendor account. Run kicked off via `workflow_dispatch` / `repository_dispatch`; secrets delivered via `${{ secrets.X }}`.

Detail: [issue #2](https://github.com/ajorquera/agent-runner/issues/2), [platform research](research/cloud-target-platform.md).

## Isolation

Fresh Azure VM per job (GitHub's standard/larger runners). No hypervisor named by GitHub, no in-VM sandbox layer — the agent has root/admin of the VM. Nothing persists across runs except opt-in `actions/cache`. Egress open by default.

Detail: [issue #3](https://github.com/ajorquera/agent-runner/issues/3), [isolation research](research/isolation-mechanism.md).

## Secrets

Fixed set: `ANTHROPIC_API_KEY` + a fine-grained repo-scoped PAT for the agent's own use. Delivered as Actions encrypted secrets via env vars, relying on GitHub's log masking. PAT: 1-year expiry, manual rotation. No secret-scan leak guard for v1.

Detail: [issue #4](https://github.com/ajorquera/agent-runner/issues/4).

## Network / filesystem / resource policy

- **Network**: egress fully open, no allowlist.
- **Filesystem**: default runner user (non-root, passwordless sudo), fully writable.
- **Timeout**: `timeout-minutes: 20` default, overridable per workflow.
- **Resources**: standard 2-core/7GB runner (cheapest tier) default, overridable per workflow.

Detail: [issue #5](https://github.com/ajorquera/agent-runner/issues/5).

## Agent's default access

Reuses the secrets PAT: contents/issues/PRs read-write, metadata read, no Actions/Admin/Workflows. Shallow depth-1 checkout of the default branch at `$GITHUB_WORKSPACE`, no submodules. Scratch output goes to the VM's `/tmp`, not the repo checkout. Checking out a ref from the trigger payload is handled by the trigger design (below), not here.

Detail: [issue #6](https://github.com/ajorquera/agent-runner/issues/6).

## Trigger / orchestration

`repository_dispatch` for cross-repo/API triggering, single fixed `event_type`, free-form `client_payload` — no fixed schema; the caller's payload is task-dependent and includes its own callback instructions. Observability is native Actions logs only; teardown is automatic (ephemeral VM); there is no status-polling API. Completion is signaled by the agent's own output (see Result capture).

Detail: [issue #7](https://github.com/ajorquera/agent-runner/issues/7).

## Result capture

The agent pushes commits/PRs/comments per-task via `git`/`gh` CLI using its granted PAT — no fixed policy on which. Completion signal is the observable GitHub output itself (no polling API). The workflow's exit code mirrors the agent process's exit status, but that's visible only inside the Actions run — it is not surfaced to the caller.

Detail: [issue #8](https://github.com/ajorquera/agent-runner/issues/8).

## Trigger auth

A single shared trigger token, used by all callers, kept separate from the agent's own PAT — for audit trail and independent rotation, not privilege separation (the caller already controls the free-form payload). Bare possession of the token = authorized; no additional validation. Scope: `Contents:write` only. Same 1-year/manual rotation as the secrets PAT. Token custody is the caller's own responsibility — out of scope here.

Caller-facing usage docs and issuance/rotation record: [docs/triggering.md](triggering.md).

Detail: [issue #9](https://github.com/ajorquera/agent-runner/issues/9).

## Cost / concurrency caps

10 concurrent runs, default and tunable — no hard research behind the number. No cost ceiling or alerting for v1: the repo is public, standard runners are free/unlimited-minutes (per the resource policy above), so there's no billing exposure unless a workflow opts into a paid runner tier.

Detail: [issue #10](https://github.com/ajorquera/agent-runner/issues/10).

## Observability / failure alerting

GitHub's built-in workflow-run-failed notification only — no workflow-side alerting step, no dashboard, no external channel. Audience is the repo owner alone, gated by their own GitHub notification settings; there is no caller-facing failure signal. This relies on the exit-code propagation already decided under Result capture — a real failure already fails the Actions run, so GitHub's default notification picks it up with zero extra work.

Detail: [issue #11](https://github.com/ajorquera/agent-runner/issues/11).

## Out of scope

- **GitHub webhook auto-trigger** — the destination names manual/API trigger as required for v1; event-driven webhook trigger is an extension point, not required now.

## Testing

Black box, at the trigger boundary only — the seam a real caller uses, not the
workflow's internal steps. `scripts/test-agent-run.sh` fires a
`repository_dispatch` the same way a caller would, polls `gh run view --json
conclusion` for a terminal result, and asserts the GitHub-visible side effect
the dispatched prompt asked for (a PR with a unique marker in its title). Run
it with `success` or `failure` to exercise each scenario. Requires a
maintainer-scoped `gh` auth (Actions + PR read), not the caller-facing
`TRIGGER_TOKEN` — that token can only dispatch, not poll runs or read PRs.

Not covered, deliberately (platform guarantees / config facts, not
agent-runner behavior): secret masking, PAT scope enforcement, checkout
depth, runner tier.

## Status

No open decisions remain. All ten map tickets are closed; the map ([issue #1](https://github.com/ajorquera/agent-runner/issues/1)) carries no unresolved fog. Ready to build from.
