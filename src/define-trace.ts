// Usage: define-trace.mjs [--dry-run] <issue#> <trace-id> <session-id> [<previous-trace-id>]
// Posts Define's trace comment on the issue. Never fails because of the transcript:
// if usage can't be read, it posts the comment with "tokens": null.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { traceComment } from "./trace-comment.ts";
import { findTranscript, sessionUsage } from "./usage.ts";

const args = process.argv.slice(2);
const dryRun = args[0] === "--dry-run";
const [issue, traceId, sessionId, previousTraceId] = dryRun ? args.slice(1) : args;
if (!issue || !traceId || !sessionId) {
  console.error("Usage: define-trace.mjs [--dry-run] <issue#> <trace-id> <session-id> [<previous-trace-id>]");
  process.exit(2);
}

let tokens: number | null = null;
let calls = 0;
try {
  const transcript = findTranscript(sessionId);
  if (!transcript) throw new Error(`No transcript found for session ${sessionId}.`);
  ({ tokens, calls } = sessionUsage(transcript));
} catch (error) {
  console.error(`Warning: ${(error as Error).message} Posting with tokens: null.`);
}

const body = traceComment({
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
  children: [],
});

if (dryRun) {
  process.stdout.write(body);
} else {
  execFileSync("gh", ["issue", "comment", issue.replace(/^#/, ""), "--body-file", "-"], {
    input: body,
    stdio: ["pipe", "inherit", "inherit"],
  });
}
