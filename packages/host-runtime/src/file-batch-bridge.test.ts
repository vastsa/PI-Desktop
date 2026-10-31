import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const source = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
let sidecar: AgentSidecar | undefined;
afterEach(async () => { await sidecar?.dispose(); });

it("forwards only the explicit file batch methods through the production sidecar bridge", async () => {
  sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => {} });
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: SidecarHostLink = {
    call: async <T>(method: string, params?: unknown) => { calls.push({ method, params }); return { ok: true } as T; },
    onNotification: () => () => {}, onExit: () => () => {},
  };
  sidecar.setHost(host);
  for (const method of ["tools.fileBatchCapabilities", "tools.fileBatchRegister", "tools.fileBatchSeal", "tools.fileBatchAbandon", "tools.fileBatchClose"]) {
    const params = { sessionId: "session", batchId: "batch" };
    await expect(sidecar.call("probe", { method, params })).resolves.toEqual({ ok: true });
    expect(calls.at(-1)).toEqual({ method, params });
  }
  await expect(sidecar.call("probe", { method: "tools.fileBatchBypassPermissions", params: {} })).rejects.toMatchObject({ code: -32601 });
  await expect(sidecar.call("probe", { method: "settings.set", params: {} })).rejects.toMatchObject({ code: -32601 });
  expect(calls).toHaveLength(5);
});
