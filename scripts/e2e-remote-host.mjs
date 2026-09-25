#!/usr/bin/env node
/**
 * Headless remote Host E2E (E2E-231 host half): boots a real `pi-host` with
 * the debug host-core and the bundled sidecar on a throwaway data dir, pairs
 * a device over the loopback RACP-WS socket, registers a project, creates a
 * session, reads the workspace, drops the connection, and reconnects by
 * cursor. With no provider configured, `turn/start` first fails closed with
 * `MODEL_NOT_CONFIGURED`; the run then exercises
 * `E2E-REMOTE-provider-import-enables-turn` (D626): `pi-host provider-import`
 * copies a provider — key on stdin only — over the owner-only admin socket to
 * the running Host, and the next turn is admitted and reaches a loopback mock
 * model as a Bearer header, with the key never echoed by the CLI or the Host.
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (target/debug or PI_DESKTOP_HOST_BIN). The runner creates
 * a temporary release bundle by default; PI_DESKTOP_HOST_BUNDLE_DIR can point
 * it at a prebuilt bundle instead.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { assert, errorCodeOf, shortJson } from "./e2e/assert.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(join(root, "apps/desktop/test/helpers/ts-import-hooks.mjs")));
const { createRemoteToolRelay } = await import(
  "../apps/desktop/electron/main/remote/remote-tool-relay.ts"
);
const hostBin = resolveHostBinary();
const configuredBundleDir = process.env.PI_DESKTOP_HOST_BUNDLE_DIR;
const ownsBundle = !configuredBundleDir;
const bundleDir = configuredBundleDir ?? mkdtempSync(join(tmpdir(), "pi-host-e2e-bundle-"));
if (ownsBundle) {
  const bundleResult = spawnSync(
    process.execPath,
    [
      join(root, "apps/pi-host/scripts/bundle.mjs"),
      "--host-core",
      hostBin,
      "--platform",
      process.platform,
      "--arch",
      process.arch,
      "--out",
      bundleDir,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (bundleResult.error || bundleResult.status !== 0) {
    rmSync(bundleDir, { recursive: true, force: true });
    throw bundleResult.error ?? new Error(`pi-host bundle failed with exit code ${bundleResult.status}`);
  }
}
const cli = join(bundleDir, "pi-host.js");
const sidecar = join(bundleDir, "agent-runtime/sidecar.js");
for (const [label, path] of [["pi-host cli", cli], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
    process.exit(1);
  }
}
const dataDir = mkdtempSync(join(tmpdir(), "pi-host-e2e-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# remote project\n");
for (const args of [["init", "-q"], ["-c", "user.name=Remote E2E", "-c", "user.email=remote-e2e@example.invalid", "commit", "-qam", "E2E baseline"]]) {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    rmSync(dataDir, { recursive: true, force: true });
    throw result.error ?? new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  if (args[0] === "init") {
    const staged = spawnSync("git", ["add", "README.md"], { cwd: project, encoding: "utf8" });
    if (staged.error || staged.status !== 0) {
      rmSync(dataDir, { recursive: true, force: true });
      throw staged.error ?? new Error(`git add failed: ${staged.stderr}`);
    }
  }
}

// A loopback OpenAI-compatible model. It records the Authorization header so
// the test can prove the imported key travels to the model. Relay prompts get
// one deterministic MCP call, then a final answer after the tool result.
const modelAuth = [];
const modelRequests = [];
const modelServer = createServer((req, res) => {
  const auth = req.headers.authorization ?? null;
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }
  modelAuth.push(auth);
  let requestBody = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (requestBody += chunk));
  req.on("end", () => {
    const body = JSON.parse(requestBody);
    modelRequests.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const latestUser = messages[lastUserIndex];
    const latestUserText = typeof latestUser?.content === "string"
      ? latestUser.content
      : JSON.stringify(latestUser?.content ?? "");
    const wantsRelay = latestUserText.includes("remote-mcp-success") || latestUserText.includes("remote-mcp-close");
    const turnMessages = messages.slice(lastUserIndex + 1);
    const mcpAlreadyCalled = turnMessages.some((message) =>
      message?.tool_calls?.some((call) => call?.function?.name === "mcp_global_lookup"),
    );
    const mcpToolExposed = (body.tools ?? []).some((tool) =>
      (tool?.function?.name ?? tool?.name) === "mcp_global_lookup",
    );
    const relayAction = wantsRelay && !mcpAlreadyCalled
      ? mcpToolExposed ? "mcp" : "search"
      : "final";
    const base = { id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-model" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = relayAction === "search"
      ? {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: latestUserText.includes("remote-mcp-close") ? "call_tool_search_close" : "call_tool_search_success",
            type: "function",
            function: { name: "ToolSearch", arguments: JSON.stringify({ query: "mcp_global_lookup" }) },
          }],
        }
      : relayAction === "mcp"
      ? {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: latestUserText.includes("remote-mcp-close") ? "call_remote_mcp_close" : "call_remote_mcp_success",
            type: "function",
            function: {
              name: "mcp_global_lookup",
              arguments: JSON.stringify({ query: latestUserText.includes("remote-mcp-close") ? "close-mid-call" : "remote-notes" }),
            },
          }],
      }
      : { role: "assistant", content: wantsRelay ? "remote MCP result was handled" : "remote reply ok" };
    const finish = relayAction === "final" ? "stop" : "tool_calls";
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((done) => modelServer.listen(0, "127.0.0.1", done));
const modelPort = modelServer.address().port;

const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
};

let child = null;
let stderr = "";
function startHost(extraArgs = []) {
  child = spawn(process.execPath, [cli, "--data-dir", dataDir, "--port", "0", "--host-core", hostBin, "--sidecar", sidecar, "--browse-root", dataDir, "--log-level", "warn", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  return new Promise((resolveReady, reject) => {
    let out = "";
    const ready = {};
    const timer = setTimeout(() => reject(new Error("pi-host did not become ready\n" + stderr.slice(-2000))), 60_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (line.startsWith("PI_HOST_READY ")) ready.info = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) ready.pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          reject(new Error("pi-host failed: " + line + "\n" + stderr.slice(-2000)));
        }
      }
      if (ready.info && (!extraArgs.includes("--pair") || ready.pairing)) {
        clearTimeout(timer);
        resolveReady(ready);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi-host exited early code=${code}\n${stderr.slice(-2000)}`));
    });
  });
}
async function stopHost() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
  });
}

function client(url, token, options = {}) {
  const events = [];
  const instance = new RacpClient({
    transport: wsClientTransport({ url, token }),
    client: { name: "pi-host-e2e", version: "0.15.0" },
    onEvent: (envelope) => events.push(envelope),
    requestTimeoutMs: 30_000,
    ...options,
  });
  return { client: instance, events };
}

function droppingTerminalOpenResponseTransport(url, token, openRequestId) {
  const buildTransport = wsClientTransport({ url, token });
  return async () => {
    const transport = await buildTransport();
    let droppedRequestId = null;
    return {
      send(frame) {
        try {
          const message = JSON.parse(frame);
          if (message.method === "terminal/open" && message.params?.openRequestId === openRequestId) {
            droppedRequestId = message.id;
          }
        } catch {
          // Forward malformed frames so the protocol server remains authoritative.
        }
        transport.send(frame);
      },
      close(code, reason) {
        transport.close(code, reason);
      },
      onMessage(handler) {
        transport.onMessage((frame) => {
          try {
            const message = JSON.parse(frame);
            if (droppedRequestId !== null && message.id === droppedRequestId && message.method === undefined) {
              droppedRequestId = null;
              return;
            }
          } catch {
            // Deliver non-JSON frames to the client for protocol validation.
          }
          handler(frame);
        });
      },
      onClose(handler) {
        transport.onClose(handler);
      },
      onError(handler) {
        transport.onError(handler);
      },
    };
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// Poll the live event buffer from `fromIndex` until a match arrives or it times
// out. Takes the live array — not a slice — so events pushed while we wait count.
async function waitForEvent(events, fromIndex, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.slice(fromIndex).some(predicate)) return true;
    await sleep(100);
  }
  return false;
}

// Import one provider through the running Host over the admin socket. The key
// travels only on the CLI's stdin, mirroring the SSH stdin path in production.
const KEY_MARKER = "e2e-remote-key-DO-NOT-LOG";
function importProviders(payload) {
  return new Promise((resolveImport, reject) => {
    const proc = spawn(process.execPath, [cli, "provider-import", "--data-dir", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => (out += String(chunk)));
    proc.stderr.on("data", (chunk) => (err += String(chunk)));
    proc.once("error", reject);
    proc.once("exit", (code) => resolveImport({ code, out, err }));
    proc.stdin.end(JSON.stringify(payload));
  });
}

let remoteRelay = null;
let replacementRelay = null;
let replacementOwner = null;
let activeOwner = null;
let releaseHeldMcpCall = null;
let markHeldMcpCallStarted = null;
const heldMcpCallStarted = new Promise((resolveStarted) => {
  markHeldMcpCallStarted = resolveStarted;
});
const remoteMcpExecutions = [];
const replacementMcpExecutions = [];
const relayAdvertisements = [];
const relayLogs = [];
const desktopServerRequests = [];

function createDesktopRelay(ownerClient, executions, options = {}) {
  const relayClient = {
    initialized: () => ownerClient.client.initialized ?? undefined,
    hostCapabilities: () => ownerClient.client.initialized?.capabilities,
    request: async (method, params) => {
      if (method === "tools/advertise") relayAdvertisements.push({ method, params });
      return ownerClient.client.request(method, params);
    },
  };
  return createRemoteToolRelay({
    hostKey: "e2e-remote-host",
    pairedDevice: true,
    client: relayClient,
    log: (level, message, data) => relayLogs.push({ level, message, data }),
    userMcp: {
      toolsForRemoteSession: async () => [{
        fullName: "mcp_global_lookup",
        serverId: "global",
        toolName: "lookup",
        description: "Search the desktop's configured service",
        schema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      }],
      callTool: async (fullName, args, projectPath, executionKey) => {
        executions.push({ fullName, args, projectPath, executionKey });
        if (options.holdCloseCall && args.query === "close-mid-call") {
          return new Promise((resolveCall) => {
            releaseHeldMcpCall = resolveCall;
            markHeldMcpCallStarted?.();
            markHeldMcpCallStarted = null;
          });
        }
        return { content: [{ type: "text", text: `desktop MCP result: ${args.query}` }] };
      },
      cancelSessionCalls: () => undefined,
    },
  });
}

let exitCode = 0;
try {
  const ready = await startHost(["--pair"]);
  const url = `ws://127.0.0.1:${ready.info.port}/v1/racp/ws`;
  record("host-boots-on-loopback", ready.info.host === "127.0.0.1" && ready.info.port > 0 && typeof ready.info.hostId === "string", shortJson(ready.info));

  // Pairing: the token is single-use and the device token replaces it.
  const pairing = client(url, ready.pairing.token);
  const init = await pairing.client.connect();
  record("pairing-connection-is-unprivileged", init.principal.roles.length === 0 && init.server.hostId === ready.info.hostId);
  const paired = await pairing.client.request("connection/pair", { deviceLabel: "e2e desktop" });
  record("pair-mints-owner-device", paired.roles.includes("owner") && paired.deviceToken.startsWith("pdt1."));
  let secondPair = null;
  try {
    await pairing.client.request("connection/pair", {});
  } catch (error) {
    secondPair = errorCodeOf(error);
  }
  record("pairing-token-is-single-use", secondPair === "PAIRING_FAILED", String(secondPair));
  await pairing.client.close();

  const owner = client(url, paired.deviceToken, {
    reconnect: { enabled: true, baseDelayMs: 50, maxAttempts: 10 },
    onServerRequest: async (method, params) => {
      desktopServerRequests.push({ method, params });
      if (!remoteRelay) throw new Error("desktop relay is not ready");
      try {
        return await remoteRelay.handleServerRequest(method, params);
      } catch (error) {
        relayLogs.push({ level: "error", message: "Desktop server request failed", data: String(error) });
        throw error;
      }
    },
  });
  const ownerInit = await owner.client.connect();
  activeOwner = owner;
  record("device-token-authenticates-as-owner", ownerInit.principal.roles.includes("owner") && ownerInit.capabilities.remoteHostProfile === true);

  const registered = await owner.client.request("project/register", { path: project });
  record("project-registers-on-host", typeof registered.project.id === "string" && registered.project.label === "project", shortJson(registered));
  let missing = null;
  try {
    await owner.client.request("project/register", { path: join(dataDir, "missing") });
  } catch (error) {
    missing = errorCodeOf(error);
  }
  record("project-register-validates-path-on-host", missing === "REMOTE_PATH_NOT_FOUND", String(missing));
  const browsed = await owner.client.request("project/browse", { path: dataDir });
  record("project-browse-lists-directories", browsed.entries.some((entry) => entry.name === "project"));

  await owner.client.request("events/subscribe", { scope: "host" });
  const created = await owner.client.request("session/create", { title: "Remote E2E", projectId: registered.project.id });
  record("session-creates-under-project", created.session.projectId === registered.project.id && created.session.status === "idle", shortJson(created.session));
  const listed = await owner.client.request("session/list");
  record("session-list-includes-created", listed.sessions.some((session) => session.id === created.session.id));
  const attach = await owner.client.request("session/attach", { sessionId: created.session.id });
  record("attach-returns-snapshot", attach.replayComplete === true && Array.isArray(attach.snapshot.items) && attach.snapshot.queuedTurns.length === 0);
  await owner.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  remoteRelay = createDesktopRelay(owner, remoteMcpExecutions, { holdCloseCall: true });
  await remoteRelay.addSession(created.session.id);
  const advertisedTools = relayAdvertisements.at(-1)?.params?.tools ?? [];
  record(
    "desktop-relay-advertises-global-user-mcp-only",
    advertisedTools.length === 1 && advertisedTools[0]?.name === "mcp_global_lookup" && advertisedTools[0]?.workspaceFree === true,
    shortJson(advertisedTools.map(({ name, workspaceFree }) => ({ name, workspaceFree }))),
  );

  const files = await owner.client.request("workspace/list", { sessionId: created.session.id, path: "" });
  const readme = await owner.client.request("workspace/read", { sessionId: created.session.id, path: "README.md" });
  record("workspace-reads-execute-on-host", files.entries.some((entry) => entry.name === "README.md") && readme.kind === "text" && readme.content.includes("remote project"));
  let escape = null;
  try {
    await owner.client.request("workspace/read", { sessionId: created.session.id, path: "../../etc/passwd" });
  } catch (error) {
    escape = errorCodeOf(error);
  }
  record("workspace-read-refuses-escape", escape === "REMOTE_PATH_FORBIDDEN", String(escape));
  const diff = await owner.client.request("workspace/diff", { sessionId: created.session.id });
  record("remote-review-starts-from-clean-host-repository", diff.repo === true && diff.clean === true && diff.files.length === 0);

  // Remote terminals belong to the Host and are scoped to the session root.
  // Drop the successful open response, then retry its id from another
  // connection to recover the PTY without creating a duplicate.
  const openRequestId = "remote-host-e2e-terminal-open";
  const lostOpen = client(url, paired.deviceToken, {
    transport: droppingTerminalOpenResponseTransport(url, paired.deviceToken, openRequestId),
    requestTimeoutMs: 300,
  });
  await lostOpen.client.connect();
  await lostOpen.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  let lostOpenError = null;
  try {
    await lostOpen.client.request("terminal/open", {
      sessionId: created.session.id,
      cols: 100,
      rows: 30,
      openRequestId,
    });
  } catch (error) {
    lostOpenError = errorCodeOf(error);
  }
  const openEventSeen = await waitForEvent(
    lostOpen.events,
    0,
    (event) => event.kind === "terminal.changed" && event.payload?.state === "open",
    5_000,
  );
  const originalTerminalId = lostOpen.events.find(
    (event) => event.kind === "terminal.changed" && event.payload?.state === "open",
  )?.payload?.terminalId;
  record(
    "remote-terminal-open-response-can-be-lost",
    lostOpenError === "TIMEOUT" && openEventSeen && typeof originalTerminalId === "string",
    String(lostOpenError),
  );
  if (typeof originalTerminalId !== "string") throw new Error("terminal did not open before its response was dropped");

  const replacement = client(url, paired.deviceToken);
  await replacement.client.connect();
  await replacement.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  const terminal = await replacement.client.request("terminal/open", {
    sessionId: created.session.id,
    openRequestId,
  });
  record("remote-terminal-open-request-reattaches", terminal.terminalId === originalTerminalId);
  const sessionRoot = realpathSync(project);
  const terminalOutputStart = replacement.events.length;
  await replacement.client.request("terminal/input", {
    terminalId: originalTerminalId,
    data: Buffer.from("pwd\n").toString("base64"),
  });
  let terminalOutput = "";
  const terminalOutputReady = await waitForEvent(replacement.events, terminalOutputStart, () => {
    terminalOutput = replacement.events
      .slice(terminalOutputStart)
      .filter((event) => event.kind === "terminal.output" && event.payload?.terminalId === originalTerminalId)
      .map((event) => Buffer.from(event.payload.data, "base64").toString("utf8"))
      .join("");
    return terminalOutput.includes(project) || terminalOutput.includes(sessionRoot);
  });
  record(
    "remote-terminal-runs-in-session-root",
    terminalOutputReady && (terminalOutput.includes(project) || terminalOutput.includes(sessionRoot)),
    terminalOutputReady ? "Host PTY reported the session root" : "terminal output timed out",
  );

  const terminalResumeClient = client(url, paired.deviceToken);
  await terminalResumeClient.client.connect();
  await terminalResumeClient.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  const reattached = await terminalResumeClient.client.request("terminal/open", {
    sessionId: created.session.id,
    openRequestId,
  });
  record(
    "remote-terminal-output-replays",
    reattached.terminalId === originalTerminalId &&
      (Buffer.from(reattached.replay, "base64").toString("utf8").includes(project) ||
        Buffer.from(reattached.replay, "base64").toString("utf8").includes(sessionRoot)),
  );
  let staleInput = null;
  try {
    await replacement.client.request("terminal/input", {
      terminalId: originalTerminalId,
      data: Buffer.from("echo stale\n").toString("base64"),
    });
  } catch (error) {
    staleInput = errorCodeOf(error);
  }
  record("remote-terminal-old-connection-is-detached", staleInput === "NOT_FOUND", String(staleInput));
  let staleResize = null;
  try {
    await replacement.client.request("terminal/resize", { terminalId: originalTerminalId, cols: 101, rows: 31 });
  } catch (error) {
    staleResize = errorCodeOf(error);
  }
  record("remote-terminal-old-connection-cannot-resize", staleResize === "NOT_FOUND", String(staleResize));
  let staleClose = null;
  try {
    await replacement.client.request("terminal/close", { terminalId: originalTerminalId });
  } catch (error) {
    staleClose = errorCodeOf(error);
  }
  record("remote-terminal-old-connection-cannot-close", staleClose === "NOT_FOUND", String(staleClose));

  const reviewEditStart = terminalResumeClient.events.length;
  await terminalResumeClient.client.request("terminal/input", {
    terminalId: originalTerminalId,
    data: Buffer.from("printf 'remote review edit\\n' > remote-review.txt; printf '__REMOTE_REVIEW_EDIT_DONE__\\n'\n").toString("base64"),
  });
  let reviewTerminalOutput = "";
  const reviewEditReady = await waitForEvent(terminalResumeClient.events, reviewEditStart, () => {
    reviewTerminalOutput = terminalResumeClient.events
      .slice(reviewEditStart)
      .filter((event) => event.kind === "terminal.output" && event.payload?.terminalId === originalTerminalId)
      .map((event) => Buffer.from(event.payload.data, "base64").toString("utf8"))
      .join("");
    return reviewTerminalOutput.includes("__REMOTE_REVIEW_EDIT_DONE__");
  });
  const refreshedFiles = await owner.client.request("workspace/list", { sessionId: created.session.id, path: "" });
  const refreshedRead = await owner.client.request("workspace/read", { sessionId: created.session.id, path: "remote-review.txt" });
  const refreshedDiff = await owner.client.request("workspace/diff", { sessionId: created.session.id });
  record(
    "remote-files-and-review-refresh-after-host-edit",
    reviewEditReady && refreshedFiles.entries.some((entry) => entry.name === "remote-review.txt") &&
      refreshedRead.kind === "text" && refreshedRead.content === "remote review edit\n" &&
      refreshedDiff.repo === true && refreshedDiff.clean === false &&
      refreshedDiff.files.some((file) => file.path === "remote-review.txt" && file.status === "untracked"),
    shortJson(refreshedDiff.files.map(({ path, status }) => ({ path, status }))),
  );
  await terminalResumeClient.client.request("terminal/close", { terminalId: originalTerminalId });
  await lostOpen.client.close();
  await replacement.client.close();
  await terminalResumeClient.client.close();

  // No provider is configured: the turn must fail closed with a typed code and leave the session idle.
  let turnError = null;
  try {
    await owner.client.request("turn/start", { sessionId: created.session.id, input: { text: "hello" }, context: { requestId: "r1", idempotencyKey: "e2e-1" } });
  } catch (error) {
    turnError = errorCodeOf(error);
  }
  record("turn-without-provider-fails-closed", turnError === "MODEL_NOT_CONFIGURED", String(turnError));
  await sleep(200);
  const after = await owner.client.request("session/get", { sessionId: created.session.id });
  record("failed-admission-leaves-session-idle", after.session.status === "idle" && !after.session.activeTurnId, shortJson(after.session));

  // E2E-REMOTE-provider-import-enables-turn (D626): a provider imported over the
  // admin socket unblocks the turn without a second host-core.
  const importPayload = {
    version: 1,
    providers: [
      {
        sourceId: "src-a",
        input: {
          name: "Remote mock",
          vendorKey: "custom",
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          authKind: "api_key_and_base_url",
          apiStyle: "chat_completions",
          secretValue: KEY_MARKER,
          models: [{ id: "mock-model", contextWindow: 128000, maxTokens: 8192, thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
        },
      },
    ],
    defaultModel: { sourceId: "src-a", modelId: "mock-model" },
  };
  const firstImport = await importProviders(importPayload);
  const importLine = firstImport.out.split("\n").find((line) => line.startsWith("PI_HOST_PROVIDERS "));
  const importSummary = importLine ? JSON.parse(importLine.slice("PI_HOST_PROVIDERS ".length)) : null;
  record(
    "provider-import-creates-and-sets-default",
    firstImport.code === 0 && importSummary?.imported?.[0]?.action === "created" && importSummary.defaultSet === true,
    shortJson(importSummary),
  );
  record(
    "provider-import-never-echoes-the-key",
    !firstImport.out.includes(KEY_MARKER) && !firstImport.err.includes(KEY_MARKER) && !stderr.includes(KEY_MARKER),
  );
  const socketStat = statSync(join(dataDir, "pi-host", "admin.sock"));
  const dirStat = statSync(join(dataDir, "pi-host"));
  record(
    "admin-socket-is-owner-only",
    (socketStat.mode & 0o777) === 0o600 && (dirStat.mode & 0o777) === 0o700,
    `sock=${(socketStat.mode & 0o777).toString(8)} dir=${(dirStat.mode & 0o777).toString(8)}`,
  );
  const secondImport = await importProviders(importPayload);
  const secondLine = secondImport.out.split("\n").find((line) => line.startsWith("PI_HOST_PROVIDERS "));
  const secondSummary = secondLine ? JSON.parse(secondLine.slice("PI_HOST_PROVIDERS ".length)) : null;
  record(
    "provider-reimport-updates-not-duplicates",
    secondImport.code === 0 &&
      secondSummary?.imported?.[0]?.action === "updated" &&
      secondSummary.imported[0].providerId === importSummary?.imported?.[0]?.providerId,
    shortJson(secondSummary),
  );

  const beforeTurn = owner.events.length;
  await owner.client.request("turn/start", { sessionId: created.session.id, input: { text: "hello" }, context: { requestId: "r2", idempotencyKey: "e2e-2" } });
  const turnDone = await waitForEvent(
    owner.events,
    beforeTurn,
    (event) => event.scope === "session" && (event.kind === "turn.completed" || event.kind === "turn.failed"),
  );
  const late = owner.events.slice(beforeTurn);
  const completed = late.some((event) => event.kind === "turn.completed");
  record("imported-provider-admits-the-turn", turnDone && completed, late.map((event) => event.kind).join(","));
  record("imported-key-reaches-the-model-as-bearer", modelAuth.length > 0 && modelAuth.every((auth) => auth === `Bearer ${KEY_MARKER}`), modelAuth.length ? "recorded" : "no model call");
  await sleep(200);
  const afterTurn = await owner.client.request("session/get", { sessionId: created.session.id });
  record("session-returns-to-idle-after-reply", afterTurn.session.status === "idle" && !afterTurn.session.activeTurnId, shortJson(afterTurn.session));

  const mcpTurnStart = modelRequests.length;
  const mcpEventsStart = owner.events.length;
  await owner.client.request("turn/start", {
    sessionId: created.session.id,
    input: { text: "remote-mcp-success" },
    context: { requestId: "r-mcp-1", idempotencyKey: "e2e-mcp-1" },
  });
  const mcpTurnDone = await waitForEvent(owner.events, mcpEventsStart, (event) =>
    event.scope === "session" && (event.kind === "turn.completed" || event.kind === "turn.failed"),
  );
  const mcpTurnEvents = owner.events.slice(mcpEventsStart);
  const mcpPromptBodies = modelRequests.slice(mcpTurnStart);
  const mcpToolWasPrompted = mcpPromptBodies.some((request) =>
    JSON.stringify(request.tools ?? request.functions ?? []).includes("mcp_global_lookup"),
  );
  const mcpResultReachedModel = mcpPromptBodies.some((request) =>
    JSON.stringify(request.messages ?? []).includes("desktop MCP result: remote-notes"),
  );
  const mcpRelaySucceeded = mcpTurnDone && mcpTurnEvents.some((event) => event.kind === "turn.completed") &&
    mcpToolWasPrompted && mcpResultReachedModel && remoteMcpExecutions.some((call) =>
      call.fullName === "mcp_global_lookup" && call.projectPath === null && call.args?.query === "remote-notes",
    );
  record(
    "remote-turn-calls-desktop-global-mcp-and-returns-result",
    mcpRelaySucceeded,
    shortJson(mcpRelaySucceeded
      ? { modelCalls: mcpPromptBodies.length, desktopCalls: remoteMcpExecutions.length }
      : {
          modelCalls: mcpPromptBodies.length,
          modelTools: mcpPromptBodies.map((request) => (request.tools ?? request.functions ?? []).map((tool) => tool.function?.name ?? tool.name)),
          serverRequests: desktopServerRequests.slice(-2),
          relayLogs: relayLogs.slice(-2),
          desktopCalls: remoteMcpExecutions.length,
          eventKinds: mcpTurnEvents.map((event) => event.kind),
        }),
  );

  const closeTurnStart = modelRequests.length;
  await owner.client.request("turn/start", {
    sessionId: created.session.id,
    input: { text: "remote-mcp-close" },
    context: { requestId: "r-mcp-2", idempotencyKey: "e2e-mcp-2" },
  });
  let heldCallTimer;
  try {
    await Promise.race([
      heldMcpCallStarted,
      new Promise((_, reject) => {
        heldCallTimer = setTimeout(() => reject(new Error("desktop MCP call did not start")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(heldCallTimer);
  }

  replacementOwner = client(url, paired.deviceToken, {
    onServerRequest: async (method, params) => {
      desktopServerRequests.push({ method, params });
      if (!replacementRelay) throw new Error("replacement desktop relay is not ready");
      try {
        return await replacementRelay.handleServerRequest(method, params);
      } catch (error) {
        relayLogs.push({ level: "error", message: "Replacement server request failed", data: String(error) });
        throw error;
      }
    },
  });
  await replacementOwner.client.connect();
  await replacementOwner.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  replacementRelay = createDesktopRelay(replacementOwner, replacementMcpExecutions);
  await replacementRelay.addSession(created.session.id);
  const closeEventsStart = replacementOwner.events.length;
  let configureWhileRunning = null;
  try {
    await replacementOwner.client.request("session/configure", {
      sessionId: created.session.id,
      mode: "plan",
    });
  } catch (error) {
    configureWhileRunning = errorCodeOf(error);
  }
  record("session-configure-is-rejected-while-running", configureWhileRunning === "CONFLICT", String(configureWhileRunning));

  // Closing the original Desktop relay cancels the held MCP call. Closing its
  // RACP socket makes the Host fail the pinned execution instead of rerouting
  // it to a replacement owner that advertises the same tool name.
  remoteRelay.close();
  await owner.client.close();
  const closeTurnDone = await waitForEvent(replacementOwner.events, closeEventsStart, (event) =>
    event.scope === "session" && (event.kind === "turn.completed" || event.kind === "turn.failed"),
  );
  const closeTurnEvents = replacementOwner.events.slice(closeEventsStart);
  const closeTurnBodies = modelRequests.slice(closeTurnStart);
  const closeCallFailed = closeTurnBodies.some((request) => {
    const serialized = JSON.stringify(request.messages ?? []);
    return serialized.includes("TOOL_FAILED") || serialized.includes("HOST_DISCONNECTED");
  });
  record(
    "closing-desktop-fails-in-flight-mcp-without-aborting-turn",
    closeTurnDone && closeTurnEvents.some((event) => event.kind === "turn.completed") && closeCallFailed,
    shortJson({ modelCalls: closeTurnBodies.length, replacementCalls: replacementMcpExecutions.length }),
  );
  record(
    "in-flight-tool-is-not-rerouted-to-replacement-owner",
    replacementMcpExecutions.length === 0,
    `replacement executions=${replacementMcpExecutions.length}`,
  );
  releaseHeldMcpCall?.({ content: [{ type: "text", text: "late desktop result" }] });
  releaseHeldMcpCall = null;
  activeOwner = replacementOwner;

  const renamed = await activeOwner.client.request("session/rename", { sessionId: created.session.id, title: "Renamed remotely" });
  const planMode = await activeOwner.client.request("session/configure", { sessionId: created.session.id, mode: "plan" });
  const agentMode = await activeOwner.client.request("session/configure", { sessionId: created.session.id, mode: "agent" });
  const configured = await activeOwner.client.request("session/configure", { sessionId: created.session.id, permissionMode: "accept-edits" });
  record(
    "remote-host-profile-mutations",
    renamed.ok === true && planMode.session.mode === "plan" && agentMode.session.mode === "agent" &&
      configured.session.permissionMode === "accept-edits",
  );
  await sleep(200);
  const hostKinds = [...owner.events, ...activeOwner.events].filter((event) => event.scope === "host").map((event) => event.kind);
  record("host-scope-events-announce-session-changes", hostKinds.includes("session.created") && hostKinds.includes("session.changed"), hostKinds.join(","));

  // Reconnect by cursor: the desktop-side transport drops, the Host keeps everything.
  const cursor = activeOwner.client.cursorFor(created.session.id);
  const states = [];
  const owner2 = client(url, paired.deviceToken, { onStateChange: (state) => states.push(state) });
  await owner2.client.connect();
  const resumed = await owner2.client.request("session/attach", { sessionId: created.session.id, after: cursor });
  record("reconnect-resumes-by-cursor", resumed.replayComplete === true && resumed.session.title === "Renamed remotely", shortJson({ cursor, title: resumed.session.title }));
  const stale = await owner2.client.request("session/attach", { sessionId: created.session.id, after: { epoch: "ep_old", sequence: 3 } });
  record("stale-epoch-yields-snapshot", stale.replayComplete === false && stale.resyncReason === "epoch" && stale.snapshot !== undefined);
  await owner2.client.close();

  // Viewer role from a second pairing is refused the owner operations.
  let forbidden = null;
  const devices = await activeOwner.client.request("session/revoke", { deviceId: "dev_unknown" });
  record("revoke-unknown-device-is-false", devices.revoked === false);
  try {
    await activeOwner.client.request("host/list", {});
  } catch (error) {
    forbidden = errorCodeOf(error);
  }
  record("host-list-is-gateway-only", forbidden === "METHOD_NOT_FOUND", String(forbidden));

  await activeOwner.client.request("session/delete", { sessionId: created.session.id });
  const gone = await activeOwner.client.request("session/list");
  record("session-delete-removes-on-host", !gone.sessions.some((session) => session.id === created.session.id));
  replacementRelay.close();
  await activeOwner.client.close();

  // Restart: identity and the paired device survive; a fresh epoch resyncs.
  await stopHost();
  const again = await startHost();
  record("host-identity-is-stable-across-restarts", again.info.hostId === ready.info.hostId, `${ready.info.hostId} vs ${again.info.hostId}`);
  const owner3 = client(`ws://127.0.0.1:${again.info.port}/v1/racp/ws`, paired.deviceToken);
  const init3 = await owner3.client.connect();
  record("device-credential-survives-restart", init3.principal.roles.includes("owner"));
  await owner3.client.close();
} catch (error) {
  record("headless-remote-host-e2e", false, `${error?.message ?? error}\n${stderr.slice(-3000)}`);
} finally {
  remoteRelay?.close();
  replacementRelay?.close();
  await replacementOwner?.client.close();
  await activeOwner?.client.close();
  await stopHost();
  modelServer.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) exitCode = 1;
process.exit(exitCode);
