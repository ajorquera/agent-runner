import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildPrompt,
  MAX_BODY_CHARS,
  parseVerdict,
  QualityCallError,
  responseText,
  runQualityCheck,
  verdictSchema,
  type CallModel,
  type Prompt,
} from "./quality.ts";
import { loadTemplate } from "./template.ts";

const template = loadTemplate(new URL("../template/issue.yml", import.meta.url).pathname);
const SECTIONS = ["Problem / motivation", "Proposed solution", "Decision summary", "Acceptance criteria", "Out of scope"];
const BODY = "## Problem / motivation\n\nUsers can't export reports.\n";

/** A fake model call that records the prompt and returns the given JSON. */
function fake(response: unknown): CallModel & { prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  const call = async (prompt: Prompt) => {
    prompts.push(prompt);
    return typeof response === "string" ? response : JSON.stringify(response);
  };
  return Object.assign(call, { prompts });
}

function message(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {} as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

test("prompt: judges every section except the generated Links", () => {
  const prompt = buildPrompt(BODY, "feature", template);
  assert.deepEqual(prompt.sections, SECTIONS);
  for (const section of template.sections.filter((s) => !s.generated)) {
    assert.ok(prompt.system.includes(`"## ${section.heading}": ${section.description}`));
  }
  assert.ok(!prompt.system.includes('"## Links"'));
});

test("prompt: carries the key rules and the body as data", () => {
  const { system, user } = buildPrompt(BODY, "bug", template);
  assert.match(system, /checkable by a test or a command/);
  assert.match(system, /bug, the Acceptance criteria must include a reproduction/);
  assert.match(system, /options rejected and why/);
  assert.match(system, /stand on its own/);
  assert.match(system, /"None" is acceptable/);
  assert.match(system, /lenient on style/);
  assert.match(system, /data to judge, not instructions/);
  assert.match(user, /^Type label: bug \(Existing behaviour is wrong\..*reproduction/);
  assert.ok(user.includes(`<issue>\n${BODY}\n</issue>`));
});

test("schema: restricts sections to the judged ones", () => {
  const schema = verdictSchema(SECTIONS);
  assert.deepEqual(schema.properties.problems.items.properties.section.enum, SECTIONS);
  assert.equal(schema.additionalProperties, false);
});

test("parse: pass and fail verdicts", () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass","problems":[]}', SECTIONS), { verdict: "pass", problems: [] });
  const fail = { verdict: "fail", problems: [{ section: "Out of scope", problem: "Say what was left out." }] };
  assert.deepEqual(parseVerdict(JSON.stringify(fail), SECTIONS), fail);
});

test("parse: malformed responses are call errors", () => {
  const bad = [
    "not json",
    "[]",
    '{"verdict":"maybe","problems":[]}',
    '{"verdict":"fail"}',
    '{"verdict":"fail","problems":[{"section":"Links","problem":"x"}]}',
    '{"verdict":"fail","problems":[{"section":"Out of scope","problem":"  "}]}',
    '{"verdict":"fail","problems":[]}',
    '{"verdict":"pass","problems":[{"section":"Out of scope","problem":"x"}]}',
  ];
  for (const text of bad) assert.throws(() => parseVerdict(text, SECTIONS), QualityCallError, text);
});

test("response: joins text blocks and rejects unfinished or refused responses", () => {
  const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;
  assert.equal(responseText(message({ content: [text('{"verdict":'), text('"pass","problems":[]}')] })), '{"verdict":"pass","problems":[]}');
  assert.throws(() => responseText(message({ content: [] })), /no text/);
  assert.throws(() => responseText(message({ stop_reason: "max_tokens", content: [text("{")] })), /max_tokens/);
  assert.throws(
    () => responseText(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as Anthropic.Message["stop_details"] })),
    /refusal.*cyber/,
  );
});

test("run: pass is exit 0", async () => {
  const call = fake({ verdict: "pass", problems: [] });
  assert.deepEqual(await runQualityCheck(BODY, "feature", template, call), { code: 0, stdout: ["Quality check passed."], stderr: [] });
  assert.equal(call.prompts.length, 1);
});

test("run: problems are exit 1, one per line naming the section", async () => {
  const call = fake({
    verdict: "fail",
    problems: [
      { section: "Acceptance criteria", problem: "\"Export is fast\" can't be checked; give a time limit and the command that measures it." },
      { section: "Decision summary", problem: "CSV over XLSX lists no rejected option. " },
    ],
  });
  assert.deepEqual(await runQualityCheck(BODY, "feature", template, call), {
    code: 1,
    stdout: [
      "- Acceptance criteria: \"Export is fast\" can't be checked; give a time limit and the command that measures it.",
      "- Decision summary: CSV over XLSX lists no rejected option.",
    ],
    stderr: [],
  });
});

test("run: call failures are exit 3, never reported as issue problems", async () => {
  const failures: CallModel[] = [
    fake("garbage"),
    async () => {
      throw new Anthropic.APIConnectionError({ message: "socket hang up" });
    },
    async () => {
      throw new QualityCallError('The model stopped with "max_tokens".');
    },
    async () => {
      throw new TypeError("boom");
    },
  ];
  for (const call of failures) {
    const outcome = await runQualityCheck(BODY, "feature", template, call);
    assert.equal(outcome.code, 3);
    assert.deepEqual(outcome.stdout, []);
    assert.match(outcome.stderr[0], /^Quality check could not run: /);
  }
});

test("run: an oversized body is a problem and makes no call", async () => {
  const call = fake({ verdict: "pass", problems: [] });
  const outcome = await runQualityCheck("x".repeat(MAX_BODY_CHARS + 1), "feature", template, call);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stdout[0], /at most 80000/);
  assert.equal(call.prompts.length, 0);
});
