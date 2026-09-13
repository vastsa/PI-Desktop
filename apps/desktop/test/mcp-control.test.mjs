import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  McpControlServer,
  createMcpControlController,
  boundMcpResult,
  createMcpControlOperations,
  isLoopbackBindHost,
  mcpControlRendererEvent,
  negotiateMcpProtocolVersion,
  stripSecretMaterial,
  tokensEqual,
} = await import("../electron/main/mcp-control.ts");

test("the plugin and MCP paths share desktop operation validation", async () => {
  const calls = [];
  const controller = createMcpControlController({
    channels: {
      projectSet: "pi-desktop/project/set",
      sessionDelete: "pi-desktop/session/delete",
    },
    invoke: async (channel, args) => {
      calls.push({ channel, args });
      return { ok: true };
    },
  });

  assert.deepEqual(
    controller.operations.map((operation) => operation.id),
    ["session/delete", "project/set"],
  );
  await assert.rejects(
    () => controller.invoke({ operation: "session/delete", args: ["s1"] }),
    (error) => error.code === "CONFIRMATION_REQUIRED",
  );
  await controller.invoke({ operation: "project/set", args: ["/tmp/project"] });
  await controller.invoke({ operation: "session/delete", args: ["s1"], confirm: true });
  assert.deepEqual(calls, [
    { channel: "pi-desktop/project/set", args: ["/tmp/project"] },
    { channel: "pi-desktop/session/delete", args: ["s1"] },
  ]);
});

async function post(url, token, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return {
    response,
    body: raw ? JSON.parse(raw) : null,
  };
}

const fixtureChannels = {
  appGetVersion: "pi-desktop/app/getVersion",
  projectSet: "pi-desktop/project/set",
  sessionGet: "pi-desktop/session/get",
  sessionCreate: "pi-desktop/session/create",
  sessionDelete: "pi-desktop/session/delete",
  sessionConfigure: "pi-desktop/session/configure",
  plansResolve: "pi-desktop/plans/resolve",
  agentPrompt: "pi-desktop/agent/prompt",
};

