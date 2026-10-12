import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, traceComment, type Span } from "./trace-comment.ts";

const span: Span = {
  trace_id: "t",
  span_id: "s",
  parent_span_id: null,
  previous_trace_id: null,
  stage: "implement",
  agent: "implementer",
  tokens: 412000,
  calls: 7,
  max_depth: 2,
  status: "ok",
  transcript: null,
  children: [],
};

test("summary line matches the spec's format", () => {
  assert.match(traceComment(span), /^<details><summary>Trace: implement · 412k tokens · 7 calls · ok<\/summary>\n\n\{/);
  assert.match(traceComment({ ...span, tokens: null }), /tokens unknown/);
});

test("the JSON block round-trips", () => {
  const json = traceComment(span).split("\n")[2];
  assert.deepEqual(JSON.parse(json), span);
});

test("token formatting", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(412_000), "412k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(2_450_000), "2.5M");
});
