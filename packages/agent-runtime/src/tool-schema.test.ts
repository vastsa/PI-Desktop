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

  it("ignores a non-object root but still walks its combinator branches", () => {
    const union = toolWith({ anyOf: [{ type: "object" }] });
    const fixed = withExplicitRequired(union).parameters as {
      required?: unknown;
      anyOf: Record<string, unknown>[];
    };
    // The root itself is not object-shaped, so it never gains `required`.
    expect(fixed.required).toBeUndefined();
    // But an object branch nested in a combinator does (#2337).
    expect(fixed.anyOf[0]).toMatchObject({ type: "object", required: [] });
  });

  it("fills required on an all-optional nested object (#2337)", () => {
    const raw = Type.Object({
      path: Type.String(),
      options: Type.Optional(
        Type.Object({
          path: Type.Optional(Type.String()),
          file_path: Type.Optional(Type.String()),
        }),
      ),
    }) as unknown as {
      properties: Record<string, { required?: string[] }>;
    };
    const schema = toolWith(raw);
    const fixed = withExplicitRequired(schema).parameters as {
      properties: Record<string, { required?: string[] }>;
    };
    expect(fixed.properties.options).toMatchObject({
      type: "object",
      required: [],
    });
    expect(fixed).toMatchObject({ type: "object", required: ["path"] });
    // The input schema is not mutated.
    expect(raw.properties.options).not.toHaveProperty("required");
  });

  it("fills required inside items, prefixItems, additionalProperties, and combinators", () => {
    const raw = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
        tuple: {
          type: "array",
          prefixItems: [{ type: "object", properties: {} }],
        },
        map: {
          type: "object",
          additionalProperties: { type: "object", properties: {} },
        },
        branch: {
          anyOf: [{ type: "object", properties: {} }],
          oneOf: [{ type: "string" }],
          allOf: [{ type: "object", properties: {} }],
        },
      },
      required: ["list"],
    };
    const schema = toolWith(raw);
    const fixed = withExplicitRequired(schema).parameters as {
      properties: Record<string, any>;
    };
    const leaves: unknown[] = [
      fixed.properties.list.items,
      fixed.properties.tuple.prefixItems?.[0],
      fixed.properties.map.additionalProperties,
      fixed.properties.branch.anyOf?.[0],
      fixed.properties.branch.allOf?.[0],
    ];
    for (const leaf of leaves) {
      expect(leaf).toMatchObject({ type: "object", required: [] });
    }
    expect(fixed).toMatchObject({ required: ["list"] });
  });

  it("leaves an existing nested empty required list untouched", () => {
    const raw = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    };
    const fixed = withExplicitRequired(toolWith(raw)).parameters;
    expect((fixed as any).properties.options).toMatchObject({ required: [] });
  });
});
