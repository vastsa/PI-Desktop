/** Isolated host/stdio/HTTP/filesystem candidate gate; no paid providers. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createImageGenerationTool } = await import(
  "../apps/desktop/electron/main/services/image-generation-service.ts"
);
const dataDir = await mkdtemp(join(tmpdir(), "pi-image-e2e-"));
const host = new Host(resolveHostBinary(), dataDir);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);
let requests = 0;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* Drain the bounded fixture request. */
  }
  requests++;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
// Only the LLM edge is simulated; reverse RPC, authorization and execution are real.
const child = `const rl=require('node:readline').createInterface({input:process.stdin});const p=new Map();rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='probe'){p.set('r'+m.id,m.id);console.log(JSON.stringify({id:'r'+m.id,method:'host.proxy',params:m.params}));}else if(p.has(m.id)){console.log(JSON.stringify({...m,id:p.get(m.id)}));p.delete(m.id);}});`;
const sidecar = new AgentSidecar({
  launch: { command: process.execPath, args: ["-e", child] },
  onStderr: (text) => process.stderr.write(text),
});
sidecar.setHost({
  call: (method, params) => host.call(method, params),
  onNotification: () => () => {},
  onExit: () => () => {},
});
sidecar.setLocalTool("generate_images", createImageGenerationTool({ dataDir, getHost: () => host }));
try {
  await host.start();
  const project = join(dataDir, "project");
  await mkdir(project);
  await host.call("workspace.set", { path: project });
  const { provider } = await host.call("providers.create", {
    name: "Image fixture",
    type: "openai_compatible",
    protocol: "openai_compatible",
    authKind: "none",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    defaultModelId: "image-fixture",
    apiStyle: "chat_completions",
  });
  const binding = { providerId: provider.id, modelId: "image-fixture" };
  await host.call("settings.set", {
    defaultPermissionMode: "auto",
    imageGeneration: binding,
    defaultModelId: "chat-fixture",
  });
  const { session } = await host.call("session.create", {
    title: "Image test",
    mode: "agent",
    projectPath: project,
    providerId: provider.id,
    modelId: "chat-fixture",
  });
  const execute = (id, items) =>
    sidecar.call("probe", {
      method: "tools.execute",
      params: {
        sessionId: id,
        toolCallId: randomUUID(),
        toolName: "generate_images",
        mode: "agent",
        args: { items },
      },
    });
  const generated = await execute(session.id, [{ prompt: "cover", count: 2 }, { prompt: "icon" }]);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.content.results.length, 3);
  const source = generated.content.results[0].path;
  const edited = await execute(session.id, [{ prompt: "green background", images: [source] }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.notEqual(edited.content.results[0].path, source);
  await host.call("session.appendMessage", {
    sessionId: session.id,
    message: {
      id: randomUUID(),
      role: "tool",
      content: "",
      toolName: "generate_images",
      toolResult: { details: generated.content },
      createdAt: new Date().toISOString(),
      status: "complete",
    },
  });
  const { session: plan } = await host.call("session.create", {
    title: "Plan",
    mode: "plan",
    projectPath: project,
  });
  const denied = await execute(plan.id, [{ prompt: "must not run" }]);
  assert.equal(denied.ok, false);
  assert.equal(requests, 4);
  await host.restart();
  const restored = await host.call("settings.get");
  assert.deepEqual(restored.imageGeneration, binding);
  assert.equal(restored.defaultModelId, "chat-fixture");
  const recovered = await host.call("session.get", { id: session.id });
  assert.deepEqual(recovered.session.messages[0].toolResult.details, generated.content);
  assert.deepEqual(await readFile(source), png);
  await host.call("settings.set", { imageGeneration: null });
  assert.equal(
    (await execute(session.id, [{ prompt: "unset" }])).errorCode,
    "IMAGE_NOT_CONFIGURED",
  );
  assert.equal(requests, 4);
  console.log(
    JSON.stringify({
      ok: true,
      fixtureRequests: requests,
      scenarios: [
        "batch-generation",
        "edit-result",
        "host-plan-denial",
        "settings-and-transcript-restart",
        "clear-binding",
      ],
    }),
  );
} finally {
  await sidecar.dispose();
  await host.stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
