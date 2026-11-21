import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the real sidecar RPC boundary (#2468). Only the Host service and the
// provider endpoint are fixtures; the runtime factory, reuse check, and tool
// catalog are the shipped code. Main sends `computerUseEnabled: true` only for
// Agent sessions with the setting on, and omits it otherwise.
test("the computer-use switch reaches the Agent tool catalog and retires a stale runtime", { timeout: 60_000 }, async (t) => {
  const requestBodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requestBodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    res.end(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout }); t.after(() => lines.close());
  const send = (value) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const responses = new Map();
  const turnEnds = new Map();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.method === "host.proxy") {
      if (value.params.method === "session.get") send({ id: value.id, result: { session: { messages: [] } } });
      else if (value.params.method === "tools.fileBatchCapabilities") send({ id: value.id, result: { version: 1, supported: false } });
      else send({ id: value.id, result: null });
    } else if (value.id && responses.has(value.id)) {
      const resolve = responses.get(value.id); responses.delete(value.id); resolve(value);
    } else if (value.method === "agent.event" && value.params?.event?.type === "agent_end") {
      turnEnds.get(value.params.sessionId)?.();
    }
  });

  let id = 0;
  const prompt = async (sessionId, computerUseEnabled) => {
    const before = requestBodies.length;
    const ended = new Promise((resolve) => turnEnds.set(sessionId, resolve));
    const requestId = String(++id);
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Sidecar RPC timeout: ${stderr}`)), 15_000);
      responses.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
      send({
        id: requestId, method: "agent.prompt", params: {
          sessionId, mode: "agent", content: "hello", userMessageId: `user-${requestId}`,
          ...(computerUseEnabled ? { computerUseEnabled: true } : {}),
          commandShell: { id: "bash", label: "Bash", executable: "/bin/bash", dialect: "posix", available: true, isDefault: true, args: [] },
          provider: { id: "fixture", modelId: "fixture", authKind: "none", apiStyle: "openai-chat", baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
        },
      });
    });
    assert.equal(response.result?.accepted, true, `prompt rejected: ${JSON.stringify(response.error)} ${stderr}`);
    let turnTimer;
    await Promise.race([ended, new Promise((_, reject) => { turnTimer = setTimeout(() => reject(new Error(`turn did not end: ${stderr}`)), 15_000); })]);
    clearTimeout(turnTimer);
    assert.ok(requestBodies.length > before, "the turn must reach the provider");
    return requestBodies.slice(before).join("\n");
  };
  // Computer is an on-demand tool: it is either declared directly or listed in
  // the ToolSearch catalog line `- Computer: ...` of the system prompt.
  const offersComputer = (body) => /"name"\s*:\s*"Computer"|- Computer: /.test(body);

  assert.equal(offersComputer(await prompt("starts-on", true)), true, "enabled from the first turn");
  assert.equal(offersComputer(await prompt("starts-off", false)), false, "disabled from the first turn");
  assert.equal(offersComputer(await prompt("starts-off", true)), true, "turning it on rebuilds the runtime");
  assert.equal(offersComputer(await prompt("starts-off", false)), false, "turning it off rebuilds the runtime");
});
