/**
 * Strict readers shared by the two mode document formats (ADR
 * mode-definitions): the legacy `mode.md` frontmatter split and the YAML
 * reader both formats use.
 *
 * Kept in its own module so the bundle reader (`mode-definitions-bundle.ts`)
 * and the catalog loader (`mode-definitions.ts`) share one implementation
 * without importing each other.
 */

import { isAlias, isPair, isScalar, parseDocument, visit } from "yaml";

export type SplitDocument =
  | { ok: true; frontmatter?: string; body: string }
  | { ok: false; error: string };

/** Frontmatter sits between a leading `---` line and the next `---` line. */
export function splitModeDocument(source: string): SplitDocument {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { ok: true, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { ok: false, error: "frontmatter: missing the closing --- line" };
  return { ok: true, frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

export type YamlResult = { ok: true; value: unknown; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Strict YAML: duplicate keys, anchors, aliases, explicit tags and merge keys
 * reject the document. A mode document is configuration, not a program, so
 * nothing in it may reshape what the validator sees.
 */
export function parseStrictModeYaml(source: string): YamlResult {
  const doc = parseDocument(source, { uniqueKeys: true, schema: "core", merge: false });
  const errors = doc.errors.map((error) => `frontmatter: ${error.message.split("\n")[0]}`);
  const structural = new Set<string>();
  visit(doc, {
    Pair(_key, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") {
        structural.add("frontmatter: merge keys (<<) are not supported");
      }
    },
    Node(_key, node) {
      if (isAlias(node)) {
        structural.add("frontmatter: aliases (*name) are not supported");
        return;
      }
      if (node.anchor) structural.add("frontmatter: anchors (&name) are not supported");
      if (node.tag) structural.add("frontmatter: explicit tags (!tag) are not supported");
    },
  });
  errors.push(...structural);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: doc.toJS({ maxAliasCount: 0 }),
    warnings: doc.warnings.map((warning) => `frontmatter: ${warning.message.split("\n")[0]}`),
  };
}
