import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServerClient, describeMcpContent } from "../electron/main/plugin-mcp.ts";

/**
 * An MCP server that only speaks the 2024-11-05 HTTP+SSE transport (issue
 * #2528): `GET <url>` opens the event stream and announces a message endpoint;
 * `POST <url>` is not routed, so a streamable-HTTP client gets 405.
 */
async function startLegacySseServer(t, { postStatus = 405, endpoint = "/messages?session=abc" } = {}) {
  const posts = [];
  const streams = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/mcp" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`: connected\n\nevent: endpoint\ndata: ${endpoint}\n\n`);
      streams.add({ req, res });
      req.on("close", () => {
        for (const entry of streams) if (entry.res === res) streams.delete(entry);
      });
      return;
    }
    if (path === "/mcp") {
      res.writeHead(postStatus, { allow: "GET" }).end("Method Not Allowed");
      return;
    }
    if (path === "/messages" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        posts.push({ url: req.url, headers: req.headers, message });
        res.writeHead(202).end("Accepted");
        if (message.id === undefined) return;
        let result = {};
        if (message.method === "initialize") {
          result = { protocolVersion: "2024-11-05", capabilities: {} };
        } else if (message.method === "tools/list") {
          result = { tools: [{ name: "echo" }] };
        } else if (message.method === "tools/call") {
          result = { content: [{ type: "text", text: `echo:${req.headers.authorization}` }] };
        }
        const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`;
        for (const entry of streams) entry.res.write(payload);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const entry of streams) entry.res.destroy();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, posts, streams };
}

function client(url, values = {}) {
  return new McpServerClient({
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-sse-")),
    server: { id: "legacy", transport: "http", url },
    values,
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
}

for (const status of [405, 404, 400]) {
  test(`an http server that answers POST with ${status} falls back to the legacy SSE transport`, async (t) => {
    const { url, posts } = await startLegacySseServer(t, { postStatus: status });
    const mcp = client(url, { authorization: "Bearer secret" });
    t.after(() => mcp.close());

    const tools = await mcp.connect();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
    const result = await mcp.callTool("echo", {});
    assert.equal(describeMcpContent(result.content), "echo:Bearer secret");
    assert.deepEqual(
      posts.map((entry) => entry.message.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    assert.ok(posts.every((entry) => entry.url === "/messages?session=abc"));
  });
}

test("closing a legacy SSE client ends its event stream", async (t) => {
  const { url, streams } = await startLegacySseServer(t);
  const mcp = client(url);
  await mcp.connect();
  assert.equal(streams.size, 1);
  mcp.close();
  for (let i = 0; i < 50 && streams.size > 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(streams.size, 0);
});

test("a legacy SSE endpoint on another origin is refused", async (t) => {
  const { url, posts } = await startLegacySseServer(t, { endpoint: "http://evil.example.test/messages" });
  const mcp = client(url, { authorization: "Bearer secret" });
  t.after(() => mcp.close());
  await assert.rejects(mcp.connect(), (error) => {
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(posts.length, 0);
});

test("an authorization failure does not fall back to SSE", async (t) => {
  const { url, posts } = await startLegacySseServer(t, { postStatus: 401 });
  const mcp = client(url);
  t.after(() => mcp.close());
  await assert.rejects(mcp.connect(), (error) => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.match(error.message, /401/);
    return true;
  });
  assert.equal(posts.length, 0);
});

test("a server that rejects both transports keeps the original HTTP error", async (t) => {
  const server = createServer((req, res) => res.writeHead(405).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const mcp = client(`http://127.0.0.1:${server.address().port}/mcp`);
  t.after(() => mcp.close());
  await assert.rejects(mcp.connect(), (error) => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.match(error.message, /405/);
    return true;
  });
});
