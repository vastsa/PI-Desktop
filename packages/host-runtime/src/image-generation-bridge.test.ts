import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

// A real stdio child forwards requested calls over the production reverse RPC.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});
const pending=new Map(); rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='probe'){pending.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}
else if(pending.has(m.id)){console.log(JSON.stringify({...m,id:pending.get(m.id)}));pending.delete(m.id);}});`;
const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});
function harness(allowed = true, childSource = child, esm = false) {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: [...(esm ? ["--input-type=module"] : []), "-e", childSource] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const calls: string[] = [];
  const host: SidecarHostLink = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return { ok: allowed, content: allowed ? { authorized: true } : "denied" } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);
  const execute = (mode = "agent", toolCallId = "i") =>
    sidecar.call<{ ok: boolean }>("probe", {
      method: "tools.execute",
      params: {
        sessionId: "s",
        toolCallId,
        mode,
        toolName: "GenerateImages",
        args: { items: [{ prompt: "image" }] },
      },
    });
  return { sidecar, calls, execute };
}

it("authorizes image calls through the host before executing the local handler", async () => {
  const { sidecar, calls, execute } = harness();
  sidecar.setLocalTool("GenerateImages", async () => {
    calls.push("generated");
    return { ok: true, content: "image" };
  });
  expect((await execute()).ok).toBe(true);
  expect(calls).toEqual(["tools.execute", "generated"]);
});

it("preserves stable local error codes through real reverse RPC", async () => {
  const { sidecar, execute } = harness();
  sidecar.setLocalTool("GenerateImages", async () => {
    throw Object.assign(new Error("Image request failed"), {
      errorCode: "IMAGE_TIMEOUT", data: { retryable: false }, secret: "must-not-cross",
    });
  });
  await expect(execute()).rejects.toMatchObject({
    code: -32000, errorCode: "IMAGE_TIMEOUT",
    data: { errorCode: "IMAGE_TIMEOUT", retryable: false },
  });
});

it("delivers stable error codes to the production ParentHostProxy in a real child", async () => {
  const receiverUrl = new URL("../../agent-runtime/src/parent-host-proxy.ts", import.meta.url).href;
  const source = `
    import { createInterface } from 'node:readline';
    const { ParentHostProxy } = await import(${JSON.stringify(receiverUrl)});
    const proxy = new ParentHostProxy();
    createInterface({input:process.stdin}).on('line', async line => {
      const message = JSON.parse(line);
      if (proxy.handleParentMessage(message)) return;
      try {
        const result = await proxy.call(message.params.method, message.params.params);
        console.log(JSON.stringify({id:message.id,result}));
      } catch (error) {
        console.log(JSON.stringify({id:message.id,result:{code:error.code,errorCode:error.errorCode,data:error.data}}));
      }
    });`;
  const { sidecar, execute } = harness(true, source, true);
  sidecar.setLocalTool("GenerateImages", async () => {
    throw Object.assign(new Error("limited"), { errorCode: "IMAGE_HTTP_429" });
  });
  expect(await execute()).toEqual({ code: -32000, errorCode: "IMAGE_HTTP_429", data: { errorCode: "IMAGE_HTTP_429" } });
});

it("denied and Plan calls never reach the image service", async () => {
  const { sidecar, execute } = harness(false);
  const generate = vi.fn().mockResolvedValue({ ok: true, content: "image" });
  sidecar.setLocalTool("GenerateImages", generate);
  expect((await execute()).ok).toBe(false);
  expect((await execute("plan")).ok).toBe(false);
  expect(generate).not.toHaveBeenCalled();
});

it("tools.abort reaches the in-flight request and still forwards host cancellation", async () => {
  const { sidecar, calls, execute } = harness();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  sidecar.setLocalTool("GenerateImages", async ({ signal }) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { ok: false, content: "cancelled" };
  });
  const pending = execute();
  await ready;
  await sidecar.call("probe", {
    method: "tools.abort",
    params: { sessionId: "s", toolCallId: "i" },
  });
  expect((await pending).ok).toBe(false);
  expect(calls).toEqual(["tools.execute", "tools.abort"]);
});
