import { afterEach, describe, expect, it, vi } from "vitest";
import { systemTranscriptCheckpoint } from "./system-transcript.js";
import { readSystemMessage } from "./system-transcript-journal.js";
import type { UiMessage } from "@pi-desktop/shared";
import { flashProvider, pluginTools, wireFixture, runtimeFixture, type Payload } from "./test-helpers/fixed-tool-fixture.js";

afterEach(() => vi.unstubAllGlobals());
describe("fixed Flash declarations through runtime and HTTP/SSE", () => {
  it("rejects a declared but inactive tool without invoking Host", async () => {
    const wire = await wireFixture([{ name: "plugin_beta" }]);
    const f = runtimeFixture();
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual([]);
      expect(f.rows.find((row) => row.toolName === "plugin_beta")).toMatchObject({ isError: true });
      expect(JSON.stringify(wire.requests[1].messages)).toContain("Call ToolSearch to activate plugin_beta");
      expect(wire.requests[1].tools).toEqual(wire.requests[0].tools);
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each([false, true])("restores only activated tools after restart (checkpoint=%s)", async (checkpoint) => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    let declared: Payload["tools"];
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      declared = wire.requests.at(-1)!.tools;
      history = structuredClone(f.rows);
      if (checkpoint) {
        const system = systemTranscriptCheckpoint(history.filter((row) => row.modelSystem)
          .map((row) => readSystemMessage(row.modelSystem!.messageJson)))!;
        history = [{ id: "checkpoint", role: "system", content: "", createdAt: new Date().toISOString(),
          modelSystem: { version: 1, messageJson: JSON.stringify(system) } }];
      }
    } finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("restored-user");
      expect(restored.errors).toEqual([]);
      expect(restored.executed).toEqual(["plugin_alpha"]);
      expect(resumed.requests[0].tools).toEqual(declared!);
      expect([...restored.rows].reverse().find((row) => row.toolName === "plugin_beta")).toMatchObject({ isError: true });
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it.each(["schema", "removed", "route"])("does not revive activation after a %s change", async (change) => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    try { await f.prompt(); history = structuredClone(f.rows); }
    finally { await f.runtime.dispose(); await wire.close(); }
    const tools = change === "removed" ? pluginTools.slice(1) : change === "schema"
      ? [{ ...pluginTools[0], description: "Changed schema epoch" }, pluginTools[1]] : pluginTools;
    const provider = change === "route" ? { ...flashProvider(), baseUrl: "https://relay.invalid/v1" } : flashProvider();
    const resumed = await wireFixture([{ name: "plugin_alpha" }]);
    const restored = runtimeFixture(history!, tools, provider);
    try {
      await restored.prompt("changed-user");
      expect(restored.errors).toEqual([]);
      expect(restored.executed).toEqual([]);
      if (change === "removed") expect(resumed.requests[0].tools.map((tool) => tool.function.name)).not.toContain("plugin_alpha");
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("still requires Host approval after ToolSearch activation", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }, { name: "plugin_alpha" }]);
    const f = runtimeFixture([], pluginTools, flashProvider(), true);
    try {
      await f.prompt();
      expect(f.executed).toEqual(["plugin_alpha"]);
      expect(f.rows.find((row) => row.toolName === "plugin_alpha")).toMatchObject({ isError: true });
      expect(JSON.stringify(wire.requests.at(-1)?.messages)).toContain("Permission denied");
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it("replays a successful activation if stopped before its next declaration checkpoint", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture();
    let history: UiMessage[];
    try {
      await f.prompt();
      const first = f.rows.find((row) => row.modelSystem)!;
      history = structuredClone(f.rows.filter((row) => !row.modelSystem || row === first));
    } finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("resumed-user");
      expect(restored.executed).toEqual(["plugin_alpha"]);
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("migrates legacy on-demand history without granting the rest of the catalog", async () => {
    const wire = await wireFixture([{ name: "ToolSearch", args: { query: "plugin_alpha" } }]);
    const f = runtimeFixture([], pluginTools, { ...flashProvider(), baseUrl: "https://relay.invalid" });
    let history: UiMessage[];
    try { await f.prompt(); history = structuredClone(f.rows).map((row) => {
      if (!row.modelSystem) return row;
      const state = readSystemMessage(row.modelSystem.messageJson);
      delete state.sections?.tool_activation;
      if (state.toolsAdded) state.toolsAdded = state.toolsAdded.filter((tool) => tool.name !== "plugin_beta");
      return { ...row, modelSystem: { ...row.modelSystem, messageJson: JSON.stringify(state) } };
    }); }
    finally { await f.runtime.dispose(); await wire.close(); }
    const resumed = await wireFixture([{ name: "plugin_alpha" }, { name: "plugin_beta" }]);
    const restored = runtimeFixture(history!);
    try {
      await restored.prompt("migrated-user");
      expect(restored.executed).toEqual(["plugin_alpha"]);
      expect(resumed.requests[0].tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["plugin_alpha", "plugin_beta"]));
    } finally { await restored.runtime.dispose(); await resumed.close(); }
  });

  it("retains the Plan execution guard for predeclared tools", async () => {
    const wire = await wireFixture([{ name: "Write", args: { path: "fixture", content: "denied" } }]);
    const f = runtimeFixture();
    try {
      f.runtime.setMode("plan");
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual([]);
      expect(f.rows.find((row) => row.toolName === "Write")).toMatchObject({ isError: true });
    } finally { await f.runtime.dispose(); await wire.close(); }
  });

  it.each([
    { name: "official Flash", provider: flashProvider() },
    { name: "unflagged Chat Completions", provider: { ...flashProvider(), modelId: "fixture-chat", modelConfig: undefined } },
    { name: "compatible relay", provider: { ...flashProvider(), baseUrl: "https://relay.invalid/v1" } },
  ])("keeps the complete request prefix for $name while searching and executing two different tools", async ({ provider }) => {
    const wire = await wireFixture([
      { name: "ToolSearch", args: { query: "plugin_alpha" } }, { name: "plugin_alpha" },
      { name: "ToolSearch", args: { query: "plugin_beta" } }, { name: "plugin_beta" },
    ]);
    const f = runtimeFixture([], pluginTools, provider);
    try {
      await f.prompt();
      expect(f.errors).toEqual([]);
      expect(f.executed).toEqual(["plugin_alpha", "plugin_beta"]);
      expect(wire.requests).toHaveLength(5);
      expect(wire.requests[0].tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["plugin_alpha", "plugin_beta"]));
      for (let index = 1; index < wire.requests.length; index++) {
        expect(wire.requests[index].tools).toEqual(wire.requests[0].tools);
        const previous = wire.requests[index - 1].messages;
        expect(wire.requests[index].messages.slice(0, previous.length)).toEqual(previous);
      }
    } finally { await f.runtime.dispose(); await wire.close(); }
  });
});
