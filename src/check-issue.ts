// Usage: check-issue.mjs <template.yml> <body-file> [label...]
// Exits 0 if the issue passes the structure check, 1 with one problem per line if not, 2 on bad usage.
import { readFileSync } from "node:fs";
import { checkStructure } from "./structure.ts";
import { loadTemplate } from "./template.ts";

const [templatePath, bodyPath, ...labels] = process.argv.slice(2);
if (!templatePath || !bodyPath) {
  console.error("Usage: check-issue.mjs <template.yml> <body-file> [label...]");
  process.exit(2);
}

const errors = checkStructure(readFileSync(bodyPath, "utf8"), labels, loadTemplate(templatePath));
if (errors.length > 0) {
  for (const error of errors) console.log(`- ${error}`);
  process.exit(1);
}
console.log("Structure check passed.");
