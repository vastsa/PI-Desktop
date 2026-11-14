/** Production sidecar restart + strict loopback Chat Completions gateway (#2306). */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OfflineSidecar, fixtureHost } from "./e2e/hosted-search-sidecar.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: "string" } } });
const bundle = values.bundle ? resolve(values.bundle) : join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const temporary = await mkdtemp(join(tmpdir(), "pi-restored-tool-pairs-"));
const createdAt = "2026-11-13T00:00:00.000Z";

function unpairedResult(messages) {
  let calls = new Set();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!calls.delete(message.tool_call_id)) return true;
    } else calls = new Set((message.tool_calls ?? []).map(call => call.id));
  }
  return false;
}

async function scenario(boundary) {
  const dir = join(temporary, boundary ?? "no-checkpoint");
  await mkdir(dir, { recursive: true });
  const history = [
    { id: "user", role: "user", content: "Read two files", createdAt, status: "complete" },
    { id: "assistant", role: "assistant", content: "Reading", createdAt, status: "complete" },
    ...["a", "b"].map(id => ({
      id: `tool-${id}`, role: "tool", content: `file-${id}-result`, createdAt,
      status: "complete", toolName: "Read", toolCallId: `call-${id}`,
      toolArgs: { path: `${id}.txt` }, toolStatus: "success",
      toolResult: { content: [{ type: "text", text: `file-${id}-result` }] },
    })),
  ];
  const compaction = boundary ? {
    id: "checkpoint", summary: "Earlier file work", throughMessageId: boundary,
    firstKeptMessageId: "user", retainedTail: [], tokensBefore: 100,
    details: { retainedTailMode: "completed_turn" }, createdAt,
  } : undefined;
  // This JSON fixture is the Host persistence boundary, never a user profile.
  const path = join(dir, "persisted-session.json");
  await writeFile(path, JSON.stringify({ messages: history, compaction }));
  const original = await readFile(path, "utf8");
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (unpairedResult(body.messages)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0,
      delta: { content: "Done: restored context accepted." }, finish_reason: "stop",
    }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let sidecar;
  let toolExecutions = 0;
  const params = {
    sessionId: "restored-session", mode: "agent", thinkingLevel: "off", scratchDir: dir,
    pluginTools: [], pluginSkills: [], trustedExtensions: [],
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: {
      id: "fixture", name: "Fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "fixture", apiKey: "fixture-only", apiStyle: "chat_completions",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
  };
  try {
    // Two fresh processes each recover the same Host-owned history.
    for (let restart = 0; restart < 2; restart++) {
      const baseHost = fixtureHost();
      const host = async (method, args) => {
        if (method === "session.get") return { session: { id: params.sessionId, ...JSON.parse(await readFile(path, "utf8")) } };
        if (method === "tools.execute") { toolExecutions++; throw new Error("Historical tools must not execute again"); }
        return baseHost(method, args);
      };
      sidecar = await OfflineSidecar.start(bundle, dir, host, 20_000);
      for (const content of ["Continue the file task.", "Report once more."]) {
        const events = await sidecar.prompt(params, content);
        assert.ok(events.some(({ event }) => event.type === "message_end" &&
          event.message.role === "assistant" && event.message.status === "complete" &&
          event.message.content === "Done: restored context accepted."));
      }
      sidecar.check();
      await sidecar.stop();
      sidecar = undefined;
    }
    assert.equal(requests.length, 4);
    const expected = boundary === "tool-b" ? [] : boundary === "tool-a" ? ["call-b"] : ["call-a", "call-b"];
    for (const { messages } of requests) {
      assert.equal(unpairedResult(messages), false);
      if (boundary) {
        assert.ok(JSON.stringify(messages).includes("Earlier file work"));
        assert.ok(!JSON.stringify(messages).includes("Read two files"));
      }
      assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), expected);
      for (const id of expected) {
        assert.deepEqual(messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === id)?.function,
          { name: "Read", arguments: JSON.stringify({ path: `${id.slice(-1)}.txt` }) });
        assert.ok(JSON.stringify(messages.find(message => message.tool_call_id === id)?.content).includes(`file-${id.slice(-1)}-result`));
      }
    }
    assert.equal(toolExecutions, 0);
    assert.equal(await readFile(path, "utf8"), original);
    console.log(JSON.stringify({ boundary: boundary ?? "none", restarts: 2, completedTurns: requests.length, passed: true }));
  } finally {
    await sidecar?.stop();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

try {
  for (const boundary of ["assistant", "tool-a", "tool-b", undefined]) await scenario(boundary);
} finally { await rm(temporary, { recursive: true, force: true }); }
