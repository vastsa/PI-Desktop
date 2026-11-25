import { describe, expect, it } from "vitest";
import type { MessageUsage } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { createRuntimeModelHost } from "./runtime-models.js";

const provider: RuntimeProviderConfig = {
  id: "account-7", name: "Relay", baseUrl: "https://relay.invalid/v1", modelId: "relay-model", apiKey: "sk-secret-value",
  apiStyle: "responses", headers: { "x-team-token": "header-secret" }, supportsReasoning: false, supportedThinkingLevels: ["off"],
  modelConfig: { source: "generic", name: "Relay model", baseUrl: "https://relay.invalid/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4000 },
};

describe("codemode runtime model host", () => {
  it("lists only allowlisted metadata", () => {
    const host = createRuntimeModelHost({ provider: () => provider, sessionId: "s", jevApiKey: "jev-key", emitUsage: () => undefined });
    const listed = host.list();
    expect(listed).toEqual([
      { kind: "chat", providerId: "account-7", id: "relay-model", name: "Relay model", contextWindow: 64000, maxTokens: 4000, reasoning: false, input: ["text"] },
      expect.objectContaining({ kind: "classifier", providerId: "typesafe", id: "jev-latest" }),
    ]);
    const serialized = JSON.stringify(listed);
    for (const secret of ["sk-secret-value", "header-secret", "jev-key", "relay.invalid"]) expect(serialized).not.toContain(secret);
  });

  it("omits classify without a Jev credential", () => {
    const host = createRuntimeModelHost({ provider: () => provider, sessionId: "s", emitUsage: () => undefined });
    expect(host.classify).toBeUndefined();
    expect(host.list().map((model) => model.kind)).toEqual(["chat"]);
  });

  it("dispatches completions on the session binding and forwards per-attempt usage", async () => {
    const usage: MessageUsage[] = [];
    const calls: unknown[] = [];
    const host = createRuntimeModelHost({
      provider: () => provider, sessionId: "session-9", emitUsage: (entry) => { usage.push(entry); },
      complete: async (bound, context, thinking, options) => {
        calls.push({ id: bound.id, context, thinking, max: options?.maxOutputTokens, session: options?.sessionId });
        options?.onUsage?.({ operationId: "op-1", providerId: bound.id, modelId: bound.modelId, inputTokens: 3, outputTokens: 2, totalTokens: 5 });
        return { text: "done" };
      },
    });
    await expect(host.complete!({ prompt: "hi", system: "be brief", maxOutputTokens: 50 }, new AbortController().signal))
      .resolves.toEqual({ text: "done" });
    expect(calls).toEqual([{ id: "account-7", thinking: "off", max: 50, session: "session-9",
      context: { systemPrompt: "be brief", messages: [expect.objectContaining({ role: "user", content: "hi" })] } }]);
    expect(usage).toEqual([expect.objectContaining({ operationId: "op-1", providerId: "account-7", modelId: "relay-model" })]);
  });

  it("attributes late usage to the turn that started the call", async () => {
    let turn = "turn-1";
    const recorded: Array<string | undefined> = [];
    let finish!: () => void;
    const host = createRuntimeModelHost({
      provider: () => provider, sessionId: "s", turnId: () => turn,
      emitUsage: (_usage, turnId) => recorded.push(turnId),
      complete: async (_bound, _context, _thinking, options) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        options?.onUsage?.({ operationId: "late", inputTokens: 1, outputTokens: 1, totalTokens: 2 });
        return { text: "late" };
      },
    });
    const pending = host.complete!({ prompt: "hi", maxOutputTokens: 1 }, new AbortController().signal);
    turn = "turn-2";
    finish();
    await pending;
    expect(recorded).toEqual(["turn-1"]);
  });

  it("offers no completion while a trusted extension agent owns the session", async () => {
    let called = false;
    const extension = { ...provider, extensionAgentKey: "ext:agent" };
    const host = createRuntimeModelHost({
      provider: () => extension, sessionId: "s", emitUsage: () => undefined,
      complete: async () => { called = true; return { text: "" }; },
    });
    expect(host.list()).toEqual([]);
    await expect(host.complete!({ prompt: "hi", maxOutputTokens: 1 }, new AbortController().signal))
      .rejects.toThrow("trusted extension agent");
    expect(called).toBe(false);
  });

  it("redacts the session credential from completion errors", async () => {
    const host = createRuntimeModelHost({
      provider: () => provider, sessionId: "s", emitUsage: () => undefined,
      complete: async () => { throw new Error("401 for key sk-secret-value"); },
    });
    await expect(host.complete!({ prompt: "hi", maxOutputTokens: 1 }, new AbortController().signal))
      .rejects.toThrow("401 for key [redacted]");
  });

  it("records each classification as its own identified operation", async () => {
    const usage: MessageUsage[] = [];
    const retries: Array<number | undefined> = [];
    let attempt = 0;
    const host = createRuntimeModelHost({
      provider: () => provider, sessionId: "s", jevApiKey: "jev-key", emitUsage: (entry) => { usage.push(entry); },
      classify: async (_key, _params, _signal, options) => {
        retries.push(options?.maxRetries);
        attempt += 1;
        const reported = { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
          cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } };
        return attempt === 1
          ? { ok: true, answers: {}, usage: reported }
          : { ok: false, errorCode: "JEV_REQUEST_FAILED", message: "Jev classification failed: busy", usage: reported };
      },
    });
    const signal = new AbortController().signal;
    await host.classify!({}, signal);
    await host.classify!({}, signal);
    // One attempt per call; a failed request that reported usage is still recorded.
    expect(retries).toEqual([0, 0]);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ providerId: "typesafe", modelId: "jev-latest", inputTokens: 7, outputTokens: 1, costStatus: "estimated" });
    expect(usage[0].operationId).toBeTruthy();
    expect(usage[0].operationId).not.toBe(usage[1].operationId);
  });
});
