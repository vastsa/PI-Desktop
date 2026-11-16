import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { RuntimeService } from "../packages/host-runtime/dist/runtime-service.js";
import { isolatedEnv } from "./e2e/hosted-search-sidecar.mjs";

// Build host-runtime and the production sidecar bundle first. Only host-core
// and the provider HTTP endpoint are fixtures; admission, cancellation,
// transport, the Agent loop and turn finalization use the production code.
const bundle = fileURLToPath(new URL("../packages/agent-runtime/dist-bundle/sidecar.js", import.meta.url));
const principal = { subject: "fixture", roles: ["owner"], pairedDevice: true };

for (const phase of ["begin", "append", "restore"]) {
  test(`headless startup abort during ${phase} settles before a follow-up`, { timeout: 30_000 }, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), "pi-headless-startup-"));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const nextEnded = Promise.withResolvers();
    const history = [];
    const ended = [];
    const durableEnds = [];
    const providerBodies = [];
    let held = false;
    let turnCounter = 0;
    let stderr = "";
    let service;
    let sidecar;

    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      providerBodies.push(body);
      const lastUser = body.messages.filter((message) => message.role === "user").at(-1);
      const followUp = JSON.stringify(lastUser?.content).includes("Follow-up task");
      const frame = (delta, finishReason) => `data: ${JSON.stringify({
        id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ role: "assistant", content: followUp ? "Follow-up completed" : "Working" }, null));
      if (followUp) response.end(frame({}, "stop") + "data: [DONE]\n\n");
      // The first response stays open until the real runtime cancels it.
    });
    t.after(async () => {
      release.resolve();
      await service?.dispose();
      await sidecar?.dispose();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      const directory = resolve(scratch);
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("pi-headless-startup-"));
      await rm(directory, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const host = {
      async call(method, params = {}) {
        const shouldHold = phase === "begin" ? method === "session.beginTurn"
          : phase === "append" ? method === "session.appendMessage"
          : method === "session.get" && params.messageLimit === undefined;
        if (!held && shouldHold) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        switch (method) {
          case "settings.get": return {};
          case "session.get": return { session: {
            id: params.id, mode: "agent", permissionMode: "ask", messages: history,
            providerId: "fixture", modelId: "fixture-model",
          } };
          case "session.beginTurn": return { turnId: `turn-${++turnCounter}` };
          case "session.appendMessage": {
            const index = history.findIndex((message) => message.id === params.message.id);
            if (index < 0) history.push(params.message);
            else history[index] = params.message;
            return { ok: true };
          }
          case "session.endTurn": durableEnds.push(params); return { ok: true };
          case "session.saveInflightMessage": return { ok: true };
          case "plans.abort": return { ok: true };
          case "tools.fileBatchCapabilities": return { version: 1, supported: false };
          default: throw new Error(`Unexpected fixture Host call: ${method}`);
        }
      },
      isAvailable: () => true,
      onNotification: () => () => {},
      onExit: () => () => {},
    };
    sidecar = new AgentSidecar({
      launch: { command: process.execPath, args: [bundle], env: await isolatedEnv(scratch), cwd: scratch },
      onStderr: (chunk) => { stderr += chunk; },
    });
    sidecar.setHost(host);
    service = new RuntimeService({
      getHost: () => host,
      getSidecar: () => sidecar,
      launch: { async resolve(sessionId) {
        return {
          providerId: "fixture", modelId: "fixture-model", projectPath: scratch,
          sidecarParams: {
            sessionId, mode: "agent", thinkingLevel: "off", scratchDir: scratch,
            commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
            provider: {
              id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "fixture-only",
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiStyle: "chat_completions",
              supportsReasoning: false, supportedThinkingLevels: ["off"],
            },
          },
        };
      } },
      log: () => {},
    });
    service.attachHost(host);
    service.attachSidecar(sidecar);
    service.onTurnEnded((info) => {
      ended.push(info);
      if (info.turnId === "turn-2") nextEnded.resolve(info);
    });
    await sidecar.call("sidecar.health");
    const sessionId = `startup-${phase}`;
    const starting = service.prompt({ sessionId, content: "First task", effectivePermissionMode: "ask", principal });
    await entered.promise;
    let abortReturned = false;
    const stopping = service.abort(sessionId, phase === "restore" ? "turn-1" : undefined)
      .then(() => { abortReturned = true; });
    // A real status round trip lets an incorrectly early cancellation settle
    // while the admission gate is still closed, without a timing-based sleep.
    await service.getStatus(sessionId);
    const returnedBeforeAdmission = abortReturned;
    release.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(returnedBeforeAdmission, false, "abort acknowledged before the runtime could be canceled");
    assert.equal((await service.getStatus(sessionId)).isRunning, false, "the aborted startup still runs");
    assert.deepEqual(ended.map(({ turnId, reason }) => ({ turnId, reason })), [{ turnId: "turn-1", reason: "aborted" }]);
    assert.equal(durableEnds.length, 1);
    assert.equal(durableEnds[0].status, "aborted");

    await service.prompt({ sessionId, content: "Follow-up task", effectivePermissionMode: "ask", principal });
    assert.equal((await nextEnded.promise).reason, "completed");
    assert.equal(service.isBusy(sessionId), false);
    assert.ok(history.some((message) => message.role === "assistant" && message.content === "Follow-up completed"));
    const lastUser = providerBodies.at(-1).messages.filter((message) => message.role === "user").at(-1);
    assert.ok(JSON.stringify(lastUser.content).includes("Follow-up task"));
    assert.equal(durableEnds.length, 2, "each durable turn must settle once");
    assert.doesNotMatch(stderr, /unhandled promise rejection|TypeError:|ReferenceError:/);
  });
}
