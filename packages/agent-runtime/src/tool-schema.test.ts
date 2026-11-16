import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { withExplicitRequired } from "./tool-schema.js";

// Guards the provider-facing shape of a tool schema (#864). Tool types go
// through a JSON round trip before the provider sees them, so a key that is
// absent here is absent on the wire.

function toolWith(parameters: unknown): AgentTool {
  return { name: "fx", description: "fx", parameters } as unknown as AgentTool;
}

// Raw JSON fixtures have no `required` key until normalisation adds one.
// Reading them back through this shape keeps that key visible to tsc.
type ReadableSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, ReadableSchema>;
  items?: ReadableSchema | ReadableSchema[];
  additionalProperties?: ReadableSchema | boolean;
  anyOf?: ReadableSchema[];
  oneOf?: ReadableSchema[];
  allOf?: ReadableSchema[];
  prefixItems?: ReadableSchema[];
};

function readable(schema: unknown): ReadableSchema {
  return schema as ReadableSchema;
}

function readableList(
  schema: ReadableSchema | ReadableSchema[] | undefined,
): ReadableSchema[] {
  if (!Array.isArray(schema)) {
    throw new Error("expected a schema array");
  }
  return schema;
}

describe("withExplicitRequired", () => {
  it("omits required for an all-optional TypeBox object schema", () => {
    // The premise: Read, Glob, Grep, and BrowserPreview declare every argument
    // optional so the alias spelling validates too, and TypeBox 1.x then emits
    // no `required` key at all.
    expect(
      Type.Object({ path: Type.Optional(Type.String()) }),
    ).not.toHaveProperty("required");
  });

  it("spells out an empty required list", () => {
    const aliasTool = toolWith({
      type: "object",
      properties: {
        path: { type: "string" },
        file_path: { type: "string" },
      },
    });
    expect(withExplicitRequired(aliasTool).parameters).toMatchObject({
      type: "object",
      required: [],
    });
  });

  it("leaves an existing required list untouched", () => {
    const writeTool = toolWith(
      Type.Object({
        path: Type.Optional(Type.String()),
        content: Type.String(),
      }),
    );
    expect(withExplicitRequired(writeTool)).toBe(writeTool);
  });

  it("ignores schemas that are not object-shaped", () => {
    const union = toolWith({ anyOf: [{ type: "object" }] });
    expect(withExplicitRequired(union)).toBe(union);
  });

  it("spells out required on a nested all-optional TypeBox object", () => {
    // TypeBox 1.x also omits `required` on a nested object whose properties
    // are all optional. Optional here is "not listed in required", not an
    // anyOf wrapper, so `properties.options` itself is that object.
    const parameters = Type.Object({
      path: Type.String(),
      options: Type.Optional(
        Type.Object({
          path: Type.Optional(Type.String()),
          file_path: Type.Optional(Type.String()),
        }),
      ),
    });
    expect(parameters.properties.options).not.toHaveProperty("required");
    expect(parameters.required).toEqual(["path"]);

    const normalized = withExplicitRequired(toolWith(parameters))
      .parameters as typeof parameters;
    expect(normalized.required).toEqual(["path"]);
    expect(normalized.required).toBe(parameters.required);
    expect(normalized.properties.options).toMatchObject({
      type: "object",
      required: [],
    });
    expect(normalized.properties.options.properties.path).toBe(
      parameters.properties.options.properties.path,
    );
    expect(normalized.properties.options.properties.path).not.toHaveProperty(
      "required",
    );
    expect(parameters.properties.options).not.toHaveProperty("required");
  });

  it("spells out required on a nested JSON object without replacing the parent list", () => {
    // MCP and plugin tools hand over raw JSON Schema, not TypeBox.
    const parameters = {
      type: "object",
      required: ["config"],
      properties: {
        config: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
    };
    const normalized = readable(
      withExplicitRequired(toolWith(parameters)).parameters,
    );
    expect(normalized.required).toEqual(["config"]);
    expect(normalized.required).toBe(parameters.required);
    expect(normalized.properties?.config?.required).toEqual([]);
    expect(parameters.properties.config).not.toHaveProperty("required");
  });

  it("spells out required on object items, including a tuple items array", () => {
    const item = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const tupleObject = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const tupleString = { type: "string" };
    const parameters = {
      type: "object",
      required: ["rows", "pair"],
      properties: {
        rows: { type: "array", items: item },
        pair: { type: "array", items: [tupleObject, tupleString] },
      },
    };
    const normalized = readable(
      withExplicitRequired(toolWith(parameters)).parameters,
    );
    const rowsItems = normalized.properties?.rows?.items;
    const pairItems = readableList(normalized.properties?.pair?.items);
    expect(normalized.required).toEqual(["rows", "pair"]);
    expect(readable(rowsItems).required).toEqual([]);
    expect(pairItems[0]?.required).toEqual([]);
    expect(pairItems[1]).toBe(tupleString);
    expect(pairItems[1]).not.toHaveProperty("required");
    expect(item).not.toHaveProperty("required");
    expect(tupleObject).not.toHaveProperty("required");
  });

  it("keeps an already-required nested object and non-object nodes unchanged", () => {
    const nested = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const emptyRequired = {
      type: "object",
      required: [] as string[],
      properties: { note: { type: "string" } },
    };
    const label = { type: "string" };
    const normalizedTool = toolWith({
      type: "object",
      required: ["nested", "emptyRequired", "label"],
      properties: { nested, emptyRequired, label },
    });
    expect(withExplicitRequired(normalizedTool)).toBe(normalizedTool);

    // A sibling that still needs `required` forces a new parameters object.
    // The nodes that were already explicit keep their identity, and a deeper
    // copy does not replace an existing required list.
    const bag = { type: "object", properties: { note: { type: "string" } } };
    const childRequired = ["child"];
    const inner = { type: "object", properties: { note: { type: "string" } } };
    const parent = {
      type: "object",
      required: childRequired,
      properties: { child: inner },
    };
    const mixed = {
      type: "object",
      required: ["nested", "label", "bag", "parent"],
      properties: { nested, label, bag, parent },
    };
    const normalized = readable(withExplicitRequired(toolWith(mixed)).parameters);
    expect(normalized.required).toBe(mixed.required);
    expect(normalized.properties?.nested).toBe(nested);
    expect(normalized.properties?.label).toBe(label);
    expect(normalized.properties?.bag).not.toBe(bag);
    expect(normalized.properties?.bag?.required).toEqual([]);
    expect(normalized.properties?.parent?.required).toBe(childRequired);
    expect(normalized.properties?.parent?.properties?.child?.required).toEqual(
      [],
    );
    expect(bag).not.toHaveProperty("required");
    expect(inner).not.toHaveProperty("required");
    expect(parent.required).toBe(childRequired);
  });

  it("does not write required onto non-object nodes", () => {
    const branch = { type: "object", properties: { a: { type: "string" } } };
    const stringBranch = { type: "string" };
    const prefixObject = {
      type: "object",
      properties: { b: { type: "string" } },
    };
    const valueSchema = {
      type: "object",
      properties: { v: { type: "string" } },
    };
    const parameters = {
      type: "object",
      required: ["choice", "extra"],
      additionalProperties: false,
      properties: {
        choice: {
          anyOf: [branch, stringBranch],
          oneOf: [stringBranch],
          allOf: [branch],
        },
        extra: {
          type: "object",
          additionalProperties: valueSchema,
          prefixItems: [prefixObject, stringBranch],
        },
        rows: { type: "array", items: stringBranch },
      },
    };
    const normalized = readable(
      withExplicitRequired(toolWith(parameters)).parameters,
    );
    const choice = normalized.properties?.choice;
    const extra = normalized.properties?.extra;
    const prefixItems = readableList(extra?.prefixItems);
    expect(normalized.additionalProperties).toBe(false);
    expect(choice).not.toHaveProperty("required");
    expect(choice?.anyOf?.[0]?.required).toEqual([]);
    expect(choice?.anyOf?.[1]).toBe(stringBranch);
    expect(choice?.oneOf?.[0]).toBe(stringBranch);
    expect(choice?.allOf?.[0]?.required).toEqual([]);
    // `extra` is itself an object schema, so it gains an empty required list
    // while its non-object siblings do not.
    expect(extra?.required).toEqual([]);
    expect(readable(extra?.additionalProperties).required).toEqual([]);
    expect(prefixItems[0]?.required).toEqual([]);
    expect(prefixItems[1]).toBe(stringBranch);
    expect(normalized.properties?.rows).not.toHaveProperty("required");
    expect(normalized.properties?.rows?.items).toBe(stringBranch);
    expect(branch).not.toHaveProperty("required");
    expect(valueSchema).not.toHaveProperty("required");
    expect(prefixObject).not.toHaveProperty("required");
  });
});
