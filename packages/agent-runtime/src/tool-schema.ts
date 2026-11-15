/**
 * Provider-facing normalisation of tool parameter schemas.
 *
 * `Read`, `Glob`, `Grep`, and `BrowserPreview` declare their canonical argument
 * as `Type.Optional` so the `file_path` / `query` alias spelling validates too;
 * "exactly one spelling" is enforced by `requireAliasedParams` at execute time
 * instead (D273). TypeBox 1.x then omits `required` altogether when no property
 * is required — on the root and on nested objects and array `items`. The
 * OpenAI chat/completions adapter forwards `parameters` verbatim while only the
 * Anthropic adapter fills `required ?? []`. A relay that decodes the missing
 * key into a nil slice rejects the whole request with
 * `Invalid schema for function 'Read': null is not of type "array"` (#864).
 * MCP, plugin, and custom-tool JSON Schema has the same hole.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";

const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Spell out `required: []` on one schema node and the object schemas nested in
 * it. An existing `required` (including `[]`) is kept. Unchanged nodes keep
 * their identity, and the input is never mutated.
 */
function schemaWithExplicitRequired(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  let next: Record<string, unknown> | undefined;
  const update = (key: string, value: unknown) => {
    if (Object.is(value, schema[key])) return;
    next ??= { ...schema };
    next[key] = value;
  };

  if (isRecord(schema.properties)) {
    update("properties", recordWithExplicitRequired(schema.properties));
  }
  if ("items" in schema) {
    update("items", itemsWithExplicitRequired(schema.items));
  }
  // `additionalProperties` is often the boolean `false`. Only a schema object
  // can itself omit `required`.
  if (isRecord(schema.additionalProperties)) {
    update(
      "additionalProperties",
      schemaWithExplicitRequired(schema.additionalProperties),
    );
  }
  for (const key of SCHEMA_ARRAY_KEYS) {
    const entries = schema[key];
    if (Array.isArray(entries)) {
      update(key, schemasWithExplicitRequired(entries));
    }
  }

  if (schema.type !== "object" || schema.required !== undefined) {
    return next ?? schema;
  }
  if (next) {
    next.required = [];
    return next;
  }
  return Object.assign({}, schema, { required: [] });
}

function recordWithExplicitRequired(
  record: Record<string, unknown>,
): Record<string, unknown> {
  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(record)) {
    const normalized = schemaWithExplicitRequired(value);
    if (normalized === value) continue;
    next ??= { ...record };
    next[key] = normalized;
  }
  return next ?? record;
}

function schemasWithExplicitRequired(
  schemas: readonly unknown[],
): readonly unknown[] {
  let next: unknown[] | undefined;
  for (let index = 0; index < schemas.length; index += 1) {
    const value = schemas[index];
    const normalized = schemaWithExplicitRequired(value);
    if (normalized === value) continue;
    next ??= schemas.slice();
    next[index] = normalized;
  }
  return next ?? schemas;
}

function itemsWithExplicitRequired(items: unknown): unknown {
  if (Array.isArray(items)) return schemasWithExplicitRequired(items);
  return schemaWithExplicitRequired(items);
}

/**
 * Spell out `required` on object tool schemas before they reach the provider.
 *
 * For an object schema an absent `required` already means "nothing is
 * required", so writing `[]` states the same contract explicitly and changes no
 * tool's accepted arguments. Applied when the tool catalogue is built, so the
 * session agent and a delegated `Task` run send one declaration, and plugin,
 * skill, mode, delegation, extension, and ToolSearch schemas are covered by the
 * same pass. The pass walks `properties`, `items` (schema or tuple), object
 * `additionalProperties`, and `anyOf` / `oneOf` / `allOf` / `prefixItems`, and
 * writes `required: []` only on a `type: "object"` node that omitted it.
 * TypeBox's `Optional` is absent from `required`; a `Type.Union` wrapper is an
 * `anyOf`, and the object inside that wrapper is what gets the key. Parameters
 * that are not themselves `type: "object"`, and a schema that already spells
 * `required` out on every object node, are returned untouched.
 */
export function withExplicitRequired(tool: AgentTool): AgentTool {
  if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
    return tool;
  }
  const normalized = schemaWithExplicitRequired(tool.parameters);
  if (normalized === tool.parameters) return tool;
  return {
    ...tool,
    parameters: normalized as AgentTool["parameters"],
  };
}
