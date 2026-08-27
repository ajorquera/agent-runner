# Triggering an agent run

How to fire an agent run on this repo from outside GitHub Actions, using the
shared trigger token.

## For callers

Runs are kicked off via GitHub's `repository_dispatch` API, using the fixed
`event_type` `agent-run` (see `.github/workflows/agent-run.yml`). The payload
is free-form `client_payload` — there's no fixed schema; include whatever the
task needs, including your own callback instructions if you want to be
notified when the run finishes (there is no status-polling API — see
`docs/platform-spec.md`'s "Result capture" section).

Using `gh`:

```sh
gh api repos/ajorquera/agent-runner/dispatches \
  --method POST \
  -H "Authorization: Bearer $TRIGGER_TOKEN" \
  -f event_type=agent-run \
  -f 'client_payload[prompt]=<your task prompt>'
```

Or the raw REST endpoint:

```sh
curl -X POST \
  -H "Authorization: Bearer $TRIGGER_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ajorquera/agent-runner/dispatches \
  -d '{"event_type":"agent-run","client_payload":{"prompt":"<your task prompt>"}}'
```

`$TRIGGER_TOKEN` is a fine-grained GitHub PAT scoped to `Contents:write` on
this repo only. Bare possession of the token is treated as sufficient
authorization to fire a run — there is no additional workflow-side
validation, and the free-form prompt is passed straight into the agent with
permission checks disabled. **Treat it like a credential that can execute
arbitrary code on your behalf**, because it can.

### Custody

Storing, transmitting, and rotating the token is the caller's own
responsibility. This repo does not track who holds copies of it, and has no
mechanism to revoke access for one caller without rotating the token for all
callers.

### Rotation policy

Same policy as the agent's own PAT (settled in
[issue #9](https://github.com/ajorquera/agent-runner/issues/9)): 1-year
expiry, manual rotation. There is no automated expiry tracking or alerting —
the "Token record" below is the only record of when the current token expires.

### Token record

_Filled in by whoever mints the token — blank until then._

| Field | Value |
|---|---|
| Name | |
| Scope | |
| Issued | |
| Expires | |
| Rotated by | |

## For the repo owner

Fine-grained GitHub PATs cannot be created via `gh` or the REST API — GitHub
only exposes token creation through the web UI. To provision or rotate the
trigger token:

1. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** on the account that will own the token, and generate
   a new token.
2. Scope it to this repository only, with **Contents: Read and write** and no
   other permissions.
3. Set a 1-year expiration.
4. Copy the token value (it's shown once).
5. In this repo, go to **Settings → Secrets and variables → Actions**, and
   add (or update) a repository secret named `TRIGGER_TOKEN` with that value.
6. Fill in the "Token record" table above with the name, scope, issue date,
   and expiry date, and open a PR with that update so the record stays with
   the docs.

Note: `.github/workflows/agent-run.yml` does not read `TRIGGER_TOKEN` — the
workflow never validates the caller's token itself; GitHub's `dispatches`
endpoint authenticates it before the workflow ever runs (see
[issue #9](https://github.com/ajorquera/agent-runner/issues/9)). Storing it as
a repo secret exists so it has the same canonical, encrypted-at-rest home as
the repo's other secrets, and so a future test workflow can reference
`secrets.TRIGGER_TOKEN` without new plumbing.
