import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentExtensionBridge } = await import("../electron/main/agent-extensions.ts");
const { TrustedExtensionRunner, clearTrustedExtensionCache } = await import("../../../packages/agent-runtime/src/extensions/runner.ts");
const { requestExtensionUi } = await import("../../../packages/agent-runtime/src/extensions/ui-request.ts");

test("Main cancellation crosses the real UI bridge and retires only the old command", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ext-cancel-path-"));
  const entry = join(root, "fixture.ts");
  writeFileSync(entry, `export default function(pi) {
    pi.registerCommand("old", { handler: async (_args, ctx) => {
      try { await ctx.ui.input("Old prompt"); } catch {}
      await ctx.ui.select("Stale followup", ["x"]);
      pi.sendUserMessage("stale");
    }});
    pi.registerCommand("fresh", { handler: async (_args, ctx) => {
      if (await ctx.ui.confirm("New prompt", "Continue?")) await pi.sendUserMessage("fresh");
    }});
  }`);
  const prompts = [];
  const messages = [];
  let shown;
  let ready = new Promise((resolve) => { shown = resolve; });
  const broker = new AgentExtensionBridge({
    hasRenderer: () => true, onChanged() {}, onToast() {}, onStatus() {},
    onPrompt(prompt) { prompts.push(prompt); if (!prompt.cancelled) shown(prompt); },
  });
  const runner = new TrustedExtensionRunner({
    specs: [{ id: entry, entry, label: "Fixture", root, source: "plugin" }],
    bridge: {
      sessionId: "session", cwd: root,
      getModel: () => ({}), setModel: async () => false,
      getThinkingLevel: () => "off", setThinkingLevel() {},
      isIdle: () => true, abort() {}, hasPendingMessages: () => false,
      getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "",
      getActiveTools: () => [], getAllTools: () => [], setActiveTools() {},
      getSessionName: () => "fixture", setSessionName() {},
      sendUserMessage: (text) => messages.push(text), waitForIdle: async () => {},
      newSession: async () => ({ cancelled: false }), fork: async () => ({ cancelled: false }),
      requestUi: (extension, request, signal) => requestExtensionUi(
        (envelope) => broker.requestUi(envelope),
        { sessionId: "session", extensionId: extension.id, extensionLabel: extension.label, request }, signal),
      publishCommands() {}, publishDiagnostics() {},
    },
  });
  try {
    await runner.load();
    const old = runner.runCommand("old", "");
    const oldPrompt = await ready;
    broker.cancelPrompts("session");
    await old;
    assert.equal(prompts.filter((prompt) => !prompt.cancelled).length, 1);
    assert.deepEqual(messages, []);
    assert.equal(prompts.at(-1).cancelled, true);
    ready = new Promise((resolve) => { shown = resolve; });
    const fresh = runner.runCommand("fresh", "");
    const freshPrompt = await ready;
    assert.equal(broker.respond(oldPrompt.promptId, true), false);
    assert.equal(broker.respond(freshPrompt.promptId, true), true);
    await fresh;
    assert.deepEqual(messages, ["fresh"]);
    assert.equal(broker.pendingPromptCount(), 0);
  } finally {
    broker.cancelPrompts("session");
    await runner.dispose();
    clearTrustedExtensionCache();
    rmSync(root, { recursive: true, force: true });
  }
});
