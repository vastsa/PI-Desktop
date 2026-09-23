import { afterEach, expect, it } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map();rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){const id='r'+m.id;pending.set(id,m.id);
console.log(JSON.stringify({id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

it("keeps local preview tools available without a Host while memory fails closed", async () => {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] }, onStderr: () => {},
  });
  sidecars.push(sidecar);
  sidecar.setLocalTool("BrowserPreview", async () => ({ ok: true, preview: "local" }));
  expect(await sidecar.call("probe", {
    method: "tools.execute", params: { toolName: "BrowserPreview", sessionId: "bound", args: {} },
  })).toEqual({ ok: true, preview: "local" });
  await expect(sidecar.call("probe", {
    method: "project.autoMemory.agentList", params: { sessionId: "bound" },
  })).rejects.toThrow("host unavailable");
});

it("binds automatic memory reverse RPC to registered sessions", async () => {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", child] }, onStderr: () => {},
  });
  sidecars.push(sidecar);
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: SidecarHostLink = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return { memory: { enabled: true, entries: [] } } as T;
    },
    onNotification: () => () => {}, onExit: () => () => {},
  };
  sidecar.setHost(host);
  sidecar.setProjectInstructionRoot("bound", "/trusted/root");
  const probe = (method: string, params: Record<string, unknown>) =>
    sidecar.call("probe", { method, params });
  await probe("project.autoMemory.agentList", {
    sessionId: "bound", boundPath: "/spoofed", path: "/spoofed", enabled: false,
  });
  expect(calls).toEqual([{
    method: "project.autoMemory.agentList",
    params: { sessionId: "bound", boundPath: "/trusted/root" },
  }]);
  await probe("project.autoMemory.agentUpsert", {
    sessionId: "bound", boundPath: "/spoofed", path: "/spoofed", enabled: false,
    id: "note", title: "Stack", content: "Use pnpm", expectedTitle: "Stack", expectedContent: "Use npm",
  });
  expect(calls[1]).toEqual({
    method: "project.autoMemory.agentUpsert",
    params: { sessionId: "bound", boundPath: "/trusted/root", id: "note", title: "Stack",
      content: "Use pnpm", expectedTitle: "Stack", expectedContent: "Use npm" },
  });
  await expect(probe("project.autoMemory.agentDelete", { sessionId: "unbound", id: "note" }))
    .rejects.toThrow("bound project session");
  await expect(probe("project.autoMemory.setEnabled", { sessionId: "bound", enabled: true }))
    .rejects.toThrow("not allowed");
  sidecar.clearProjectInstructionRoot("bound");
  await expect(probe("project.autoMemory.agentList", { sessionId: "bound" }))
    .rejects.toThrow("bound project session");
  expect(calls).toHaveLength(2);
});
