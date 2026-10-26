import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";
const sidecars: AgentSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map(s => s.dispose())); });
function sidecar() {
  const source = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    const pending = new Map();
    rl.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'probe') {
        const id = 'reverse-' + message.id;
        pending.set(id,message.id);
        console.log(JSON.stringify({id,method:'host.proxy',params:message.params}));
      } else if (pending.has(message.id)) {
        console.log(JSON.stringify({id:pending.get(message.id),...(message.error ? {error:message.error} : {result:message.result})}));
        pending.delete(message.id);
      }
    });`;
  const s = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => undefined });
  // A real external host boundary, which must never receive inference or arbitrary secret calls.
  s.setHost({ call: async () => { throw new Error("Must not forward inference to host-core"); }, onExit: () => () => undefined, onNotification: () => () => undefined });
  sidecars.push(s);
  return s;
}
it("authorizes only registered session/provider/model tuples at the real reverse-RPC boundary", async () => {
  const s = sidecar();
  const call = vi.fn(async (_params: Record<string, unknown>, binding: unknown) => binding);
  const clear = vi.fn();
  s.setProviderInferenceHandler({ call, clear });
  const binding = { providerId: "plugin:demo.provider:gateway", modelId: "chat", adapter: { runtimeId: "generation-1" } };
  s.setProviderInferenceBindings("session", [binding]);
  const probe = (params: unknown) => s.call("probe", { method: "provider.inference", params });
  const params = { sessionId: "session", providerId: binding.providerId, modelId: "chat", operation: "open" };
  expect(await probe(params)).toEqual(binding);
  for (const change of [{ sessionId: "peer" }, { providerId: "peer" }, { modelId: "image-only" }]) {
    await expect(probe({ ...params, ...change })).rejects.toThrow("not bound");
  }
  expect(call).toHaveBeenCalledOnce();
  await expect(s.call("probe", { method: "secrets.getForRuntime", params: {} })).rejects.toThrow();
  s.clearVendorAuthBindings("session");
  expect(clear).toHaveBeenCalledWith("session");
  await expect(probe(params)).rejects.toThrow("not bound");
});
it("rejects late results after rebind and clears resources on disposal", async () => {
  const s = sidecar();
  let resolve: ((value: unknown) => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(r => { entered = r; });
  const clear = vi.fn();
  s.setProviderInferenceHandler({ clear, call: () => { entered?.(); return new Promise(r => { resolve = r; }); } });
  const binding = { providerId: "provider", modelId: "model", adapter: {} };
  s.setProviderInferenceBindings("session", [binding]);
  const pending = s.call("probe", { method: "provider.inference", params: { sessionId: "session", providerId: "provider", modelId: "model", operation: "next" } });
  await started;
  s.setProviderInferenceBindings("session", [binding]);
  resolve?.({ type: "text", delta: "late" });
  await expect(pending).rejects.toThrow("binding changed");
  await s.dispose();
  expect(clear).toHaveBeenCalledWith();
});
it("on-demand delegate grants are installed only in the session generation that requested them", async () => {
  const s = sidecar();
  const handler = { call: vi.fn(async (_params: Record<string, unknown>, binding: unknown) => binding), clear: vi.fn() };
  s.setProviderInferenceHandler(handler);
  s.setProviderInferenceBindings("session", []);
  const provider = { id: "plugin:fixture.provider:gateway", modelId: "delegate", pluginInference: { runtimeId: "one" } };
  s.setSubagentModelResolver(async () => provider);
  const probe = (method: string, params: unknown) => s.call("probe", { method, params });
  expect(await probe("provider.resolveSubagentModel", { key: "fixture/delegate", sessionId: "session" })).toEqual(provider);
  expect(await probe("provider.inference", { sessionId: "session", providerId: provider.id, modelId: provider.modelId, operation: "open" }))
    .toEqual({ providerId: provider.id, modelId: provider.modelId, adapter: provider.pluginInference });
  let settle: ((value: unknown) => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  s.setSubagentModelResolver(() => { entered?.(); return new Promise(resolve => { settle = resolve; }); });
  const pending = probe("provider.resolveSubagentModel", { key: "fixture/delegate", sessionId: "session" });
  await started;
  s.setProviderInferenceBindings("session", []);
  settle?.(provider);
  await expect(pending).rejects.toThrow("binding changed");
  await expect(probe("provider.inference", { sessionId: "session", providerId: provider.id, modelId: provider.modelId, operation: "open" })).rejects.toThrow("not bound");
});

it("revokes one account and rejects its late result without revoking another account", async () => {
  const s = sidecar();
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  const invalidateProvider = vi.fn();
  s.setProviderInferenceHandler({ clear: vi.fn(), invalidateProvider, call: async (params, binding) => {
    if (params.providerId === "account-a") { entered.resolve(); return result.promise; }
    return binding;
  } });
  const a = { providerId: "account-a", modelId: "chat", adapter: {} };
  const b = { providerId: "account-b", modelId: "chat", adapter: {} };
  s.setProviderInferenceBindings("session", [a, b]);
  const probe = (providerId: string) => s.call("probe", { method: "provider.inference", params: { sessionId: "session", providerId, modelId: "chat", operation: "next" } });
  const pending = probe(a.providerId);
  await entered.promise;
  s.invalidateProviderInference(a.providerId);
  result.resolve({ type: "text", delta: "late" });
  await expect(pending).rejects.toThrow("binding changed");
  await expect(probe(a.providerId)).rejects.toThrow("not bound");
  expect(await probe(b.providerId)).toEqual(b);
  expect(invalidateProvider).toHaveBeenCalledWith(a.providerId);
});
