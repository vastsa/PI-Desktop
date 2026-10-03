import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// A real stdio child that forwards each `probe` over the production reverse RPC.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
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
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: SidecarHostLink = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return {
        sessionId: "s",
        todos: [{ content: "Wire it", status: "in_progress", priority: "medium" }],
        revision: 3,
        updatedAt: 1,
      } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  return { sidecar, calls };
}

it("lets a compaction checkpoint read the session checklist through the proxy", async () => {
  const { sidecar, calls } = harness();
  await expect(
    sidecar.call("probe", { method: "todos.get", params: { sessionId: "s" } }),
  ).resolves.toMatchObject({ revision: 3, todos: [{ content: "Wire it" }] });
  expect(calls).toEqual([{ method: "todos.get", params: { sessionId: "s" } }]);
});

it("still refuses checklist mutation outside TodoWrite", async () => {
  const { sidecar, calls } = harness();
  await expect(
    sidecar.call("probe", { method: "todos.set", params: { sessionId: "s", todos: [] } }),
  ).rejects.toMatchObject({ code: -32601 });
  expect(calls).toEqual([]);
});
