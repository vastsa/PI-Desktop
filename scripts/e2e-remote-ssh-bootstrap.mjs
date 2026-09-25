#!/usr/bin/env node
/**
 * Linux x64 SSH bootstrap integration check (E2E-231).
 *
 * Opt in with PI_DESKTOP_E2E_SSHD_SUDO=1 on a Linux x64 runner with
 * openssh-server, ssh-keygen, curl, tar, and a release host-core binary. It
 * starts an isolated sshd, builds a local pi-host release archive, serves it
 * from loopback, runs the real desktop bootstrap/system SSH/tunnel/pairing
 * path, and checks project and session reads over RACP.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { register } from "node:module";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(join(root, "apps/desktop/test/helpers/ts-import-hooks.mjs")));

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("E2E-231 SSH bootstrap requires a Linux x64 runner");
}
if (process.env.PI_DESKTOP_E2E_SSHD_SUDO !== "1") {
  throw new Error("set PI_DESKTOP_E2E_SSHD_SUDO=1 to opt in to the isolated sudo sshd fixture");
}

const { createSshBootstrap } = await import(
  "../apps/desktop/electron/main/remote/ssh-bootstrap.ts"
);
const { createSystemSshTransport } = await import(
  "../apps/desktop/electron/main/remote/ssh-transport.ts"
);
const { RacpClient, wsClientTransport } = await import("../packages/racp/dist/index.js");

const configuredTimeout = Number(process.env.PI_DESKTOP_E2E_SSH_TIMEOUT_MS ?? 180_000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 180_000;
const runRoot = mkdtempSync(join(tmpdir(), "pi-remote-ssh-e2e-"));
const remoteHome = join(runRoot, "remote-home");
const clientHome = join(runRoot, "client-home");
const sshHome = join(clientHome, ".ssh");
const remoteBin = join(remoteHome, "bin");
let bundleDir = "";
const fixtureDir = join(runRoot, "fixture");
const projectDir = join(remoteHome, "workspace", "remote-project");
const sshdConfig = join(runRoot, "sshd_config");
const hostKey = join(runRoot, "sshd_host_key");
const clientKey = join(sshHome, "id_ed25519");
const authorizedKeys = join(runRoot, "authorized_keys");
const fixtureAssetRequests = [];
const transports = new Set();
const racpClients = new Set();
let sshdProcess = null;
let sshdPid = null;
let fixtureServer = null;
let ownerClient = null;
let bootstrapOutcome = null;
let fixturePort = 0;
let sshdPort = 0;
let sudoBinary = null;
let recoveryForward = null;
let modelServer = null;
let modelReleaseResponse = null;
let sshTarget = null;
let remoteContext = null;
let modelRequestCount = 0;
let modelStartedPromise = null;
let modelStartedResolve = null;
let modelResponseSentPromise = null;
let modelResponseSentResolve = null;

function log(message) {
  process.stdout.write(`[remote-ssh-e2e] ${message}\n`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? timeoutMs,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim().slice(-3000);
    throw new Error(`${command} ${args.join(" ")} failed (status ${result.status}): ${detail}`);
  }
  return result.stdout;
}

function requireExecutable(candidates, label) {
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`${label} not found; checked ${candidates.join(", ")}`);
  return path;
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForPort(port, label, child, waitMs = 15_000) {
  const deadline = Date.now() + waitMs;
  let lastError = "not listening";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited early (${child.exitCode})`);
    }
    try {
      await new Promise((resolveConnect, rejectConnect) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolveConnect(); });
        socket.once("error", (error) => { socket.destroy(); rejectConnect(error); });
      });
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`${label} did not listen on 127.0.0.1:${port}: ${lastError}`);
}

async function startFixtureServer() {
  fixtureServer = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname.slice(1));
    if (request.method !== "GET" || ![artifactName, `${artifactName}.sha256`].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    fixtureAssetRequests.push(name);
    const path = join(fixtureDir, name);
    if (!existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": statSync(path).size,
    });
    createReadStream(path).pipe(response);
  });
  await new Promise((resolveListen, rejectListen) => {
    fixtureServer.once("error", rejectListen);
    fixtureServer.listen(0, "127.0.0.1", resolveListen);
  });
  fixturePort = fixtureServer.address().port;
}

async function startModelFixture() {
  let releaseResponse;
  const responseGate = new Promise((resolveResponse) => { releaseResponse = resolveResponse; });
  modelReleaseResponse = releaseResponse;
  modelServer = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once("end", async () => {
      modelRequestCount += 1;
      modelStartedResolve?.();
      await responseGate;
      if (response.destroyed) return;
      const chunk = { id: "remote-ssh-e2e-turn", object: "chat.completion.chunk", created: 1, model: "mock-model" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "SSH reconnect turn completed" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      modelResponseSentResolve?.();
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    modelServer.once("error", rejectListen);
    modelServer.listen(0, "127.0.0.1", resolveListen);
  });
  return modelServer.address().port;
}

function armModelWaiters() {
  modelStartedPromise = new Promise((resolveStarted) => { modelStartedResolve = resolveStarted; });
  modelResponseSentPromise = new Promise((resolveSent) => { modelResponseSentResolve = resolveSent; });
}

async function waitUntil(predicate, label, waitMs = 20_000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} timed out`);
}

function withTimeout(promise, label, waitMs) {
  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => rejectResult(new Error(`${label} timed out`)), waitMs);
    promise.then(
      (value) => { clearTimeout(timer); resolveResult(value); },
      (error) => { clearTimeout(timer); rejectResult(error); },
    );
  });
}

function eventText(envelope) {
  if (envelope.kind !== "terminal.output" || typeof envelope.payload?.data !== "string") return "";
  return Buffer.from(envelope.payload.data, "base64").toString("utf8");
}

function errorCode(error) {
  return error?.errorCode ?? error?.code ?? "";
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolveClose();
    }, 3_000);
    child.once("close", () => { clearTimeout(timer); resolveClose(); });
  });
  log(`stopped ${label}`);
}

function makeRemoteWrappers({ curlBinary, expectedReleaseUrl }) {
  const curlShim = join(remoteBin, "curl");
  writeFileSync(curlShim, `#!/bin/sh
set -eu
[ "$#" -eq 6 ] && [ "$1" = "-fsSL" ] && [ "$2" = "--max-time" ] && [ "$3" = "600" ] && [ "$4" = "-o" ] || exit 64
[ "$6" = ${shellQuote(expectedReleaseUrl)} ] || exit 65
exec ${shellQuote(curlBinary)} -fsSL --max-time 600 -o "$5" ${shellQuote(`http://127.0.0.1:${fixturePort}/${artifactName}`)}
`);
  chmodSync(curlShim, 0o700);

  // Put the isolated home before ordinary system tools, while retaining the
  // runner's Node.js location through an explicit symlink in remoteBin.
  symlinkSync(realpathSync(process.execPath), join(remoteBin, "node"));
  const wrapper = join(runRoot, "force-command");
  writeFileSync(wrapper, `#!/bin/sh
set -eu
export HOME=${shellQuote(remoteHome)}
export PATH=${shellQuote(`${remoteBin}:/usr/local/bin:/usr/bin:/bin`)}
unset SSH_AUTH_SOCK SSH_AGENT_PID
case "\${SSH_ORIGINAL_COMMAND:-}" in
  'uname -s && uname -m') exec /bin/sh -c 'uname -s && uname -m' ;;
  'sh -s') exec /bin/sh -s ;;
  *) printf '%s\\n' 'E2E sshd rejected an unexpected remote command' >&2; exit 126 ;;
esac
`);
  chmodSync(wrapper, 0o700);
  return wrapper;
}

async function configureSshd(forceCommand) {
  sshdPort = await reservePort();
  const user = run("id", ["-un"]).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`unsupported local account name: ${user}`);
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`), { mode: 0o600 });
  chmodSync(authorizedKeys, 0o600);
  writeFileSync(sshdConfig, [
    `Port ${sshdPort}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKey}`,
    `PidFile ${join(runRoot, "sshd.pid")}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    `AllowUsers ${user}`,
    `ForceCommand ${forceCommand}`,
    "PubkeyAuthentication yes",
    "AuthenticationMethods publickey",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin prohibit-password",
    "AllowTcpForwarding local",
    "PermitOpen 127.0.0.1:*",
    "GatewayPorts no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTTY no",
    "PermitUserEnvironment no",
    "UsePAM no",
    "UseDNS no",
    "PrintMotd no",
    "StrictModes yes",
    "LogLevel ERROR",
  ].join("\n") + "\n", { mode: 0o600 });
  chmodSync(sshdConfig, 0o600);

  const sudo = requireExecutable(["/usr/bin/sudo", "/bin/sudo"], "sudo");
  sudoBinary = sudo;
  const daemon = requireExecutable(["/usr/sbin/sshd", "/sbin/sshd"], "sshd");
  run(sudo, ["-n", daemon, "-t", "-f", sshdConfig]);
  sshdProcess = spawn(sudo, ["-n", daemon, "-D", "-e", "-f", sshdConfig], {
    cwd: runRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: clientHome },
  });
  let stderr = "";
  sshdProcess.stderr.setEncoding("utf8");
  sshdProcess.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  sshdProcess.once("error", (error) => { stderr += `\n${error.message}`; });
  await waitForPort(sshdPort, "isolated sshd", sshdProcess).catch((error) => {
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
  });
  const pidPath = join(runRoot, "sshd.pid");
  const pidText = readFileSync(pidPath, "utf8").trim();
  if (!/^\d+$/.test(pidText)) throw new Error("sshd wrote an invalid pid file");
  sshdPid = Number(pidText);
}

function createTransport(target) {
  const ssh = requireExecutable(["/usr/bin/ssh", "/bin/ssh"], "ssh");
  const wrapper = join(runRoot, "isolated-ssh");
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${shellQuote(clientHome)}\nexport PATH=${shellQuote(`${clientHome}/bin:/usr/bin:/bin`)}\nunset SSH_AUTH_SOCK SSH_AGENT_PID\nexec ${shellQuote(ssh)} -F /dev/null "$@"\n`);
    chmodSync(wrapper, 0o700);
  }
  const transport = createSystemSshTransport(target, { binary: wrapper });
  transports.add(transport);
  return transport;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function client(url, token, options = {}) {
  const racp = new RacpClient({
    transport: wsClientTransport({ url, token, connectTimeoutMs: 10_000 }),
    client: { name: "PI-Desktop remote SSH E2E", version },
    requestTimeoutMs: 15_000,
    ...options,
  });
  racpClients.add(racp);
  return racp;
}

async function pairAndRead({ url, pairingToken, label }) {
  const pairing = client(url, pairingToken);
  let deviceToken;
  try {
    await pairing.connect();
    const paired = await pairing.request("connection/pair", { deviceLabel: label });
    deviceToken = paired.deviceToken;
    assert.match(deviceToken, /^pdt1\./, "pairing must return a durable device token");
  } finally {
    await pairing.close();
  }

  ownerClient = client(url, deviceToken);
  await ownerClient.connect();
  const project = await ownerClient.request("project/register", { path: projectDir });
  assert.equal(project.project.label, "remote-project");
  const created = await ownerClient.request("session/create", {
    title: "SSH bootstrap E2E",
    projectId: project.project.id,
    permissionMode: "ask",
  });
  const sessions = await ownerClient.request("session/list");
  assert.ok(sessions.sessions.some((session) => session.id === created.session.id));
  const attached = await ownerClient.request("session/attach", { sessionId: created.session.id });
  assert.equal(attached.replayComplete, true);
  const listing = await ownerClient.request("workspace/list", { sessionId: created.session.id, path: "" });
  assert.ok(listing.entries.some((entry) => entry.name === "README.md"));
  const read = await ownerClient.request("workspace/read", { sessionId: created.session.id, path: "README.md" });
  assert.equal(read.kind, "text");
  assert.match(read.content, /SSH bootstrap fixture/);
  return { deviceToken, sessionId: created.session.id, projectId: project.project.id };
}

async function importMockProvider(modelPort) {
  const dataDir = join(remoteHome, ".pi-desktop");
  const cli = join(dataDir, "pi-host/current/pi-host.js");
  const importPayload = {
    version: 1,
    providers: [{
      sourceId: "remote-ssh-fixture",
      input: {
        name: "Remote SSH fixture model",
        vendorKey: "custom",
        type: "openai_compatible",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        authKind: "api_key_and_base_url",
        apiStyle: "chat_completions",
        secretValue: "remote-ssh-e2e-dummy-key",
        models: [{
          id: "mock-model",
          contextWindow: 128_000,
          maxTokens: 8192,
          thinkingLevels: ["off"],
          defaultThinkingLevel: "off",
        }],
      },
    }],
    defaultModel: { sourceId: "remote-ssh-fixture", modelId: "mock-model" },
  };
  const script = [
    "set -eu",
    `printf '%s' ${shellQuote(JSON.stringify(importPayload))} | node ${shellQuote(cli)} provider-import --data-dir ${shellQuote(dataDir)}`,
    "",
  ].join("\n");
  const transport = createTransport(sshTarget);
  try {
    const result = await transport.execWithInput("sh -s", script, { timeoutMs: 30_000 });
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("PI_HOST_PROVIDERS "));
    const summary = line ? JSON.parse(line.slice("PI_HOST_PROVIDERS ".length)) : null;
    assert.equal(result.code, 0);
    assert.equal(summary?.defaultSet, true, "fixture provider must become the Host default");
  } finally {
    transport.dispose();
    transports.delete(transport);
  }
}

async function runSshReconnectScenario() {
  const { deviceToken, sessionId } = remoteContext;
  const url = bootstrapOutcome.url;
  const states = [];
  const terminalStates = [];
  const recoveredEvents = [];
  const terminalEvents = [];
  const recoveryState = { result: null, error: null };
  let resolveRecovery;
  const recoveryDone = new Promise((resolveDone) => { resolveRecovery = resolveDone; });
  let turnId = "";

  const recoveringClient = client(url, deviceToken, {
    reconnect: { enabled: true, baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 240 },
    onStateChange: (state) => states.push(state),
    onEvent: (event) => recoveredEvents.push(event),
    onReconnected: async (connected) => {
      try {
        const cursor = connected.cursorFor(sessionId);
        const subscription = await connected.request("events/subscribe", {
          scope: "session",
          sessionId,
          ...(cursor ? { after: cursor } : {}),
        });
        const attached = await connected.request("session/attach", {
          sessionId,
          ...(cursor ? { after: cursor } : {}),
        });
        const turn = await connected.request("turn/get", { turnId });
        recoveryState.result = { cursor, subscription, attached, turn };
      } catch (error) {
        recoveryState.error = error;
      } finally {
        resolveRecovery();
      }
    },
  });
  await recoveringClient.connect();
  await recoveringClient.request("events/subscribe", { scope: "session", sessionId });
  await recoveringClient.request("session/configure", { sessionId, permissionMode: "accept-edits" });
  assert.ok(recoveringClient.cursorFor(sessionId), "session subscription must establish a durable cursor");

  const terminalClient = client(url, deviceToken, {
    reconnect: { enabled: true, baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 240 },
    onStateChange: (state) => terminalStates.push(state),
    onEvent: (event) => terminalEvents.push(event),
  });
  await terminalClient.connect();
  await terminalClient.request("events/subscribe", { scope: "session", sessionId });
  const openRequestId = `ssh-reconnect-${randomUUID()}`;
  const originalTerminal = await terminalClient.request("terminal/open", {
    sessionId,
    cols: 90,
    rows: 28,
    openRequestId,
  });
  const terminalId = originalTerminal.terminalId;
  const initialMarker = "SSH_RECONNECT_PTY_SURVIVES";
  await terminalClient.request("terminal/input", {
    terminalId,
    data: Buffer.from(`printf '${initialMarker}\\n'\n`).toString("base64"),
  });
  await waitUntil(
    () => terminalEvents.some((event) => eventText(event).includes(initialMarker)),
    "initial remote PTY output",
  );

  armModelWaiters();
  const started = await recoveringClient.request("turn/start", {
    sessionId,
    input: { text: "Hold this deterministic turn while the SSH tunnel reconnects." },
    context: { requestId: "ssh-reconnect-turn-start", idempotencyKey: "ssh-reconnect-turn-once" },
  });
  turnId = started.turn.id;
  await withTimeout(modelStartedPromise, "mock model request", 30_000);
  const cursorAtDrop = recoveringClient.cursorFor(sessionId);
  assert.ok(cursorAtDrop, "the running turn must have a resumable session cursor");

  const originalForward = bootstrapOutcome.forward;
  await originalForward.close();
  await waitUntil(() => states.includes("reconnecting"), "RACP reconnect after SSH forward loss");
  await waitUntil(() => terminalStates.includes("reconnecting"), "old terminal RACP connection close");

  // The sshd and Host share this Linux runner. A fixture-only local RACP
  // observer confirms completion was committed while the SSH route was down;
  // the Desktop-like client below must then replay it from its saved cursor.
  const directUrl = `ws://127.0.0.1:${bootstrapOutcome.ssh.remotePort}/v1/racp/ws`;
  const hostEvents = [];
  const monitor = client(directUrl, deviceToken, { onEvent: (event) => hostEvents.push(event) });
  await monitor.connect();
  const monitorCursor = await monitor.request("events/subscribe", {
    scope: "session",
    sessionId,
    after: cursorAtDrop,
  });
  assert.equal(monitorCursor.replayComplete, true);
  modelReleaseResponse?.();
  modelReleaseResponse = null;
  await withTimeout(modelResponseSentPromise, "mock model response", 30_000);
  await waitUntil(
    () => hostEvents.some((event) => event.kind === "turn.completed" && event.turnId === turnId),
    "Host turn completion during SSH outage",
    60_000,
  );
  await monitor.close();
  const requestsAfterTurn = modelRequestCount;
  assert.ok(requestsAfterTurn > 0, "completed turn must reach the deterministic local model");

  const localPort = originalForward.localPort;
  const recoveryTransport = createTransport(sshTarget);
  recoveryForward = await recoveryTransport.forward({
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: bootstrapOutcome.ssh.remotePort,
    timeoutMs: 30_000,
  });
  await withTimeout(recoveryDone, "RACP reconnect recovery", 30_000);
  if (recoveryState.error) throw recoveryState.error;
  const recovered = recoveryState.result;
  assert.ok(recovered, "reconnect callback must restore session state");
  assert.ok(recovered.cursor, "the reconnecting RACP client must retain its session cursor");
  assert.equal(recovered.cursor.epoch, cursorAtDrop.epoch, "the session cursor epoch must survive the tunnel drop");
  assert.ok(
    recovered.cursor.sequence >= cursorAtDrop.sequence,
    "the session cursor must not move backwards across the tunnel drop",
  );
  assert.equal(recovered.subscription.replayComplete, true, "session events must replay from the saved cursor");
  assert.equal(recovered.attached.replayComplete, true, "session attach must accept the saved cursor");
  assert.equal(recovered.attached.snapshot.session.status, "idle", "the running turn must settle during the outage");
  assert.equal(recovered.turn.turn.status, "completed");
  assert.ok(
    recoveredEvents.some((event) => event.kind === "turn.completed" && event.turnId === turnId),
    "the reconnecting RACP client must receive the missed turn completion",
  );
  log("PASS SSH tunnel recovery resumes the Host session cursor and completed turn");

  const repeated = await recoveringClient.request("turn/start", {
    sessionId,
    input: { text: "Hold this deterministic turn while the SSH tunnel reconnects." },
    context: { requestId: "ssh-reconnect-turn-retry", idempotencyKey: "ssh-reconnect-turn-once" },
  });
  assert.equal(repeated.turn.id, turnId, "retrying the idempotency key must not create another turn");
  assert.equal(modelRequestCount, requestsAfterTurn, "idempotent retry must not replay the turn prompt");

  const reattached = await recoveringClient.request("terminal/open", {
    sessionId,
    cols: 90,
    rows: 28,
    openRequestId,
  });
  assert.equal(reattached.terminalId, terminalId, "same openRequestId must attach the original PTY");
  assert.ok(
    Buffer.from(reattached.replay, "base64").toString("utf8").includes(initialMarker),
    "reattach must replay the existing terminal ring",
  );

  await waitUntil(
    () => terminalStates.includes("reconnecting") && terminalClient.state === "connected",
    "old terminal client reconnect without PTY attachment",
  );
  let staleClientError = "";
  try {
    await terminalClient.request("terminal/input", {
      terminalId,
      data: Buffer.from("echo stale-connection-must-not-write\n").toString("base64"),
    });
  } catch (error) {
    staleClientError = errorCode(error);
  }
  assert.equal(staleClientError, "NOT_FOUND", "the reconnected stale terminal client cannot send input");

  const afterMarker = "SSH_REATTACHED_PTY_ACCEPTS_INPUT";
  const outputStart = recoveredEvents.length;
  await recoveringClient.request("terminal/input", {
    terminalId,
    data: Buffer.from(`printf '${afterMarker}\\n'\n`).toString("base64"),
  });
  await waitUntil(
    () => recoveredEvents.slice(outputStart).some((event) => eventText(event).includes(afterMarker)),
    "reattached PTY output",
  );
  await recoveringClient.request("terminal/close", { terminalId });
  await Promise.all([terminalClient.close(), recoveringClient.close()]);
  log("PASS same openRequestId reattaches the PTY; a reconnected stale client cannot input");
}

async function stopRemoteHost() {
  if (!sshdProcess) return;
  const target = {
    host: "127.0.0.1",
    port: sshdPort,
    user: run("id", ["-un"]).trim(),
    identityFile: clientKey,
  };
  const transport = createTransport(target);
  const hostEntry = join(remoteHome, ".pi-desktop/pi-host/current/pi-host.js");
  const cleanup = [
    "set -eu",
    'pidfile="$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.pid"',
    `host_entry=${shellQuote(hostEntry)}`,
    'if [ -f "$pidfile" ]; then',
    '  pid=$(cat "$pidfile" 2>/dev/null || true)',
    "  case \"$pid\" in *[!0-9]*|'') pid='' ;; esac",
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
    '    command_line=$(tr \'\\000\' \' \' < "/proc/$pid/cmdline" 2>/dev/null || true)',
    '    case "$command_line" in',
    '      *"$host_entry"*)',
    '        kill -TERM "$pid" 2>/dev/null || true',
    "        waited=0",
    '        while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done',
    '        command_line=$(tr \'\\000\' \' \' < "/proc/$pid/cmdline" 2>/dev/null || true)',
    '        case "$command_line" in *"$host_entry"*) kill -KILL "$pid" 2>/dev/null || true ;; esac',
    "        ;;",
    "    esac",
    "  fi",
    "fi",
    "",
  ].join("\n");
  try {
    await transport.execWithInput("sh -s", cleanup, { timeoutMs: 20_000 });
  } catch (error) {
    log(`remote Host cleanup reported: ${error.message}`);
  } finally {
    transport.dispose();
    transports.delete(transport);
  }
  await bootstrapOutcome?.forward.close().catch(() => undefined);
  bootstrapOutcome = null;
}

async function stopOrphanedLocalHost() {
  // The SSH fixture runs on this same Linux machine. If SSH cleanup failed,
  // verify the PID file's exact entry point before signaling anything.
  const pidPath = join(remoteHome, ".pi-desktop/pi-host/.bootstrap/pi-host.pid");
  if (!existsSync(pidPath)) return;
  const pidText = readFileSync(pidPath, "utf8").trim();
  if (!/^\d+$/.test(pidText)) return;
  const pid = Number(pidText);
  const hostEntry = join(remoteHome, ".pi-desktop/pi-host/current/pi-host.js");
  const ownsHostProcess = () => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(hostEntry);
    } catch {
      return false;
    }
  };
  if (!ownsHostProcess()) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && ownsHostProcess()) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (ownsHostProcess()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  log(`stopped orphaned fixture Host pid ${pid}`);
}

async function cleanup() {
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      process.exitCode = 1;
      log(`${label} cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await attempt("RACP owner", async () => ownerClient?.close());
  ownerClient = null;
  modelReleaseResponse?.();
  modelReleaseResponse = null;
  for (const racp of racpClients) {
    await attempt("RACP connection", async () => racp.close());
  }
  racpClients.clear();
  await attempt("remote Host", stopRemoteHost);
  await attempt("orphaned Host", stopOrphanedLocalHost);
  await attempt("bootstrap forward", async () => bootstrapOutcome?.forward.close());
  bootstrapOutcome = null;
  await attempt("reconnected SSH forward", async () => recoveryForward?.close());
  recoveryForward = null;
  for (const transport of transports) {
    await attempt("SSH transport", async () => transport.dispose());
  }
  transports.clear();
  if (fixtureServer) {
    await attempt("release fixture", async () => new Promise((resolveClose) => fixtureServer.close(resolveClose)));
    fixtureServer = null;
  }
  if (modelServer) {
    await attempt("mock model fixture", async () => new Promise((resolveClose) => modelServer.close(resolveClose)));
    modelServer = null;
  }
  if (sshdPid && sudoBinary) {
    try {
      run(sudoBinary, ["-n", "kill", "-TERM", String(sshdPid)], { timeoutMs: 5_000 });
    } catch (error) {
      log(`sshd cleanup reported: ${error.message}`);
    }
  }
  await attempt("isolated sshd", async () => stopChild(sshdProcess, "isolated sshd"));
  sshdProcess = null;
  await attempt("temporary fixture directory", async () => rmSync(runRoot, { recursive: true, force: true }));
}

async function main() {
  mkdirSync(remoteHome, { recursive: true, mode: 0o700 });
  mkdirSync(remoteBin, { recursive: true, mode: 0o700 });
  mkdirSync(clientHome, { recursive: true, mode: 0o700 });
  mkdirSync(sshHome, { recursive: true, mode: 0o700 });
  chmodSync(remoteHome, 0o700);
  chmodSync(clientHome, 0o700);
  chmodSync(sshHome, 0o700);
  mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "README.md"), "# SSH bootstrap fixture\n", { mode: 0o600 });

  const desktopPackage = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
  const hostPackage = JSON.parse(readFileSync(join(root, "apps/pi-host/package.json"), "utf8"));
  version = desktopPackage.version;
  if (!version || hostPackage.version !== version) {
    throw new Error(`desktop/pi-host versions differ (${version} / ${hostPackage.version}); build a matching candidate`);
  }
  artifactName = `pi-host-${version}-linux-x64.tar.gz`;
  bundleDir = join(runRoot, basename(artifactName, ".tar.gz"));
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const configuredHost = process.env.PI_DESKTOP_HOST_BIN?.trim();
  const hostCore = configuredHost ? resolve(configuredHost) : requireExecutable([
    join(root, "target/release/pi-desktop-host-core"),
    join(root, "target/debug/pi-desktop-host-core"),
  ], "Linux host-core binary");
  if (!existsSync(hostCore)) throw new Error(`host-core binary not found: ${hostCore}`);
  run(process.execPath, [
    join(root, "apps/pi-host/scripts/bundle.mjs"),
    "--host-core", hostCore,
    "--platform", "linux",
    "--arch", "x64",
    "--out", bundleDir,
  ]);
  const archivePath = join(fixtureDir, artifactName);
  run("tar", ["-czf", archivePath, "-C", runRoot, basename(bundleDir)]);
  const digest = await sha256File(archivePath);
  writeFileSync(join(fixtureDir, `${artifactName}.sha256`), `${digest}  ${artifactName}\n`, { mode: 0o600 });

  const curlBinary = requireExecutable(["/usr/bin/curl", "/bin/curl"], "curl");
  await startFixtureServer();
  const modelPort = await startModelFixture();
  const releaseUrl = `https://github.com/vastsa/PI-Desktop/releases/download/v${version}/${artifactName}`;
  const forceCommand = makeRemoteWrappers({ curlBinary, expectedReleaseUrl: releaseUrl });
  await configureSshd(forceCommand);

  sshTarget = {
    label: "Isolated SSH fixture",
    host: "127.0.0.1",
    port: sshdPort,
    user: run("id", ["-un"]).trim(),
    identityFile: clientKey,
  };
  const bootstrap = createSshBootstrap({
    version,
    buildTransport: createTransport,
    fetchChecksum: async (url) => {
      assert.equal(url, `${releaseUrl}.sha256`, "bootstrap must resolve the pinned release checksum");
      const response = await fetch(`http://127.0.0.1:${fixturePort}/${artifactName}.sha256`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`local checksum fixture returned HTTP ${response.status}`);
      return await response.text();
    },
    exchangePairing: async (input) => {
      const projectSession = await pairAndRead(input);
      remoteContext = projectSession;
      log(`paired and read project/session over RACP (${projectSession.projectId}/${projectSession.sessionId})`);
      return projectSession.deviceToken;
    },
    onProgress: (step) => log(`bootstrap ${step}`),
    installTimeoutMs: timeoutMs,
    readyTimeoutSec: 60,
  });
  bootstrapOutcome = await bootstrap.bootstrap(sshTarget);
  assert.equal(bootstrapOutcome.ssh.version, version);
  assert.ok(fixtureAssetRequests.includes(artifactName), "remote curl must fetch the tarball from the local fixture");
  assert.deepEqual(
    fixtureAssetRequests,
    [`${artifactName}.sha256`, artifactName],
    "the desktop and remote must request only the pinned checksum and bundle",
  );
  log("PASS real SSH bootstrap, loopback tunnel, RACP pairing, project/session read");
  log(`SSH target used an isolated HOME under ${runRoot}; host release checksum ${digest}`);
  await importMockProvider(modelPort);
  await runSshReconnectScenario();
  await cleanup();
}

let version = "";
let artifactName = "";
try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(`[remote-ssh-e2e] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    if (existsSync(runRoot)) await cleanup();
  } catch (error) {
    process.exitCode = 1;
    console.error(`[remote-ssh-e2e] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
