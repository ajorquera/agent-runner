import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Section {
  heading: string;
  required: boolean;
  description: string;
  generated?: boolean;
}

export interface Field {
  line: string;
  pattern: string;
  optional?: boolean;
  repeated?: boolean;
}

export interface Template {
  version: number;
  type_labels: string[];
  sections: Section[];
  fields: Record<string, Field>;
}

export function loadTemplate(path: string): Template {
  return parse(readFileSync(path, "utf8")) as Template;
}

/** The labels that are type labels from the template. A valid issue has exactly one. */
export function findTypeLabels(labels: string[], template: Template): string[] {
  return labels.filter((label) => template.type_labels.includes(label));
}

/** Splits a Markdown body into `## heading` sections, in order. Text before the first heading is dropped. */
export function splitSections(body: string): { heading: string; content: string }[] {
  const sections: { heading: string; content: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) sections.push({ heading: match[1], content: "" });
    else if (sections.length > 0) sections[sections.length - 1].content += line + "\n";
  }
  return sections;
}

/** All captured values of a field in the body, e.g. every trace ID line. */
export function findField(body: string, field: Field): string[] {
  const pattern = new RegExp(field.pattern);
  return body
    .split(/\r?\n/)
    .map((line) => pattern.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}
