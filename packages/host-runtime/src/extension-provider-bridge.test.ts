import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

/**
 * A real stdio child that forwards a requested call over the production reverse
 * `host.proxy` RPC, so the test drives `AgentSidecar.onLine` end to end instead
 * of calling the dispatch path directly.
 */
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;

const sidecars: AgentSidecar[] = [];

afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

function harness() {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  // host-core must never be reached for the `extensions.*` surface.
  const host: SidecarHostLink = {
    call: async () => {
      throw new Error("host-core must not be reached");
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  const probe = (method: string, params: Record<string, unknown> = {}) =>
    sidecar.call("probe", { method, params });
  return { sidecar, probe };
}

it("routes extensions.providers.list to the bridge handler without falling through to requestUi", async () => {
  const { sidecar, probe } = harness();
  const listProviderModels = vi
    .fn()
    .mockResolvedValue({ models: [{ providerId: "p", modelId: "m" }] });
  const requestUi = vi.fn().mockResolvedValue({ kind: "confirm" });
  const requestProvider = vi.fn().mockResolvedValue({ status: 200, ok: true });
  const abortProviderRequest = vi.fn().mockReturnValue({ ok: true });
  sidecar.setTrustedExtensionBridge({
    publishCommands: () => {},
    publishDiagnostics: () => {},
    requestUi,
    configureModel: async () => ({ ok: true }),
    queuePush: async () => ({ ok: true }),
    queuePrioritize: async () => ({ ok: true }),
    listProviderModels,
    requestProvider,
    abortProviderRequest,
  });

  await expect(
    probe("extensions.providers.list", { sessionId: "session-one" }),
  ).resolves.toEqual({ models: [{ providerId: "p", modelId: "m" }] });
  expect(listProviderModels).toHaveBeenCalledWith({ sessionId: "session-one" });
  // The explicit dispatch case must win over the `requestUi` fallthrough.
  expect(requestUi).not.toHaveBeenCalled();
});

it("refuses a host-proxy method outside HOST_PROXY_ALLOWED", async () => {
  const { probe } = harness();
  // `providers.delete` has no allowlist entry: a method the sidecar may not
  // reach must be refused, and the S2 request surface being allowed must not
  // widen anything else.
  await expect(
    probe("providers.delete", { id: "provider-one" }),
  ).rejects.toMatchObject({ code: -32601 });
});

it("routes extensions.providers.request and .abort to the bridge handlers", async () => {
  const { sidecar, probe } = harness();
  const requestProvider = vi
    .fn()
    .mockResolvedValue({ status: 302, ok: false, location: "/elsewhere" });
  const abortProviderRequest = vi.fn().mockReturnValue({ ok: true });
  const requestUi = vi.fn().mockResolvedValue({ kind: "confirm" });
  sidecar.setTrustedExtensionBridge({
    publishCommands: () => {},
    publishDiagnostics: () => {},
    requestUi,
    configureModel: async () => ({ ok: true }),
    queuePush: async () => ({ ok: true }),
    queuePrioritize: async () => ({ ok: true }),
    listProviderModels: async () => ({ models: [] }),
    requestProvider,
    abortProviderRequest,
  });

  const params = {
    sessionId: "session-one",
    extensionId: "ext-one",
    callId: "call-one",
    providerId: "provider-one",
    path: "/models",
  };
  await expect(probe("extensions.providers.request", params)).resolves.toEqual({
    status: 302,
    ok: false,
    location: "/elsewhere",
  });
  expect(requestProvider).toHaveBeenCalledWith(params);
  // The abort side channel is answered synchronously and is not a request of
  // its own, so it must not fall through to `requestUi` either.
  await expect(
    probe("extensions.providers.abort", {
      sessionId: "session-one",
      callId: "call-one",
    }),
  ).resolves.toEqual({ ok: true });
  expect(abortProviderRequest).toHaveBeenCalledWith({
    sessionId: "session-one",
    callId: "call-one",
  });
  expect(requestUi).not.toHaveBeenCalled();
});
