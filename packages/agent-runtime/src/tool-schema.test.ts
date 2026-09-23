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

  it("ignores schemas that are not object-shaped", () => {
    const union = toolWith({ anyOf: [{ type: "object" }] });
    expect(withExplicitRequired(union)).toBe(union);
  });
});
