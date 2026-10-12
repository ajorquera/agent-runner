---
name: define
description: Turn an idea into a template-compliant GitHub issue that starts an agent-runner pipeline run, or repair an issue the template check marked needs-definition.
argument-hint: "<idea> | <issue#>"
disable-model-invocation: true
allowed-tools: Bash(gh repo view *), Bash(gh issue view *), Bash(openssl rand -hex 16), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check-issue.mjs *), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/define-trace.mjs *)
---

# Define

Read [DEFINER.md](DEFINER.md) now and follow it. It holds the full instructions; this file only carries the values Claude Code substitutes.

- **Arguments:** `$ARGUMENTS`
- **Session ID:** `${CLAUDE_SESSION_ID}`
- **Issue template:** `${CLAUDE_PLUGIN_ROOT}/template/issue.yml`
- **Structure check:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-issue.mjs ${CLAUDE_PLUGIN_ROOT}/template/issue.yml <body-file> <type-label>`. Exit 0 means it passes; exit 1 lists one problem per line.
- **Trace comment:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/define-trace.mjs <issue#> <trace-id> ${CLAUDE_SESSION_ID} [<previous-trace-id>]`

If the arguments are a bare issue number (for example `42` or `#42`), follow **Rework**. Otherwise follow **New issue**, with the arguments as the idea.
