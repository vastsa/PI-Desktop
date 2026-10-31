/** Production sidecar + localhost HTTP: retry waits are not stalled requests. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OfflineSidecar, fixtureHost, isolatedEnv } from "./e2e/hosted-search-sidecar.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: "string" } } });
const bundle = values.bundle ? resolve(values.bundle) : join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const temporary = await mkdtemp(join(tmpdir(), "pi-retry-idle-"));
const results = [];

async function scenario(mode) {
  const dir = join(temporary, mode);
  await mkdir(dir, { recursive: true });
  let requests = 0, stalledSocketClosed = false, overlapped = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the fixture request body. */ }
    requests++;
    if (requests === 1 && mode === "stalled-request") {
      response.on("close", () => { stalledSocketClosed = true; });
      return;
    }
    if (requests === 1) {
      response.writeHead(429, { "retry-after-ms": "30000" }).end("Rate limited");
      return;
    }
    if (mode === "stalled-request" && !stalledSocketClosed) overlapped = true;
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk",
      created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(chunk({ role: "assistant", content: "Recovered" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseHost = fixtureHost();
  const host = (method, params) => method === "plans.abort" ? { ok: true } : baseHost(method, params);
  const env = await isolatedEnv(dir);
  env.PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS = "30000";
  const child = spawn(process.execPath, [bundle], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  const sidecar = new OfflineSidecar(child, dir, host, 45_000);
  sidecar.allowProviderRetries = true;
  const sessionId = `retry-${mode}`;
  const turnId = `${sessionId}-turn`;
  const retries = () => sidecar.events.flatMap(({ event }) =>
    event.type === "status" && event.status.activity?.phase === "retrying" ? [event.status.activity] : []);
  try {
    assert.equal((await sidecar.call("sidecar.health")).ok, true);
    await sidecar.call("agent.prompt", {
      sessionId, turnId, userMessageId: `${turnId}-user`, content: "Report when the provider becomes available.",
      mode: "agent", thinkingLevel: "off", infiniteProviderRetry: false, scratchDir: dir,
      pluginTools: [], pluginSkills: [], trustedExtensions: [],
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only", apiStyle: "chat_completions",
        supportsReasoning: false, supportedThinkingLevels: ["off"] },
    });
    if (mode === "abort-backoff") {
      await sidecar.waitFor(() => retries().length > 0, "rate-limit backoff");
      await sidecar.call("agent.abort", { sessionId, turnId });
    }
    await sidecar.waitFor(() => {
      const attempts = retries().map((retry) => retry.attempt);
      assert.ok(attempts.length <= 1 && attempts.every((attempt) => attempt === 1),
        `idle watchdog charged another retry during backoff: ${JSON.stringify(attempts)}`);
      return sidecar.events.some((event) => event.turnId === turnId && event.event.type === "agent_end");
    }, "turn completion");
    assert.deepEqual(retries().map((retry) => retry.attempt), [1]);
    assert.equal((await sidecar.call("agent.getStatus", { sessionId })).status.isRunning, false);
    assert.equal(requests, mode === "abort-backoff" ? 1 : 2);
    if (mode !== "abort-backoff") {
      assert.ok([...sidecar.messages.values()].some((message) => message.content === "Recovered"));
    }
    if (mode === "stalled-request") {
      assert.equal(stalledSocketClosed, true, "timed-out attempt was not cancelled");
      assert.equal(overlapped, false, "retry overlapped the abandoned request");
    }
    sidecar.check();
    results.push({ mode, passed: true, requests });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    await sidecar.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const mode of ["abort-backoff", "retry-after", "stalled-request"]) await scenario(mode);
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
