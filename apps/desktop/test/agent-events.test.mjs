import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createAgentEventHub, MAX_AGENT_EVENT_SUBSCRIBERS } =
  await import("../electron/main/agent-events.ts");
const { McpControlServer } = await import("../electron/main/mcp-control.ts");

const envelope = (sessionId, type = "message_update") => ({
  sessionId,
  ts: Date.now(),
  event: type === "message_update"
    ? { type, message: { id: "m1", role: "assistant", content: "hi" } }
    : { type },
});

test("agent event hub filters sessions and isolates broken listeners", () => {
  const hub = createAgentEventHub();
  const all = [];
  const filtered = [];
  hub.subscribe((event) => all.push(event));
  hub.subscribe((event) => filtered.push(event), { sessionIds: ["s2"] });
  hub.subscribe(() => { throw new Error("dead client"); });

  hub.ingest(envelope("s1"));
  hub.ingest(envelope("s2", "turn_end"));

  assert.equal(all.length, 2);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sessionId, "s2");
  assert.equal(hub.subscriberCount(), 2);
});

test("agent event hub enforces a bounded subscriber count", () => {
  const hub = createAgentEventHub();
  const subscriptions = [];
  for (let i = 0; i < MAX_AGENT_EVENT_SUBSCRIBERS; i += 1) {
    subscriptions.push(hub.subscribe(() => {}));
  }
  assert.equal(subscriptions.filter(Boolean).length, MAX_AGENT_EVENT_SUBSCRIBERS);
  assert.equal(hub.subscribe(() => {}), null);
  subscriptions.forEach((subscription) => subscription?.unsubscribe());
  assert.equal(hub.subscriberCount(), 0);
});

async function readUntil(reader, marker, initial = "") {
  let text = initial;
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${marker}`);
    text += Buffer.from(value).toString("utf8");
  }
  return text;
}

test("MCP control exposes filtered SSE events and the batch-status tool", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-agent-events-"));
  const hub = createAgentEventHub();
  const server = new McpControlServer({
    dataDir,
    port: 0,
    channels: {
      agentGetStatuses: "pi-desktop/agent/getStatuses",
    },
    eventHub: hub,
    invoke: async () => ({ statuses: {} }),
  });
  t.after(() => server.stop());
  const info = await server.start();
  assert.ok(info);
  assert.match(info.eventsUrl, /127\.0\.0\.1:\d+\/events$/);

  const response = await fetch(`${info.eventsUrl}?sessionId=s2`, {
    headers: { Authorization: `Bearer ${info.token}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const ready = await readUntil(reader, "event: ready");
  assert.match(ready, /pi-agent-events/);

  hub.ingest(envelope("s1"));
  hub.ingest(envelope("s2", "turn_end"));
  const delivered = await readUntil(reader, "event: agent");
  assert.match(delivered, /"sessionId":"s2"/);
  assert.doesNotMatch(delivered, /"sessionId":"s1"/);
  await reader.cancel();

  const listed = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const sessionId = listed.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const tools = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }).then((result) => result.json());
  assert.ok(tools.result.tools.some((tool) => tool.name === "pi_agent_status_batch"));
});