test("local MCP control server authenticates, discovers, and invokes desktop operations", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-mcp-control-"));
  const calls = [];
  const events = [];
  const server = new McpControlServer({
    dataDir,
    port: 0,
    version: "test",
    channels: fixtureChannels,
    invoke: async (channel, args) => {
      calls.push({ channel, args });
      if (channel === "pi-desktop/app/getVersion") {
        return { name: "PI-Desktop", version: "test" };
      }
      if (channel === "pi-desktop/project/set") {
        return { workspace: { path: args[0], name: "fixture" } };
      }
      if (channel === "pi-desktop/session/create") {
        return { session: { id: "session-created", projectPath: args[0]?.projectPath ?? null } };
      }
      return { ok: true };
    },
    onOperationComplete: (operation, result, args) => {
      events.push(mcpControlRendererEvent(operation, result, args));
    },
  });
  t.after(() => server.stop());

  const info = await server.start();
  assert.ok(info);
  assert.match(info.url, /127\.0\.0\.1:\d+\/mcp$/);
  assert.match(info.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "mcp-control.json"), "utf8")), info);

  const unauthorized = await fetch(info.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(unauthorized.status, 401);

  const rejectedOrigin = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const getResponse = await fetch(info.url, {
    headers: { Authorization: `Bearer ${info.token}` },
  });
  assert.equal(getResponse.status, 405);

  const initialized = await post(info.url, info.token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2099-01-01" },
  });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, "pi-desktop");
  assert.equal(initialized.body.result.serverInfo.version, "test");
  assert.equal(initialized.body.result.protocolVersion, "2025-06-18");
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);

  const missingSession = await post(info.url, info.token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert.equal(missingSession.response.status, 400);

  const unsupportedVersion = await post(
    info.url,
    info.token,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2099-01-01" },
  );
  assert.equal(unsupportedVersion.response.status, 400);

  const listed = await post(
    info.url,
    info.token,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { "Mcp-Session-Id": sessionId },
  );
  const toolNames = listed.body.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("pi_desktop_invoke"));
  assert.ok(toolNames.includes("pi_control_describe"));
  assert.ok(toolNames.includes("pi_project_open"));
  assert.ok(toolNames.includes("pi_plans_resolve"));
  assert.ok(toolNames.includes("pi_session_configure"));

  const opened = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pi_project_open", arguments: { path: "/tmp/project" } },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(opened.body.result.structuredContent.workspace.path, "/tmp/project");
  assert.deepEqual(calls.at(-1), {
    channel: "pi-desktop/project/set",
    args: ["/tmp/project"],
  });

  const version = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "pi_desktop_invoke",
        arguments: { operation: "app/getVersion", args: [] },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(version.body.result.structuredContent.result.version, "test");

  const refusedDelete = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "pi_desktop_invoke",
        arguments: { operation: "session/delete", args: ["session-1"] },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(refusedDelete.body.result.isError, true);
  assert.equal(calls.some((call) => call.channel === "pi-desktop/session/delete"), false);

  await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "pi_desktop_invoke",
        arguments: {
          operation: "session/delete",
          args: ["session-1"],
          confirm: true,
        },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(calls.at(-1).channel, "pi-desktop/session/delete");

  const refusedPlan = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "pi_plans_resolve",
        arguments: {
          proposalId: "proposal-1",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "tool-1",
          action: "reject",
        },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(refusedPlan.body.result.isError, true);
  assert.equal(calls.some((call) => call.channel === "pi-desktop/plans/resolve"), false);

  await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "pi_plans_resolve",
        arguments: {
          proposalId: "proposal-1",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "tool-1",
          action: "reject",
          confirm: true,
        },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.deepEqual(calls.at(-1), {
    channel: "pi-desktop/plans/resolve",
    args: [{
      proposalId: "proposal-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      action: "reject",
    }],
  });

  const refusedConfigure = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "pi_session_configure",
        arguments: {
          id: "session-1",
          mode: "agent",
          permissionMode: "auto",
        },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(refusedConfigure.body.result.isError, true);
  assert.equal(calls.some((call) => call.channel === "pi-desktop/session/configure"), false);

  await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "pi_session_configure",
        arguments: {
          id: "session-1",
          mode: "agent",
          permissionMode: "auto",
          confirm: true,
        },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.deepEqual(calls.at(-1), {
    channel: "pi-desktop/session/configure",
    args: ["session-1", { mode: "agent", permissionMode: "auto" }],
  });

  const described = await post(
    info.url,
    info.token,
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "pi_control_describe", arguments: {} } },
    { "Mcp-Session-Id": sessionId },
  );
  const describedIds = described.body.result.structuredContent.map((entry) => entry.id);
  assert.equal(describedIds.includes("pluginLauncher/toggle"), false);
  assert.equal(describedIds.includes("plugin/loadDev"), false);
  assert.equal(describedIds.includes("providers/create"), false);
  assert.equal(describedIds.includes("settings/set"), false);
  assert.equal(describedIds.some((id) => id.startsWith("secrets/")), false);
  const configure = described.body.result.structuredContent.find((entry) => entry.id === "session/configure");
  assert.equal(configure.risk, "dangerous");
  assert.deepEqual(configure.argumentShape, ["id", "config"]);

  const created = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "pi_session_create", arguments: { title: "from mcp", secretValue: "sk-live" } },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(created.body.result.structuredContent.session.id, "session-created");
  assert.equal(calls.at(-1).args[0].secretValue, undefined);
  assert.equal(calls.at(-1).args[0].title, "from mcp");

  const refreshCount = events.filter(Boolean).length;
  const readSession = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "pi_session_get", arguments: { id: "session-1" } },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(readSession.body.result.isError, undefined);
  assert.equal(events.filter(Boolean).length, refreshCount);

  const missingPath = await post(
    info.url,
    info.token,
    {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "pi_project_open", arguments: {} },
    },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(missingPath.body.result.isError, true);

  const notification = await post(
    info.url,
    info.token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "Mcp-Session-Id": sessionId },
  );
  assert.equal(notification.response.status, 202);

  const callCount = calls.length;
  const missingId = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "pi_session_delete", arguments: { id: "session-1", confirm: true } },
    }),
  });
  assert.equal(missingId.status, 400);
  assert.equal(calls.length, callCount);

  const tokenHeader = await fetch(info.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
      "X-Pi-Desktop-Token": info.token,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 15, method: "ping" }),
  });
  assert.equal(tokenHeader.status, 200);

  const deleted = await fetch(info.url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${info.token}`, "Mcp-Session-Id": sessionId },
  });
  assert.equal(deleted.status, 204);
});

test("the MCP control connection file is marked inactive on shutdown", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-mcp-control-stop-"));
  const server = new McpControlServer({
    dataDir,
    port: 0,
    channels: { appGetVersion: "pi-desktop/app/getVersion" },
    invoke: async () => ({}),
  });
  const info = await server.start();
  await server.stop();
  const stopped = JSON.parse(readFileSync(join(dataDir, "mcp-control.json"), "utf8"));
  assert.equal(stopped.active, false);
  assert.equal(stopped.url, info.url);
});

test("the MCP control server refuses a non-loopback bind address", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-mcp-control-bind-"));
  const server = new McpControlServer({
    dataDir,
    host: "0.0.0.0",
    port: 0,
    channels: { appGetVersion: "pi-desktop/app/getVersion" },
    invoke: async () => ({}),
  });
  await assert.rejects(() => server.start(), /loopback/);
});

test("control-plane helpers clamp protocol versions, strip secrets, and bound results", () => {
  assert.equal(negotiateMcpProtocolVersion("2025-03-26"), "2025-03-26");
  assert.equal(negotiateMcpProtocolVersion("2099-01-01"), "2025-06-18");
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("127.1.2.3"), true);
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.equal(isLoopbackBindHost("::1"), true);
  assert.equal(tokensEqual("abc", "abc"), true);
  assert.equal(tokensEqual("abc", "abd"), false);

  const stripped = stripSecretMaterial({
    title: "ok",
    secretValue: "sk-live",
    apiKey: "x",
    headers: { Authorization: "Bearer x", Accept: "application/json" },
    env: { PATH: "/bin", OPENAI_API_KEY: "sk" },
    nested: { client_secret: "nope", keep: 1 },
  });
  assert.deepEqual(stripped, {
    title: "ok",
    headers: { Accept: "application/json" },
    env: { PATH: "/bin" },
    nested: { keep: 1 },
  });

  const bounded = boundMcpResult({ blob: "a".repeat(600_000) });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.reason, "MCP_RESULT_LIMIT");
  assert.ok(JSON.stringify(bounded).length < 600_000);
});

test("renderer refresh events fire only for mutating control operations", () => {
  const sessionOp = (id) => ({
    id,
    channel: `pi-desktop/${id}`,
    description: id,
    risk: "write",
    argumentShape: [],
  });
  assert.equal(mcpControlRendererEvent(sessionOp("session/get"), { session: { id: "s1" } }, []), null);
  assert.equal(mcpControlRendererEvent(sessionOp("session/list"), { sessions: [] }, []), null);
  assert.deepEqual(
    mcpControlRendererEvent(sessionOp("session/create"), { session: { id: "s1", projectPath: "/tmp/p" } }, []),
    { reason: "mcp.session", selectSessionId: "s1", projectPath: "/tmp/p" },
  );
  assert.deepEqual(
    mcpControlRendererEvent(
      sessionOp("session/create"),
      { session: { id: "s2", projectPath: "/tmp/p" } },
      [],
      "plugin",
    ),
    { reason: "plugin.session" },
  );
  assert.deepEqual(
    mcpControlRendererEvent(sessionOp("session/configure"), { session: { id: "s1" } }, ["s1", { mode: "agent" }]),
    { reason: "mcp.session" },
  );
  assert.deepEqual(
    mcpControlRendererEvent(sessionOp("agent/prompt"), { accepted: true }, [{ sessionId: "s1" }]),
    { reason: "mcp.prompt", selectSessionId: "s1" },
  );
  assert.deepEqual(
    mcpControlRendererEvent(
      sessionOp("agent/prompt"),
      { accepted: true },
      [{ sessionId: "s1" }],
      "plugin",
    ),
    { reason: "plugin.prompt" },
  );
  assert.deepEqual(
    mcpControlRendererEvent(
      sessionOp("session/open"),
      { session: { id: "s1", projectPath: "/tmp/p" } },
      [],
      "plugin",
    ),
    { reason: "plugin.session.open", selectSessionId: "s1", projectPath: "/tmp/p" },
  );
});

test("the reviewed catalog never includes picker or secret-write channels", () => {
  const operations = createMcpControlOperations({
    appGetVersion: "pi-desktop/app/getVersion",
    pluginLoadDev: "pi-desktop/plugin/loadDev",
    pluginCreateFromTemplate: "pi-desktop/plugin/createFromTemplate",
    secretsSet: "pi-desktop/secrets/set",
    providersCreate: "pi-desktop/providers/create",
    settingsSet: "pi-desktop/settings/set",
    mcpUpsert: "pi-desktop/mcp/upsert",
    sessionConfigure: "pi-desktop/session/configure",
    projectSet: "pi-desktop/project/set",
  });
  const ids = operations.map((operation) => operation.id).sort();
  assert.deepEqual(ids, ["app/getVersion", "project/set", "session/configure"].sort());
});
