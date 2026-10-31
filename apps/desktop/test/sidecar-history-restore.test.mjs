import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the actual sidecar RPC boundary. Only the external Host service and
// provider endpoint are fixtures; runtime admission and restore wiring are real.
test("history restore failures cannot accept a clean prompt for stable or legacy callers", { timeout: 60_000 }, async (t) => {
  let providerRequests = 0;
  const server = createServer((_req, res) => { providerRequests++; res.writeHead(500); res.end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout }); t.after(() => lines.close());
  const responses = new Map(); const events = [];
  const send = (value) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  let restoreFailure = "host";
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.method === "host.proxy") {
      if (value.params.method === "tools.fileBatchCapabilities") {
        assert.equal(restoreFailure, "empty", "capability negotiation must follow successful history restoration");
        send({ id: value.id, result: { version: 1, supported: false } });
        return;
      }
      assert.equal(value.params.method, "session.get");
      if (restoreFailure === "host") send({ id: value.id, error: { code: -32000, message: "corrupted persisted history", data: { errorCode: "HISTORY_CORRUPT" } } });
      else if (restoreFailure === "empty") send({ id: value.id, result: { session: { messages: [] } } });
      else if (restoreFailure === "missing") send({ id: value.id, result: { session: null } });
      else send({ id: value.id, result: { session: { messages: [{ id: "bad-history", role: "user", content: "retained", attachments: "invalid" }] } } });
    } else if (value.id) {
      const resolve = responses.get(value.id); responses.delete(value.id); resolve?.(value);
    } else if (value.method === "agent.event") events.push(value.params);
  });
  let id = 0;
  const call = (params) => new Promise((resolve, reject) => {
    const requestId = String(++id);
    const timer = setTimeout(() => reject(new Error(`Sidecar RPC timeout: ${stderr}`)), 15_000);
    responses.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    send({ id: requestId, method: "agent.prompt", params });
  });
  for (const stable of [false, true]) {
    for (const failure of ["host", "hydrate", "missing"]) {
      restoreFailure = failure;
      const response = await call({
        sessionId: `${stable ? "stable" : "legacy"}-${failure}`, content: "must not start clean",
        ...(stable ? { userMessageId: "current-user" } : {}),
        commandShell: { id: "bash", label: "Bash", executable: "/bin/bash", dialect: "posix", available: true, isDefault: true, args: [] },
        provider: { id: "fixture", modelId: "fixture", authKind: "none", apiStyle: "openai-chat", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelConfig: { input: ["text", "image"] } },
      });
      assert.ok(response.error, `${stable ? "stable" : "legacy"} ${failure} must reject admission`);
      assert.equal(response.result, undefined);
      if (failure === "host") assert.equal(response.error.message, "corrupted persisted history");
    }
  }
  assert.equal(providerRequests, 0, "a restore failure must never start a provider turn");
  assert.deepEqual(events, [], "no successful or empty-history turn is emitted");
  restoreFailure = "empty";
  const emptySession = await call({
    sessionId: "new-empty-session", content: "valid first prompt", userMessageId: "first-user",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "fixture", modelId: "fixture", authKind: "none", apiStyle: "openai-chat", baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
  });
  assert.equal(emptySession.result?.accepted, true, "a real new session with empty history remains valid");
});
