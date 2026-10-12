import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionUsage {
  tokens: number;
  /** Subagents spawned in the session. */
  calls: number;
}

/**
 * Finds a session's transcript under the Claude Code config dir. The project
 * folder name is derived from the working directory, so search for the
 * session ID instead of recomputing it.
 */
export function findTranscript(sessionId: string, configDir = defaultConfigDir()): string | null {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const path = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * Sums a session's tokens, including its subagents, using the spec's rule:
 * all input (uncached, cache writes, cache reads) plus output. The transcript
 * format is internal to Claude Code, so this throws if it no longer matches.
 */
export function sessionUsage(transcriptPath: string): SessionUsage {
  const subagentDir = join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
  const subagents = existsSync(subagentDir)
    ? readdirSync(subagentDir).filter((file) => file.endsWith(".jsonl"))
    : [];

  let tokens = transcriptTokens(transcriptPath);
  for (const file of subagents) tokens += transcriptTokens(join(subagentDir, file));
  return { tokens, calls: subagents.length };
}

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** One API response is written as several lines that repeat its usage, so count each message ID once. */
export function transcriptTokens(path: string): number {
  const seen = new Set<string>();
  let total = 0;
  let assistantLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (entry.type !== "assistant") continue;
    assistantLines++;
    const id: string | undefined = entry.message?.id;
    const usage: Usage | undefined = entry.message?.usage;
    if (!id || !usage || seen.has(id)) continue;
    seen.add(id);
    total +=
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
  }
  if (assistantLines > 0 && seen.size === 0) {
    throw new Error(`No usage found in ${path}; the transcript format may have changed.`);
  }
  return total;
}
