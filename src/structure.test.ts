import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStructure } from "./structure.ts";
import { loadTemplate } from "./template.ts";

const template = loadTemplate(new URL("../template/issue.yml", import.meta.url).pathname);
const TRACE = "0123456789abcdef0123456789abcdef";
const SESSION = "4aab8db9-6e79-4f87-9d03-77c6f9de2359";

function body(overrides: Record<string, string | null> = {}): string {
  const sections: Record<string, string | null> = {
    "Problem / motivation": "Users can't export reports.",
    "Proposed solution": "Add a CSV export button.",
    "Decision summary": "- CSV, not XLSX: no dependency needed.",
    "Acceptance criteria": "- [ ] Clicking Export downloads a CSV.",
    "Out of scope": "PDF export.",
    Links: `Trace ID: \`${TRACE}\`\nDefine session: \`${SESSION}\``,
    ...overrides,
  };
  return Object.entries(sections)
    .filter(([, content]) => content !== null)
    .map(([heading, content]) => `## ${heading}\n\n${content}\n`)
    .join("\n");
}

test("a complete issue passes", () => {
  assert.deepEqual(checkStructure(body(), ["feature"], template), []);
});

test("prototype lines may repeat and previous trace ID is optional", () => {
  const links = `Trace ID: \`${TRACE}\`\nDefine session: \`${SESSION}\`\nPrevious trace ID: \`${TRACE}\`\nPrototype: \`proto/export-1\`\nPrototype: \`proto/export-2\``;
  assert.deepEqual(checkStructure(body({ Links: links }), ["feature"], template), []);
});

test("type label: none, two, and unrelated labels", () => {
  assert.match(checkStructure(body(), [], template)[0], /found none/);
  assert.match(checkStructure(body(), ["bug", "feature"], template)[0], /found bug, feature/);
  assert.deepEqual(checkStructure(body(), ["bug", "good first issue"], template), []);
});

test("missing and empty sections", () => {
  assert.deepEqual(checkStructure(body({ "Out of scope": null }), ["bug"], template), [
    'Missing required section "## Out of scope".',
  ]);
  assert.deepEqual(checkStructure(body({ "Decision summary": "  " }), ["bug"], template), [
    'Section "## Decision summary" is empty.',
  ]);
});

test("unknown, duplicated and out-of-order sections", () => {
  assert.deepEqual(checkStructure(body() + "\n## Notes\n\nhi\n", ["bug"], template), ['Unknown section "## Notes".']);
  assert.match(checkStructure(body() + "\n## Out of scope\n\nmore\n", ["bug"], template)[0], /appears 2 times/);
  const swapped = body().replace("## Problem / motivation", "## TMP").replace("## Proposed solution", "## Problem / motivation").replace("## TMP", "## Proposed solution");
  assert.match(checkStructure(swapped, ["bug"], template)[0], /out of order/);
});

test("links: missing, malformed and duplicated fields", () => {
  assert.match(checkStructure(body({ Links: `Define session: \`${SESSION}\`` }), ["bug"], template)[0], /missing trace_id/);
  assert.match(checkStructure(body({ Links: `Trace ID: \`not-hex\`\nDefine session: \`${SESSION}\`` }), ["bug"], template)[0], /missing trace_id/);
  assert.match(
    checkStructure(body({ Links: `Trace ID: \`${TRACE}\`\nTrace ID: \`${TRACE}\`\nDefine session: \`${SESSION}\`` }), ["bug"], template)[0],
    /2 trace_id lines/,
  );
});

test("a trace ID outside Links doesn't count", () => {
  const errors = checkStructure(body({ "Proposed solution": `Trace ID: \`${TRACE}\``, Links: `Define session: \`${SESSION}\`` }), ["bug"], template);
  assert.match(errors[0], /missing trace_id/);
});
