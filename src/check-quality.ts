// Usage: check-quality.mjs <template.yml> <body-file> [label...]
// Reads ANTHROPIC_API_KEY. Exits 0 if the issue passes the quality check, 1 with one problem per line if not,
// 2 on bad usage (including not exactly one type label: the structure check runs first, so that is a bug),
// 3 if the check can't run (an unreadable file, a broken template, a failed model call).
// Exit 1 only ever means problems with the issue.
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, MODEL, responseText, runQualityCheck, verdictSchema, type CallModel } from "./quality.ts";
import { findTypeLabels, loadTemplate, type Template } from "./template.ts";

const [templatePath, bodyPath, ...labels] = process.argv.slice(2);
if (!templatePath || !bodyPath) {
  console.error("Usage: check-quality.mjs <template.yml> <body-file> [label...]");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(2);
}

let template: Template;
let body: string;
try {
  template = loadTemplate(templatePath);
  body = readFileSync(bodyPath, "utf8");
} catch (error) {
  console.error(`Quality check could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}

const typeLabels = findTypeLabels(labels, template);
if (typeLabels.length !== 1) {
  console.error(`Expected exactly one type label (${template.type_labels.join(", ")}), found ${typeLabels.join(", ") || "none"}. Run the structure check first.`);
  process.exit(2);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const callModel: CallModel = async (prompt) =>
  responseText(
    await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low", format: { type: "json_schema", schema: verdictSchema(prompt.sections) } },
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    }),
  );

const outcome = await runQualityCheck(body, typeLabels[0], template, callModel);
for (const line of outcome.stdout) console.log(line);
for (const line of outcome.stderr) console.error(line);
process.exit(outcome.code);
