import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar } from "../agent-sidecar.js";

const sidecars: AgentSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map(sidecar => sidecar.dispose())); });
it.each([
  ["goals.get", true], ["goals.validateTurn", true], ["goals.report", true], ["goals.settleTurn", true],
  ["goals.start", false], ["goals.control", false], ["goals.claimTurn", false],
])("sidecar proxy enforces user authority for %s", async (method, allowed) => {
  const source = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let probeId;
    rl.on('line', line => {
      const frame = JSON.parse(line);
      if (frame.method === 'ping') return console.log(JSON.stringify({id:frame.id,result:{ok:true}}));
      if (frame.method === 'probe') {
        probeId = frame.id;
        return console.log(JSON.stringify({id:'reverse',method:'host.proxy',params:{method:${JSON.stringify(method)},params:{sessionId:'fixture'}}}));
      }
      if (frame.id === 'reverse') console.log(JSON.stringify({id:probeId,result:frame}));
    });`;
  const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr() {} });
  sidecars.push(sidecar);
  const call = vi.fn(async () => ({ goal: null }));
  sidecar.setHost({ call, isAvailable: () => true, onNotification: () => () => {}, onExit: () => () => {} });
  const result = await sidecar.call<{ result?: unknown; error?: { code: number; message: string } }>("probe", {});
  if (allowed) {
    expect(result.result).toEqual({ goal: null });
    expect(call).toHaveBeenCalledWith(method, { sessionId: "fixture" });
  } else {
    expect(result.error?.code).toBe(-32601);
    expect(call).not.toHaveBeenCalled();
  }
});
