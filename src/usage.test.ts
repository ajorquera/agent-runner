import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTranscript, sessionUsage, transcriptTokens } from "./usage.ts";

const SESSION = "4aab8db9-6e79-4f87-9d03-77c6f9de2359";

function assistant(id: string, usage: object) {
  return JSON.stringify({ type: "assistant", message: { id, usage } });
}

const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 };

function fixture(): { configDir: string; transcript: string } {
  const configDir = mkdtempSync(join(tmpdir(), "usage-"));
  const project = join(configDir, "projects", "-Users-me-repo");
  mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
  const transcript = join(project, `${SESSION}.jsonl`);
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistant("msg_1", usage),
      assistant("msg_1", usage), // same response split over two lines
      assistant("msg_2", usage),
    ].join("\n") + "\n",
  );
  writeFileSync(join(project, SESSION, "subagents", "agent-a.jsonl"), assistant("msg_3", usage) + "\n");
  writeFileSync(join(project, SESSION, "subagents", "agent-a.meta.json"), "{}");
  return { configDir, transcript };
}

test("finds the transcript by session ID in any project folder", () => {
  const { configDir, transcript } = fixture();
  assert.equal(findTranscript(SESSION, configDir), transcript);
  assert.equal(findTranscript("00000000-0000-0000-0000-000000000000", configDir), null);
});

test("counts each response once and includes subagents", () => {
  const { transcript } = fixture();
  assert.equal(transcriptTokens(transcript), 2 * 1152);
  assert.deepEqual(sessionUsage(transcript), { tokens: 3 * 1152, calls: 1 });
});

test("throws when assistant lines carry no usage", () => {
  const { configDir } = fixture();
  const path = join(configDir, "changed.jsonl");
  writeFileSync(path, JSON.stringify({ type: "assistant", message: { id: "x" } }) + "\n");
  assert.throws(() => transcriptTokens(path), /format may have changed/);
});
