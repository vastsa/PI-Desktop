import { describe, expect, it, vi } from "vitest";
import { validateManifest } from "./index.js";
import { validateProviderChatEvent, validateProviderImageResult, validateProviderRequestData, inferenceJsonBytes, PLUGIN_INFERENCE_LIMITS } from "./provider-adapter.js";
import { PluginProviderInferenceHost } from "./provider-inference-host.js";
const request = { version: 1 as const, providerId: "gateway", modelId: "chat", messages: [] };
const declaration = [{ id: "gateway", adapter: { version: 1 as const, chat: true } }];

describe("isolated provider inference contract", () => {
  it("requires a separate inference grant and rejects unsupported versions/capabilities", () => {
    const manifest = { schemaVersion: 1, id: "demo.provider", name: "Demo", version: "1.0.0", main: "main.js",
      permissions: ["provider.register"], contributes: { providers: [{ id: "gateway", name: "Gateway", models: [{ id: "chat" }], adapter: { version: 1, chat: true } }] } };
    expect(validateManifest(manifest)).toMatchObject({ ok: false, error: expect.stringContaining("provider.inference") });
    manifest.permissions.push("provider.inference");
    expect(validateManifest(manifest).ok).toBe(true);
    manifest.contributes.providers[0]!.adapter.version = 2;
    expect(validateManifest(manifest).ok).toBe(false);
  });
  it("validates JSON, completed tool arguments, usage, image bytes/MIME and bounds", () => {
    for (const value of [() => 1, { x: undefined }, { x: NaN }, new Date()]) {
      expect(() => inferenceJsonBytes(value, 1000)).toThrow();
    }
    expect(() => validateProviderChatEvent({ type: "toolCall", id: "one", name: "Read", arguments: "{}" })).toThrow();
    expect(() => validateProviderChatEvent({ type: "done", stopReason: "stop", usage: { input: -1, output: 1 } })).toThrow();
    expect(() => validateProviderChatEvent({ type: "text", delta: "x".repeat(PLUGIN_INFERENCE_LIMITS.eventBytes) })).toThrow();
    expect(() => validateProviderImageResult({ images: [{ type: "image", data: "https://example.test/image", mimeType: "image/png" }] })).toThrow();
    expect(() => validateProviderImageResult({ images: [{ type: "image", data: "bm90LWEtcG5n", mimeType: "image/png" }] })).toThrow();
  });
  it("bounds routing metadata to a JSON object of at most 16 KiB in UTF-8", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ projectId: "" })).byteLength;
    const exact = { projectId: "x".repeat(16 * 1024 - overhead) };
    expect(() => validateProviderRequestData(exact)).not.toThrow();
    expect(() => validateProviderRequestData({ projectId: `${exact.projectId}x` })).toThrow();
    for (const value of [null, [], "project", { projectId: "界".repeat(6000) }, { value: undefined }, { value: Infinity }]) {
      expect(() => validateProviderRequestData(value)).toThrow();
    }
    expect(() => validateProviderRequestData({})).not.toThrow();
  });
  it("close aborts a hung next before iterator.return and rejects late completion", async () => {
    let resolveNext: ((result: IteratorResult<{ type: "text"; delta: string }>) => void) | undefined;
    let signal: AbortSignal | undefined;
    const returned = vi.fn(() => { expect(signal?.aborted).toBe(true); return Promise.resolve({ done: true as const, value: undefined }); });
    const host = new PluginProviderInferenceHost({ gateway: { version: 1, chat: (_request, context) => {
      signal = context.signal;
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { resolveNext = resolve; }), return: returned }) };
    } } }, declaration, error => { throw error; });
    await host.open("host-assigned", request);
    const next = host.next("host-assigned");
    host.close("host-assigned");
    await expect(next).rejects.toThrow("closed");
    resolveNext?.({ done: false, value: { type: "text", delta: "late" } });
    expect(returned).toHaveBeenCalledOnce();
    await expect(host.next("host-assigned")).rejects.toThrow("unavailable");
  });
  it("returns an iterator created after its opening invocation was cancelled", async () => {
    let finish: ((value: AsyncIterable<{ type: "text"; delta: string }>) => void) | undefined;
    const factory = new Promise<AsyncIterable<{ type: "text"; delta: string }>>(resolve => { finish = resolve; });
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const host = new PluginProviderInferenceHost({ gateway: { version: 1, chat: () => factory } }, declaration, error => { throw error; });
    const opening = host.open("cancelled-open", request);
    host.close("cancelled-open");
    await expect(opening).rejects.toThrow("closed");
    finish?.({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { type: "text", delta: "late" } }), return: returned }) });
    await factory;
    await Promise.resolve();
    expect(returned).toHaveBeenCalledOnce();
    await expect(host.next("cancelled-open")).rejects.toThrow("unavailable");
  });
  it("disposal invalidates all invocations and malformed output cannot cross the boundary", async () => {
    const host = new PluginProviderInferenceHost({ gateway: { version: 1, chat: async function* () {
      yield { type: "text", delta: "valid" };
      throw new Error("observable adapter failure");
    } } }, declaration, error => { throw error; });
    await host.open("first", request);
    expect(await host.next("first")).toEqual({ type: "text", delta: "valid" });
    await expect(host.next("first")).rejects.toThrow("observable adapter failure");
    await host.open("second", request);
    host.dispose();
    await expect(host.next("second")).rejects.toThrow("unavailable");
  });
  it("enforces pull capacity and timeout without extra generation attempts", async () => {
    vi.useFakeTimers();
    const host = new PluginProviderInferenceHost({ gateway: { version: 1, chat: async function* () {
      await new Promise(() => undefined);
      yield { type: "text", delta: "never" };
    } } }, declaration, () => undefined);
    try {
      for (let i = 0; i < PLUGIN_INFERENCE_LIMITS.capacity; i++) await host.open(String(i), request);
      await expect(host.open("overflow", request)).rejects.toThrow("capacity");
      const pending = host.next("0");
      const rejected = expect(pending).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(PLUGIN_INFERENCE_LIMITS.callTimeoutMs);
      await rejected;
    } finally { host.dispose(); vi.useRealTimers(); }
  });
});
