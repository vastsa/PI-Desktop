/**
 * Provider-facing normalisation of tool parameter schemas.
 *
 * `Read`, `Glob`, `Grep`, and `BrowserPreview` declare their canonical argument
 * as `Type.Optional` so the `file_path` / `query` alias spelling validates too;
 * "exactly one spelling" is enforced by `requireAliasedParams` at execute time
 * instead (D273). TypeBox 1.x then omits `required` altogether when no property
 * is required, and the OpenAI chat/completions adapter forwards `parameters`
 * verbatim while only the Anthropic adapter fills `required ?? []`. A relay that
 * decodes the missing key into a nil slice rejects the whole request with
 * `Invalid schema for function 'Read': null is not of type "array"` (#864).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Spell out `required` on an object tool schema before it reaches the provider.
 *
 * For an object schema an absent `required` already means "nothing is
 * required", so writing `[]` states the same contract explicitly and changes no
 * tool's accepted arguments. Applied when the tool catalogue is built, so the
 * session agent and a delegated `Task` run send one declaration, and plugin,
 * skill, mode, delegation, extension, and ToolSearch schemas are covered by the
 * same pass. A non-object or already-normalised schema is returned untouched.
 */
export function withExplicitRequired(tool: AgentTool): AgentTool {
  const parameters = normalizeRequired(tool.parameters);
  if (parameters === tool.parameters) {
    return tool;
  }
  return {
    ...tool,
    parameters: parameters as AgentTool["parameters"],
  };
}

/**
 * Recursively spell out `required: []` on every object schema node that omits
 * it. TypeBox 1.x (and raw MCP / plugin JSON Schema) also drops `required` on
 * all-optional nested objects under `properties`, `items`, `prefixItems`,
 * `additionalProperties`, and `anyOf` / `oneOf` / `allOf`, so a relay that
 * decodes the missing key into a nil slice can reject the request for those
 * nodes too (#2337). An existing `required` list — including `[]` — is left
 * untouched, and non-object nodes never gain a `required` key. The input is
 * never mutated: nodes only get cloned along the paths that changed.
 */
type SchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const items = schema.map((item) => {
      const normalized = normalizeRequired(item);
      changed ||= normalized !== item;
      return normalized;
    });
    return changed ? items : schema;
  }
  if (!isPlainObject(schema)) {
    return schema;
  }
  const needsRequired = schema.type === "object" && schema.required === undefined;
  let changed = false;
  let clone: SchemaNode | null = needsRequired ? { ...schema } : null;
  const put = (key: string, value: unknown): void => {
    if (clone === null) {
      clone = { ...schema };
    }
    clone[key] = value;
    changed = true;
  };
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required") {
      continue;
    }
    // Schema-bearing keys: only these can contain nested schemas that need the
    // walk; `properties` is a map of schemas.
    if (key === "properties") {
      if (!isPlainObject(value)) continue;
      const innerClone: SchemaNode = {};
      let innerChanged = false;
      for (const [prop, propSchema] of Object.entries(value)) {
        const normalized = normalizeRequired(propSchema);
        innerChanged ||= normalized !== propSchema;
        innerClone[prop] = normalized;
      }
      if (innerChanged) {
        put(key, innerClone);
      }
      continue;
    }
    if (key === "additionalProperties") {
      if (typeof value !== "object" || value === null) continue;
      const normalized = normalizeRequired(value);
      if (normalized !== value) {
        put(key, normalized);
      }
      continue;
    }
    if (
      key === "items" ||
      key === "prefixItems" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "allOf"
    ) {
      const normalized = normalizeRequired(value);
      if (normalized !== value) {
        put(key, normalized);
      }
    }
  }
  if (needsRequired) {
    clone!.required = [];
    changed = true;
  }
  return changed ? clone : schema;
}
