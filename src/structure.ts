import { findField, findTypeLabels, splitSections, type Template } from "./template.ts";

const LINKS = "Links";

/**
 * The deterministic part of the template check: headings, non-empty sections,
 * exactly one type label, and well-formed fields in Links. Returns one message
 * per problem; an empty list means the issue passes.
 */
export function checkStructure(body: string, labels: string[], template: Template): string[] {
  const errors: string[] = [];

  const typeLabels = findTypeLabels(labels, template);
  if (typeLabels.length !== 1) {
    errors.push(
      `Expected exactly one type label (${template.type_labels.join(", ")}), found ${typeLabels.length === 0 ? "none" : typeLabels.join(", ")}.`,
    );
  }

  const found = splitSections(body);
  const known = new Set(template.sections.map((section) => section.heading));

  for (const { heading } of found) {
    if (!known.has(heading)) errors.push(`Unknown section "## ${heading}".`);
  }

  for (const section of template.sections) {
    const matches = found.filter((f) => f.heading === section.heading);
    if (matches.length > 1) errors.push(`Section "## ${section.heading}" appears ${matches.length} times.`);
    if (matches.length === 0) {
      if (section.required) errors.push(`Missing required section "## ${section.heading}".`);
    } else if (section.required && matches[0].content.trim() === "") {
      errors.push(`Section "## ${section.heading}" is empty.`);
    }
  }

  const order = found.map((f) => f.heading).filter((heading) => known.has(heading));
  const expected = template.sections.map((s) => s.heading).filter((heading) => order.includes(heading));
  if (order.length === expected.length && order.some((heading, i) => heading !== expected[i])) {
    errors.push(`Sections are out of order. Expected: ${expected.join(", ")}.`);
  }

  const links = found.find((f) => f.heading === LINKS)?.content ?? "";
  for (const [name, field] of Object.entries(template.fields)) {
    const values = findField(links, field);
    if (values.length === 0 && !field.optional) {
      errors.push(`Links is missing ${name}, as a line like: ${field.line}`);
    }
    if (values.length > 1 && !field.repeated) {
      errors.push(`Links has ${values.length} ${name} lines; expected one.`);
    }
  }

  return errors;
}
