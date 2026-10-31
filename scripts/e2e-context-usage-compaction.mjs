/** Production sidecar + localhost Responses gateway with inconsistent usage totals. */
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
const temporary = await mkdtemp(join(tmpdir(), "pi-context-usage-"));

class CompactionSidecar extends OfflineSidecar {
  async receive(line) {
    const frame = JSON.parse(line);
    if (frame.method === "agent.diagnostic") {
      assert.equal(frame.params.kind, "compaction_shape");
      return;
    }
    await super.receive(line);
  }
}

async function scenario(mode) {
  const dir = join(temporary, mode);
  await mkdir(dir, { recursive: true });
  const requests = [], timeline = [], checkpoints = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const summary = JSON.stringify(body.input).includes("structured context checkpoint summary");
    requests.push(body);
    timeline.push(summary ? "summary" : "turn");
    const serial = requests.length;
    const text = summary ? "Fixture checkpoint summary." : `Fixture answer ${serial}.`;
    const item = {
      id: `message-${serial}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const firstUsage = mode === "cached-input"
      ? { input_tokens: 80_000, output_tokens: 100, total_tokens: 20_100,
          input_tokens_details: { cached_tokens: 60_000 } }
      : mode === "partial-buckets"
        ? { input_tokens: 0, output_tokens: 10, total_tokens: 80_000 }
        : { input_tokens: 4_000, output_tokens: 10, total_tokens: 4_010,
            input_tokens_details: { cached_tokens: 2_000 } };
    const usage = serial === 1 ? firstUsage : { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    const events = [
      { type: "response.created", response: { id: `response-${serial}` } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `response-${serial}`, status: "completed", output: [item], usage } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseHost = fixtureHost();
  const host = (method, params) => {
    if (method === "session.appendCompaction") {
      timeline.push("checkpoint");
      checkpoints.push(params.compaction);
      return { ok: true };
    }
    return baseHost(method, params);
  };
  let sidecar;
  try {
    const env = await isolatedEnv(dir);
    const child = spawn(process.execPath, [bundle], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    sidecar = new CompactionSidecar(child, dir, host, 20_000);
    assert.equal((await sidecar.call("sidecar.health")).ok, true);
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const params = {
      sessionId: `context-${mode}`, mode: "agent", thinkingLevel: "off", scratchDir: dir,
      pluginTools: [], pluginSkills: [], trustedExtensions: [],
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: {
        id: "fixture", name: "Fixture", baseUrl, modelId: "fixture-model", apiKey: "fixture-only",
        apiStyle: "responses", supportsReasoning: false, supportedThinkingLevels: ["off"],
        modelConfig: {
          source: "generic", name: "Fixture model", baseUrl, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000, maxTokens: 8_192,
        },
      },
    };
    await sidecar.prompt(params, "Start the task.");
    const first = [...sidecar.messages.values()].find((message) => message.role === "assistant");
    const expectedTotal = mode === "cached-input" ? 20_100 : mode === "partial-buckets" ? 80_000 : 4_010;
    assert.equal(first?.usage?.totalTokens, expectedTotal);
    if (mode === "cached-input") assert.equal(first?.usage?.cacheReadTokens, 60_000);
    await sidecar.prompt(params, "Continue the task.");
    if (mode !== "normal-usage") {
      assert.deepEqual(timeline, ["turn", "summary", "checkpoint", "turn"]);
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].summary, "Fixture checkpoint summary.");
      assert.ok(JSON.stringify(requests[2].input).includes("Fixture checkpoint summary."));
      assert.ok(sidecar.events.some(({ event }) => event.type === "compaction_end" && event.ok));
    } else {
      assert.deepEqual(timeline, ["turn", "turn"]);
      assert.equal(checkpoints.length, 0);
    }
    assert.ok(JSON.stringify(requests.at(-1).input).includes("Continue the task."));
    sidecar.check();
    console.log(JSON.stringify({ mode, passed: true, requests: requests.length, checkpoints: checkpoints.length }));
  } finally {
    await sidecar?.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const mode of ["cached-input", "partial-buckets", "normal-usage"]) await scenario(mode);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
