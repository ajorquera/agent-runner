import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/define-trace.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// src/trace-comment.ts
function traceComment(span) {
  const tokens2 = span.tokens === null ? "tokens unknown" : `${formatTokens(span.tokens)} tokens`;
  const summary = `Trace: ${span.stage} \xB7 ${tokens2} \xB7 ${span.calls} calls \xB7 ${span.status}`;
  return `<details><summary>${summary}</summary>

${JSON.stringify(span)}
</details>
`;
}
function formatTokens(tokens2) {
  if (tokens2 >= 1e6) return `${(tokens2 / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens2 >= 1e3) return `${Math.round(tokens2 / 1e3)}k`;
  return String(tokens2);
}

// src/usage.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function findTranscript(sessionId2, configDir = defaultConfigDir()) {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${sessionId2}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}
function sessionUsage(transcriptPath) {
  const subagentDir = join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
  const subagents = existsSync(subagentDir) ? readdirSync(subagentDir).filter((file) => file.endsWith(".jsonl")) : [];
  let tokens2 = transcriptTokens(transcriptPath);
  for (const file of subagents) tokens2 += transcriptTokens(join(subagentDir, file));
  return { tokens: tokens2, calls: subagents.length };
}
function transcriptTokens(path) {
  const seen = /* @__PURE__ */ new Set();
  let total = 0;
  let assistantLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (entry.type !== "assistant") continue;
    assistantLines++;
    const id = entry.message?.id;
    const usage = entry.message?.usage;
    if (!id || !usage || seen.has(id)) continue;
    seen.add(id);
    total += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  if (assistantLines > 0 && seen.size === 0) {
    throw new Error(`No usage found in ${path}; the transcript format may have changed.`);
  }
  return total;
}

// src/define-trace.ts
var args = process.argv.slice(2);
var dryRun = args[0] === "--dry-run";
var [issue, traceId, sessionId, previousTraceId] = dryRun ? args.slice(1) : args;
if (!issue || !traceId || !sessionId) {
  console.error("Usage: define-trace.mjs [--dry-run] <issue#> <trace-id> <session-id> [<previous-trace-id>]");
  process.exit(2);
}
var tokens = null;
var calls = 0;
try {
  const transcript = findTranscript(sessionId);
  if (!transcript) throw new Error(`No transcript found for session ${sessionId}.`);
  ({ tokens, calls } = sessionUsage(transcript));
} catch (error) {
  console.error(`Warning: ${error.message} Posting with tokens: null.`);
}
var body = traceComment({
  trace_id: traceId,
  span_id: randomBytes(8).toString("hex"),
  parent_span_id: null,
  previous_trace_id: previousTraceId ?? null,
  stage: "define",
  agent: "definer",
  tokens,
  calls,
  max_depth: calls > 0 ? 1 : 0,
  status: "ok",
  transcript: null,
  session_id: sessionId,
  children: []
});
if (dryRun) {
  process.stdout.write(body);
} else {
  execFileSync("gh", ["issue", "comment", issue.replace(/^#/, ""), "--body-file", "-"], {
    input: body,
    stdio: ["pipe", "inherit", "inherit"]
  });
}
