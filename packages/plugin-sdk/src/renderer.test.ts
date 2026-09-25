import { describe, expect, it } from "vitest";
import {
  PLUGIN_RENDERER_ACTIONS,
  PLUGIN_RENDERER_SLOTS,
  blockRendererLanguageKey,
  slotRegistrationRefusal,
} from "./renderer.js";

const PLUGIN = "demo.lab";
const component = () => null;

function codeOf(registration: unknown, ownTools: readonly string[] = []) {
  return slotRegistrationRefusal(PLUGIN, registration, ownTools)?.code ?? null;
}

describe("renderer vocabulary", () => {
  it("names every slot the host mounts and only implemented actions", () => {
    expect(PLUGIN_RENDERER_SLOTS).toEqual([
      "userAction",
      "assistantAction",
      "entryExtra",
      "toolCard",
      "blockRenderer",
      "composerControl",
    ]);
    expect(PLUGIN_RENDERER_ACTIONS).toEqual(["plugin.call", "composer.insertText"]);
  });
});

describe("slotRegistrationRefusal", () => {
  it("accepts a well-formed registration for every slot", () => {
    expect(codeOf({ slot: "entryExtra", component })).toBeNull();
    expect(codeOf({ slot: "userAction", component })).toBeNull();
    expect(codeOf({ slot: "assistantAction", component, positions: ["left"] })).toBeNull();
    expect(codeOf({ slot: "composerControl", component, positions: ["left", "right"] })).toBeNull();
    expect(codeOf({ slot: "toolCard", toolName: "query_db", component }, ["query_db"])).toBeNull();
    expect(codeOf({ slot: "blockRenderer", language: "demo.lab:chart", component })).toBeNull();
  });

  it("refuses a slot outside the vocabulary", () => {
    expect(codeOf(undefined)).toBe("PLUGIN_SLOT_UNKNOWN");
    expect(codeOf("entryExtra")).toBe("PLUGIN_SLOT_UNKNOWN");
    expect(codeOf({ component })).toBe("PLUGIN_SLOT_UNKNOWN");
    expect(codeOf({ slot: "composerToken", component })).toBe("PLUGIN_SLOT_UNKNOWN");
    expect(codeOf({ slot: "composerTrigger", component })).toBe("PLUGIN_SLOT_UNKNOWN");
  });

  it("requires a function component", () => {
    expect(codeOf({ slot: "entryExtra" })).toBe("PLUGIN_SLOT_INVALID_COMPONENT");
    expect(codeOf({ slot: "entryExtra", component: "<div/>" })).toBe(
      "PLUGIN_SLOT_INVALID_COMPONENT",
    );
    expect(codeOf({ slot: "entryExtra", component: { render: component } })).toBe(
      "PLUGIN_SLOT_INVALID_COMPONENT",
    );
  });

  it("takes positions only on sided slots, as a non-empty left/right list", () => {
    expect(codeOf({ slot: "entryExtra", component, positions: ["left"] })).toBe(
      "PLUGIN_SLOT_INVALID_POSITION",
    );
    expect(
      codeOf({ slot: "toolCard", toolName: "query_db", component, positions: ["left"] }, [
        "query_db",
      ]),
    ).toBe("PLUGIN_SLOT_INVALID_POSITION");
    expect(codeOf({ slot: "userAction", component, positions: [] })).toBe(
      "PLUGIN_SLOT_INVALID_POSITION",
    );
    expect(codeOf({ slot: "userAction", component, positions: "left" })).toBe(
      "PLUGIN_SLOT_INVALID_POSITION",
    );
    expect(codeOf({ slot: "composerControl", component, positions: ["top"] })).toBe(
      "PLUGIN_SLOT_INVALID_POSITION",
    );
    // Repeating a side is harmless; the host keeps one mount per side.
    expect(codeOf({ slot: "userAction", component, positions: ["left", "left"] })).toBeNull();
  });

  it("keys a tool card on one of the plugin's own agent tools", () => {
    expect(codeOf({ slot: "toolCard", component }, ["query_db"])).toBe("PLUGIN_SLOT_INVALID_KEY");
    expect(codeOf({ slot: "toolCard", toolName: " ", component }, ["query_db"])).toBe(
      "PLUGIN_SLOT_INVALID_KEY",
    );
    expect(codeOf({ slot: "toolCard", toolName: "query_db", component }, [])).toBe(
      "PLUGIN_SLOT_NOT_OWNED",
    );
    // The bare name is the key; the qualified agent-facing name is not.
    expect(
      codeOf({ slot: "toolCard", toolName: "plugin_demo_lab_query_db", component }, ["query_db"]),
    ).toBe("PLUGIN_SLOT_NOT_OWNED");
  });

  it("keys a block renderer on the plugin's own language namespace", () => {
    expect(codeOf({ slot: "blockRenderer", component })).toBe("PLUGIN_SLOT_INVALID_KEY");
    expect(codeOf({ slot: "blockRenderer", language: "chart", component })).toBe(
      "PLUGIN_SLOT_INVALID_KEY",
    );
    expect(codeOf({ slot: "blockRenderer", language: "other.plugin:chart", component })).toBe(
      "PLUGIN_SLOT_INVALID_KEY",
    );
    expect(codeOf({ slot: "blockRenderer", language: "demo.lab:", component })).toBe(
      "PLUGIN_SLOT_INVALID_KEY",
    );
    expect(codeOf({ slot: "blockRenderer", language: "demo.lab:a b", component })).toBe(
      "PLUGIN_SLOT_INVALID_KEY",
    );
    // Tags compare case-insensitively and ignore surrounding space.
    expect(codeOf({ slot: "blockRenderer", language: " Demo.Lab:Chart_2 ", component })).toBeNull();
  });
});

describe("blockRendererLanguageKey", () => {
  it("normalizes a tag the same way on both sides of the lookup", () => {
    expect(blockRendererLanguageKey(" Demo.Lab:Chart ")).toBe("demo.lab:chart");
    expect(blockRendererLanguageKey("demo.lab:chart")).toBe("demo.lab:chart");
  });
});
