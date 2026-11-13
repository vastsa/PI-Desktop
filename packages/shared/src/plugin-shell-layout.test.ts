import { describe, expect, it } from "vitest";
import { isPluginShellLayoutCommand, isPluginShellLayoutSnapshot, isPluginShellLayoutResponse } from "./plugin-shell-layout.js";

const layout = {
  sidebar: { collapsed: false, width: 240, minWidth: 180, maxWidth: 400 },
  workPanel: { visible: false, width: 320, minWidth: 244, tabs: [{ id: "file:a", kind: "file", label: "a", resource: "a" }], activeTabId: "file:a" },
};
describe("plugin shell layout boundaries", () => {
  it("accepts optional finite widths and exact booleans", () => {
    for (const input of [{}, { width: -1 }, { collapsed: true, width: 0 }]) expect(isPluginShellLayoutCommand({ kind: "setSidebar", input })).toBe(true);
    expect(isPluginShellLayoutCommand({ kind: "setWorkPanel", input: { visible: true, width: 2000 } })).toBe(true);
    expect(isPluginShellLayoutCommand({ kind: "activateTab", tabId: "file:a" })).toBe(true);
    expect(isPluginShellLayoutCommand({ kind: "activateTab", tabId: "" })).toBe(true);
  });
  it("rejects malformed untrusted mutation arguments", () => {
    for (const input of [null, [], "x", { width: NaN }, { width: Infinity }, { width: "200" }, { collapsed: 1 }, { visible: true }]) expect(isPluginShellLayoutCommand({ kind: "setSidebar", input })).toBe(false);
    for (const tabId of [null, 4, []]) expect(isPluginShellLayoutCommand({ kind: "activateTab", tabId })).toBe(false);
  });
  it("validates transport identity, revisions, public geometry and serializable tabs", () => {
    const snapshot = { bootId: "boot", revision: 1, contextId: "context", sessionId: null, projectPath: null, layout };
    expect(isPluginShellLayoutSnapshot(snapshot)).toBe(true);
    for (const patch of [{ revision: NaN }, { revision: -1 }, { contextId: "" }, { layout: { ...layout, workPanel: { ...layout.workPanel, width: Infinity } } }]) expect(isPluginShellLayoutSnapshot({ ...snapshot, ...patch })).toBe(false);
    expect(isPluginShellLayoutResponse({ requestId: "r", snapshot })).toBe(true);
    expect(isPluginShellLayoutResponse({ requestId: "r", error: { code: "UNAVAILABLE", message: "renderer gone" } })).toBe(true);
    expect(isPluginShellLayoutResponse({ requestId: "r", snapshot, error: { code: "UNAVAILABLE", message: "gone" } })).toBe(false);
  });
});
