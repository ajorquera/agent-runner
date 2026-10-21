// Usage: check-quality.mjs <template.yml> <body-file> <type-label>
// Reads ANTHROPIC_API_KEY. Exits 0 if the issue passes the quality check, 1 with one problem per line if not,
// 2 on bad usage, 3 if the model call fails (an infrastructure error, not a problem with the issue).
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOKENS, MODEL, responseText, runQualityCheck, verdictSchema, type CallModel } from "./quality.ts";
import { loadTemplate, type Template } from "./template.ts";

const [templatePath, bodyPath, typeLabel, ...rest] = process.argv.slice(2);
if (!templatePath || !bodyPath || !typeLabel || rest.length > 0) {
  console.error("Usage: check-quality.mjs <template.yml> <body-file> <type-label>");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(2);
}
let template: Template;
try {
  template = loadTemplate(templatePath);
} catch (error) {
  console.error(`Can't read the template: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!template.type_labels.includes(typeLabel)) {
  console.error(`Unknown type label "${typeLabel}". Expected one of: ${template.type_labels.join(", ")}.`);
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

let body: string;
try {
  body = readFileSync(bodyPath, "utf8");
} catch (error) {
  console.error(`Can't read the body file: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const outcome = await runQualityCheck(body, typeLabel, template, callModel);
for (const line of outcome.stdout) console.log(line);
for (const line of outcome.stderr) console.error(line);
process.exit(outcome.code);
