import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

/** A model boundary fixture; the production receiver handles every reverse RPC. */
function proxy(invoke: (method: string, params?: unknown) => Promise<unknown>) {
  const source = `
    const pending = new Map();
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const frame = JSON.parse(line);
      if (frame.method === 'probe') {
        const id = 'reverse-' + frame.id;
        pending.set(id, frame.id);
        console.log(JSON.stringify({ jsonrpc: '2.0', id, method: 'host.proxy', params: frame.params }));
      } else if (pending.has(frame.id)) {
        const id = pending.get(frame.id);
        pending.delete(frame.id);
        console.log(JSON.stringify({ jsonrpc: '2.0', id, ...('error' in frame ? {error: frame.error} : {result: frame.result}) }));
      }
    });`;
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", source] },
    onStderr: () => {},
  });
  const host: SidecarHostLink = {
    call: async <T = unknown>(method: string, params?: unknown): Promise<T> => await invoke(method, params) as T,
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  sidecars.push(sidecar);
  return sidecar;
}

it.each(["modes.completeStage", "modes.gateResult"])("forwards %s through real stdio without changing the claim", async (method) => {
  const outcome = { status: "finished", run: { id: "run-1", state: "finished" } };
  const invoke = vi.fn(async () => outcome);
  const sidecar = proxy(invoke);
  const params = { sessionId: "session-1", runId: "run-1", turnId: "turn-1", input: "Original objective", summary: "Verified" };
  expect(await sidecar.call("probe", { method, params })).toEqual(outcome);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(method, params);
});

it.each(["modes.start", "modes.control", "modes.update", "modes.resolve", "modes.settleTurn", "provider.get"])(
  "does not expose %s to model-directed sidecar code",
  async (method) => {
    const invoke = vi.fn(async () => ({}));
    const sidecar = proxy(invoke);
    await expect(sidecar.call("probe", { method, params: {} })).rejects.toMatchObject({ code: -32601 });
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each(["MODE_CLAIM_MISMATCH", "MODE_INPUT_CHANGED", "MODE_INVALID_ARGUMENT"])("preserves Host rejection %s", async (errorCode) => {
  const sidecar = proxy(async () => {
    throw Object.assign(new Error(errorCode), { code: -32000, data: { errorCode } });
  });
  await expect(sidecar.call("probe", { method: "modes.completeStage", params: { runId: "stale" } })).rejects.toMatchObject({
    code: -32000, errorCode, data: { errorCode },
  });
});
