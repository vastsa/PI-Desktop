/** Real host + sidecar + Python + HTTP + disk boundary; no live provider calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createPlatformMediaTool } = await import("../apps/desktop/electron/main/services/platform-media-service.ts");
const { fixture, key, png, video } = await import("../apps/desktop/resources/skills/ai-aggregation-platform/tests/platform-media-fixture.mjs");
const cleanups = [];
const f = await fixture({ after: (cleanup) => cleanups.push(cleanup) });
const host = new Host(resolveHostBinary(), f.dataDir);

// Only the model edge is simulated. It issues real reverse RPC over stdio;
// host-core performs the actual permission decision before local dispatch.
const model = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const pending = new Map();
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'probe') {
    const id = 'r' + message.id;
    pending.set(id, message.id);
    console.log(JSON.stringify({ id, method: 'host.proxy', params: message.params }));
  } else if (pending.has(message.id)) {
    console.log(JSON.stringify({ ...message, id: pending.get(message.id) }));
    pending.delete(message.id);
  }
});`;

function startSidecar() {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", model] },
    onStderr: (text) => process.stderr.write(text),
  });
  sidecar.setHost({
    call: (method, params) => host.call(method, params),
    onNotification: () => () => {},
    onExit: () => () => {},
  });
  sidecar.setLocalTool("PlatformMedia", createPlatformMediaTool({ ...f.options, getHost: () => host }));
  return sidecar;
}

let sidecar;
try {
  await host.start();
  sidecar = startSidecar();
  await host.call("workspace.set", { path: f.project });
  const { provider } = await host.call("providers.create", {
    name: "Isolated media fixture", vendorKey: "ai-aggregation-platform",
    type: "openai_compatible", protocol: "openai_compatible",
    authKind: "api_key_and_base_url", secretValue: key,
    baseUrl: "https://ai.yykkj.com/v1", apiStyle: "chat_completions",
    defaultModelId: "chat-fixture",
  });
  await host.call("settings.set", {
    defaultPermissionMode: "auto", defaultProviderId: provider.id, defaultModelId: "chat-fixture",
  });
  const { session } = await host.call("session.create", {
    title: "Media boundary E2E", mode: "agent", projectPath: f.project,
    providerId: provider.id, modelId: "chat-fixture",
  });
  const execute = (sessionId, args) => sidecar.call("probe", {
    method: "tools.execute", params: {
      sessionId, toolCallId: randomUUID(), toolName: "PlatformMedia", mode: "agent", args,
    },
  });

  const { session: plan } = await host.call("session.create", {
    title: "Media Plan denial", mode: "plan", projectPath: f.project,
    providerId: provider.id, modelId: "chat-fixture",
  });
  const denied = await execute(plan.id, { operation: "video-create", prompt: "Must not submit" });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.errorCode, "TOOL_DISABLED_IN_PLAN", JSON.stringify(denied));
  assert.equal(f.requests.length, 0, "Permission denial must happen before HTTP or Python work");

  const generated = await execute(session.id, { operation: "image", prompt: "Blue toy boat", count: 2 });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.equal(generated.content.result.images.length, 2);
  assert.deepEqual(await readFile(generated.content.result.images[0].file), png);
  const imageReceipt = generated.content.result.receipt;
  const clip = join(f.project, "reference motion.mp4");
  await writeFile(clip, video);
  const created = await execute(session.id, {
    operation: "video-create", prompt: "Animate the toy boat", seconds: 4,
    images: [generated.content.result.images[0].file], videos: [clip],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.content.result.task_id, "task_fixture");
  assert.equal(created.content.result.status, "queued");
  const receipt = created.content.result.receipt;
  assert.equal(f.posts().length, 3);
  await host.call("session.appendMessage", {
    sessionId: session.id,
    message: {
      id: randomUUID(), role: "tool", content: "", toolName: "PlatformMedia",
      toolResult: { details: created.content }, createdAt: new Date().toISOString(), status: "complete",
    },
  });

  await sidecar.dispose();
  sidecar = undefined;
  await host.restart();
  sidecar = startSidecar();
  const restored = await host.call("session.get", { id: session.id });
  assert.equal(restored.session.messages[0].toolResult.details.result.receipt, receipt);
  assert.ok(!JSON.stringify(restored).includes("fixture-platform-key"));
  const status = await execute(session.id, { operation: "video-status", receipt });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.content.result.status, "completed");
  const downloaded = await execute(session.id, { operation: "video-download", receipt });
  assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
  assert.deepEqual(await readFile(downloaded.content.result.file), video);
  const billed = await execute(session.id, { operation: "billing", receipt });
  assert.equal(billed.ok, true, JSON.stringify(billed));
  assert.equal(billed.content.result.verified, true);
  assert.equal(billed.content.result.net_usd, 0.2);
  const images = await execute(session.id, { operation: "image-download", receipt: imageReceipt });
  assert.equal(images.ok, true, JSON.stringify(images));
  assert.equal(images.content.result.images.length, 2);
  assert.equal(f.posts().length, 3, "Restart recovery must not create another billed request");
  for (const request of f.requests) {
    if (request.url === "/api/status") assert.equal(request.headers.authorization, undefined);
    else assert.equal(request.headers.authorization, `Bearer ${key}`);
  }
  console.log(JSON.stringify({ ok: true, fixtureRequests: f.requests.length, generationPosts: f.posts().length,
    scenarios: ["host-plan-denial", "image-batch", "multimodal-video-create", "host-and-sidecar-restart", "receipt-status", "video-download", "task-billing", "image-recovery-without-post"] }));
} finally {
  await sidecar?.dispose();
  await host.stop();
  for (const cleanup of cleanups.reverse()) await cleanup();
}
