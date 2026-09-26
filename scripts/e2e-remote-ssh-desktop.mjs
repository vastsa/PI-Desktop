#!/usr/bin/env node
/**
 * Real Desktop SSH E2E (E2E-231).
 *
 * This is separate from e2e-remote-ssh-bootstrap.mjs: that script validates
 * the headless bootstrap seam, while this one drives the production Settings
 * SSH form through Electron. It uses only loopback fixtures, a disposable
 * profile, a disposable SSH key, and a deterministic local model server.
 *
 * Opt in with PI_DESKTOP_E2E_SSHD_SUDO=1 on a Linux x64 runner with OpenSSH.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  assertDesktopBuild,
  repositoryRoot,
  resolveElectronBinary,
} from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("E2E-231 Desktop SSH requires a Linux x64 runner");
}
if (process.env.PI_DESKTOP_E2E_SSHD_SUDO !== "1") {
  throw new Error("set PI_DESKTOP_E2E_SSHD_SUDO=1 to opt in to the isolated sudo sshd fixture");
}

const { appDir } = assertDesktopBuild(root);
const electronBinary = resolveElectronBinary(root).electronBinary;
const hostCore = resolveHostBinary();
const runRoot = mkdtempSync(join(tmpdir(), "pi-remote-ssh-desktop-e2e-"));
const remoteHome = join(runRoot, "remote-home");
const clientHome = join(runRoot, "client-home");
const sshHome = join(clientHome, ".ssh");
const desktopDataDir = join(runRoot, "desktop-data");
const profileDir = join(runRoot, "electron-profile");
const browseRoot = join(remoteHome, "workspace");
// The SSH Host defaults its browse root to the disposable HOME. Keep the
// project as a direct child so the Settings picker exercises the real first
// browse step without relying on a second implicit directory click.
const projectDir = join(remoteHome, "remote-project");
const fixtureDir = join(runRoot, "fixture");
const remoteBin = join(remoteHome, "bin");
const sshdConfig = join(runRoot, "sshd_config");
const sshdHostKey = join(runRoot, "sshd_host_key");
const sshdPidFile = join(runRoot, "sshd.pid");
const clientKey = join(sshHome, "id_ed25519");
const authorizedKeys = join(runRoot, "authorized_keys");
const knownHosts = join(clientHome, "known_hosts");
const bundleOverride = process.env.PI_DESKTOP_HOST_BUNDLE_DIR?.trim();
const ownsBundle = !bundleOverride;
let bundleDir = bundleOverride ? resolve(bundleOverride) : "";
let cliPath = "";
let sidecarPath = "";

const writeFileName = "desktop-ssh-write.txt";
const writeFileContents = "written through the real Desktop SSH path\n";
const disconnectFileName = "desktop-ssh-disconnect.txt";
const disconnectFileContents = "written once after SSH reconnect\n";
const writeMarker = "REMOTE_SSH_DESKTOP_WRITE";
const disconnectMarker = "REMOTE_SSH_DESKTOP_APPROVAL_AFTER_DISCONNECT";
const queueHoldMarker = "REMOTE_SSH_DESKTOP_QUEUE_HOLD";
const queueAfterRestartMarker = "REMOTE_SSH_DESKTOP_QUEUE_AFTER_RESTART";
const terminalBeforeMarker = "REMOTE_SSH_TERMINAL_BEFORE_DROP";
const terminalAfterMarker = "REMOTE_SSH_TERMINAL_AFTER_DROP";
const apiKey = "pi-desktop-e2e-disposable-key";
const modelName = "remote-ssh-desktop-e2e-model";

let version = "";
let artifactName = "";
let releaseUrl = "";
let fixturePort = 0;
let sshdPort = 0;
let sudoBinary = "";
let sshdBinary = "";
let sshdProcess = null;
let sshdPid = null;
let fixtureServer = null;
let modelServer = null;
let localHostProcess = null;
let electronProcess = null;
let cdp = null;
let electronOutput = "";
let localHostOutput = "";
let pairingTokenForRedaction = "";
let heldModelReleases = [];
const modelRequests = [];

function redact(value) {
  let result = String(value ?? "").replaceAll(apiKey, "[redacted]");
  if (pairingTokenForRedaction) result = result.replaceAll(pairingTokenForRedaction, "[redacted]");
  return result;
}

function pass(id, detail = "") {
  console.log(`PASS ${id}${detail ? ` — ${detail}` : ""}`);
}

function assertCase(id, condition, detail = "") {
  if (!condition) throw new Error(`FAIL ${id}${detail ? ` — ${detail}` : ""}`);
  pass(id, detail);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180_000,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim().slice(-3000);
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${redact(detail)}`);
  }
  return result.stdout;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForChildExit(child, 5_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, 5_000);
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function waitForPort(port, label, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not listening";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited early (${child.exitCode})`);
    }
    try {
      await new Promise((resolveConnect, rejectConnect) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolveConnect();
        });
        socket.once("error", (error) => {
          socket.destroy();
          rejectConnect(error);
        });
      });
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`${label} did not listen on 127.0.0.1:${port}: ${lastError}`);
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} timed out`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name;
}

function streamCompletion(response, { toolCall, content, id }) {
  const completion = { id, object: "chat.completion.chunk", created: 1, model: modelName };
  const delta = toolCall
    ? {
        role: "assistant",
        tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: "Write", arguments: JSON.stringify(toolCall.args) } }],
      }
    : { role: "assistant", content };
  const finishReason = toolCall ? "tool_calls" : "stop";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function releaseHeldModels(marker) {
  const remaining = [];
  for (const held of heldModelReleases.splice(0)) {
    if (!marker || held.marker === marker) held.release();
    else remaining.push(held);
  }
  heldModelReleases.push(...remaining);
}

async function startModelFixture() {
  modelServer = createHttpServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelName, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const lastUser = [...messages].reverse().find((item) => item?.role === "user");
        const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
        const marker = [writeMarker, disconnectMarker, queueHoldMarker, queueAfterRestartMarker]
          .find((candidate) => prompt.includes(candidate)) ?? "unknown";
        const hasToolResult = messages.some((item) => item?.role === "tool");
        modelRequests.push({ marker, prompt, hasToolResult, authorization: request.headers.authorization ?? null, at: Date.now() });
        if (hasToolResult) {
          const content = marker === disconnectMarker ? "REMOTE_SSH_DESKTOP_DISCONNECT_COMPLETE" : "REMOTE_SSH_DESKTOP_WRITE_COMPLETE";
          streamCompletion(response, { content, id: `completion-${modelRequests.length}` });
          return;
        }
        if (marker === queueHoldMarker || marker === queueAfterRestartMarker) {
          await new Promise((resolveRelease) => heldModelReleases.push({ marker, release: resolveRelease }));
          if (response.destroyed) return;
          streamCompletion(response, {
            content: marker === queueAfterRestartMarker ? "QUEUE_RESTORED_AFTER_HOST_RESTART" : "QUEUE_HOLD_COMPLETE",
            id: `completion-${modelRequests.length}`,
          });
          return;
        }
        const tool = marker === disconnectMarker
          ? { id: "call_remote_ssh_disconnect_write", args: { path: disconnectFileName, content: disconnectFileContents } }
          : { id: "call_remote_ssh_write", args: { path: writeFileName, content: writeFileContents } };
        if (!(parsed.tools ?? []).some((candidate) => toolName(candidate) === "Write")) throw new Error("remote Host did not expose the Write tool");
        streamCompletion(response, { toolCall: tool, id: `completion-${modelRequests.length}` });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "fixture_error", message: redact(error) } }));
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    modelServer.once("error", rejectListen);
    modelServer.listen(0, "127.0.0.1", resolveListen);
  });
  return modelServer.address().port;
}

async function startFixtureServer() {
  fixtureServer = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    const name = pathname === "/checksum" ? `${artifactName}.sha256` : pathname.slice(1);
    if (request.method !== "GET" || ![artifactName, `${artifactName}.sha256`].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    const path = join(fixtureDir, name);
    if (!existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(path).size });
    createReadStream(path).pipe(response);
  });
  await new Promise((resolveListen, rejectListen) => {
    fixtureServer.once("error", rejectListen);
    fixtureServer.listen(0, "127.0.0.1", resolveListen);
  });
  fixturePort = fixtureServer.address().port;
}

function makeRemoteWrappers(curlBinary) {
  const curlShim = join(remoteBin, "curl");
  writeFileSync(curlShim, `#!/bin/sh
set -eu
[ "$#" -eq 6 ] && [ "$1" = "-fsSL" ] && [ "$2" = "--max-time" ] && [ "$3" = "600" ] && [ "$4" = "-o" ] || exit 64
[ "$6" = ${shellQuote(releaseUrl)} ] || exit 65
exec ${shellQuote(curlBinary)} -fsSL --max-time 600 -o "$5" ${shellQuote(`http://127.0.0.1:${fixturePort}/${artifactName}`)}
`);
  chmodSync(curlShim, 0o700);
  symlinkSync(resolve(process.execPath), join(remoteBin, "node"));
  const forceCommand = join(runRoot, "force-command");
  writeFileSync(forceCommand, `#!/bin/sh
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
  chmodSync(forceCommand, 0o700);
  return forceCommand;
}

async function configureSshd(forceCommand) {
  sshdPort = await reservePort();
  const user = runSync("id", ["-un"]).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`unsupported local account: ${user}`);
  runSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", sshdHostKey]);
  runSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`), { mode: 0o600 });
  chmodSync(authorizedKeys, 0o600);
  writeFileSync(sshdConfig, [
    `Port ${sshdPort}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${sshdHostKey}`,
    `PidFile ${sshdPidFile}`,
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
  sudoBinary = existsSync("/usr/bin/sudo") ? "/usr/bin/sudo" : "/bin/sudo";
  sshdBinary = existsSync("/usr/sbin/sshd") ? "/usr/sbin/sshd" : "/sbin/sshd";
  if (!existsSync(sudoBinary) || !existsSync(sshdBinary)) throw new Error("sudo or sshd is missing");
  runSync(sudoBinary, ["-n", sshdBinary, "-t", "-f", sshdConfig]);
  await startSshd();
}

async function startSshd() {
  sshdProcess = spawn(sudoBinary, ["-n", sshdBinary, "-D", "-e", "-f", sshdConfig], {
    cwd: runRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, HOME: clientHome },
  });
  let stderr = "";
  sshdProcess.stderr.setEncoding("utf8");
  sshdProcess.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  await waitForPort(sshdPort, "isolated sshd", sshdProcess).catch((error) => {
    throw new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`);
  });
  const pidText = readFileSync(sshdPidFile, "utf8").trim();
  if (!/^\d+$/.test(pidText)) throw new Error("sshd wrote an invalid pid file");
  sshdPid = Number(pidText);
}

async function stopSshd() {
  if (sshdPid) {
    try {
      runSync(sudoBinary, ["-n", "kill", "-TERM", String(sshdPid)], { timeoutMs: 5_000 });
    } catch {
      // It may already have exited after a transport failure.
    }
  }
  await waitForChildExit(sshdProcess, 5_000);
  sshdProcess = null;
  sshdPid = null;
}

function sshExec(input, timeoutMs = 30_000) {
  return new Promise((resolveResult, rejectResult) => {
    const sshBinary = existsSync("/usr/bin/ssh") ? "/usr/bin/ssh" : "/bin/ssh";
    const user = runSync("id", ["-un"]).trim();
    const args = [
      "-F", "/dev/null",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "ConnectTimeout=15",
      "-p", String(sshdPort),
      "-i", clientKey,
      `${user}@127.0.0.1`,
      "sh -s",
    ];
    const child = spawn(sshBinary, args, { env: { ...process.env, HOME: clientHome }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectResult(new Error(`fixture ssh command timed out: ${redact(stderr)}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) rejectResult(new Error(`fixture ssh failed (${code}): ${redact(stderr)}`));
      else resolveResult({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function runProviderImport(dataDir, modelBaseUrl, env) {
  const payload = {
    version: 1,
    providers: [{
      sourceId: "remote-ssh-desktop-e2e-provider",
      input: {
        name: "Remote SSH Desktop E2E",
        vendorKey: "custom",
        type: "openai_compatible",
        protocol: "openai_compatible",
        baseUrl: modelBaseUrl,
        authKind: "api_key_and_base_url",
        apiStyle: "chat_completions",
        secretValue: apiKey,
        models: [{ id: modelName, contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
      },
    }],
    defaultModel: { sourceId: "remote-ssh-desktop-e2e-provider", modelId: modelName },
  };
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [cliPath, "provider-import", "--data-dir", dataDir], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const providerLine = result.stdout.split("\n").find((line) => line.startsWith("PI_HOST_PROVIDERS "));
  const summary = providerLine ? JSON.parse(providerLine.slice("PI_HOST_PROVIDERS ".length)) : null;
  assertCase("local-provider-import-isolated", result.code === 0 && summary?.defaultSet === true);
  assertCase("provider-secret-not-printed", !result.stdout.includes(apiKey) && !result.stderr.includes(apiKey));
}

class CdpClient {
  static async connect(port) {
    const deadline = Date.now() + 45_000;
    let target = null;
    let pageTargets = [];
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
        pageTargets = (await response.json()).filter((item) => item.type === "page" && item.webSocketDebuggerUrl);
        target = pageTargets.find((item) => {
          try {
            const url = new URL(item.url);
            return url.pathname.endsWith("/out/renderer/index.html") && !url.searchParams.has("surface");
          } catch {
            return false;
          }
        });
        if (target) break;
      } catch {
        // Electron has not opened CDP yet.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!target) throw new Error(`Desktop renderer CDP target did not appear: ${JSON.stringify(pageTargets)}`);
    if (typeof WebSocket !== "function") throw new Error("Node WebSocket global is unavailable");
    const client = new CdpClient();
    client.targetUrl = target.url;
    client.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      client.socket.addEventListener("open", resolveOpen, { once: true });
      client.socket.addEventListener("error", () => rejectOpen(new Error("CDP WebSocket failed")), { once: true });
    });
    client.socket.addEventListener("message", ({ data }) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.id == null) return;
      const waiter = client.pending.get(message.id);
      if (!waiter) return;
      client.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`CDP ${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    return client;
  }

  constructor() {
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.targetUrl = "";
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReply(new Error(`CDP ${method} timed out`));
      }, 15_000);
      this.pending.set(id, { method, resolve: resolveReply, reject: rejectReply, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) {
      const reason = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`renderer evaluation failed: ${redact(reason)}`);
    }
    return result?.result?.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const detail = await this.evaluate("JSON.stringify({ url: location.href, body: document.body?.innerText?.slice(-1200) || '' })");
    throw new Error(`timed out waiting for ${label}: ${redact(detail)}`);
  }

  async click(expression, label) {
    const clicked = await this.evaluate(`(() => { const node = ${expression}; if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false; node.click(); return true; })()`);
    if (!clicked) throw new Error(`could not click ${label}`);
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

function fillForm(formSelector, values) {
  return `(() => {
    const form = document.querySelector(${JSON.stringify(formSelector)});
    const inputs = [...(form?.querySelectorAll('input') || [])];
    const values = ${JSON.stringify(values)};
    if (inputs.length !== values.length) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (let index = 0; index < inputs.length; index += 1) {
      setter?.call(inputs[index], values[index]);
      inputs[index].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: values[index] }));
      inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`;
}

async function startLocalHostAndSeedProvider(modelBaseUrl) {
  const env = { ...process.env, HOME: clientHome, PI_DESKTOP_HOST_BIN: hostCore };
  delete env.ELECTRON_RUN_AS_NODE;
  localHostProcess = spawn(process.execPath, [
    cliPath,
    "--data-dir", desktopDataDir,
    "--port", "0",
    "--host-core", hostCore,
    "--sidecar", sidecarPath,
    "--browse-root", browseRoot,
    "--log-level", "warn",
  ], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let ready = false;
  let lines = "";
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`local Host did not start: ${redact(localHostOutput)}`)), 60_000);
    const onData = (chunk) => {
      localHostOutput = `${localHostOutput}${String(chunk)}`.slice(-10_000);
      lines += String(chunk);
      while (lines.includes("\n")) {
        const index = lines.indexOf("\n");
        const line = lines.slice(0, index).trim();
        lines = lines.slice(index + 1);
        if (line.startsWith("PI_HOST_READY ")) {
          ready = true;
          clearTimeout(timer);
          resolveReady();
          return;
        }
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          rejectReady(new Error(`local Host failed: ${redact(line)}`));
          return;
        }
      }
    };
    localHostProcess.stdout.on("data", onData);
    localHostProcess.stderr.on("data", (chunk) => { localHostOutput = `${localHostOutput}\n${String(chunk)}`.slice(-10_000); });
    localHostProcess.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    localHostProcess.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        rejectReady(new Error(`local Host exited before ready (${code}): ${redact(localHostOutput)}`));
      }
    });
  });
  await readyPromise;
  await runProviderImport(desktopDataDir, modelBaseUrl, env);
  await terminateProcessTree(localHostProcess);
  localHostProcess = null;
}

async function startElectron() {
  const cdpPort = await reservePort();
  const env = {
    ...process.env,
    HOME: clientHome,
    PI_DESKTOP_DATA_DIR: desktopDataDir,
    PI_DESKTOP_HOST_BIN: hostCore,
    PI_DESKTOP_E2E_SSH: "1",
    PI_DESKTOP_E2E_SSH_CHECKSUM_URL: `http://127.0.0.1:${fixturePort}/checksum`,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electronProcess = spawn(electronBinary, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--disable-gpu",
    "--no-sandbox",
    "--password-store=basic",
    ".",
  ], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream.on("data", (chunk) => { electronOutput = `${electronOutput}${String(chunk)}`.slice(-15_000); });
  }
  return CdpClient.connect(cdpPort);
}

async function bootstrapFromSettings() {
  await cdp.waitFor("Boolean(document.querySelector('.app-shell') && document.querySelector('.sidebar'))", "Desktop shell");
  await cdp.click("document.querySelector('[data-nav=settings]')", "Settings");
  await cdp.waitFor("Boolean(document.querySelector('.settings-shell'))", "Settings page");
  await cdp.click("[...document.querySelectorAll('.settings-nav-item')].find((item) => /^(about|关于|info|信息)$/i.test(item.innerText.trim()))", "About settings");
  await cdp.waitFor("Boolean([...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '')))", "Developer mode setting");
  const developerEnabled = await cdp.evaluate("[...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '') && item.getAttribute('aria-checked') === 'true')");
  if (!developerEnabled) {
    await cdp.click("[...document.querySelectorAll('[role=switch]')].find((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || ''))", "Developer mode");
    await cdp.waitFor("[...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '') && item.getAttribute('aria-checked') === 'true')", "Developer mode enabled");
  }
  await cdp.click("[...document.querySelectorAll('.settings-nav-item')].find((item) => /remote hosts|远程主机/i.test(item.innerText))", "Remote Hosts settings");
  await cdp.waitFor("Boolean(document.querySelector('#remote-host-add-panel-ssh'))", "SSH form");
  const filled = await cdp.evaluate(fillForm("#remote-host-add-panel-ssh", [
    "Isolated Desktop SSH Host",
    "127.0.0.1",
    runSync("id", ["-un"]).trim(),
    String(sshdPort),
    clientKey,
  ]));
  assertCase("ssh-settings-form-filled", filled);
  await cdp.click("document.querySelector('#remote-host-add-panel-ssh button[type=submit]')", "Install and pair SSH Host");
  await cdp.waitFor("[...document.querySelectorAll('.settings-remote-host-card')].some((item) => item.innerText.includes('Isolated Desktop SSH Host'))", "SSH host card", 180_000);
  await cdp.waitFor("Boolean([...document.querySelectorAll('.settings-remote-host-card')].find((item) => item.innerText.includes('Isolated Desktop SSH Host'))?.innerText.match(/online|在线/i))", "SSH host connected", 60_000);
  assertCase("ssh-host-paired-through-settings", true);

  const syncClicked = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.settings-remote-host-card')].find((item) => item.innerText.includes('Isolated Desktop SSH Host'));
    const button = [...(card?.querySelectorAll('button') || [])].find((item) => /sync|同步|model|模型/i.test(item.innerText));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assertCase("provider-sync-dialog-opened", syncClicked);
  await cdp.waitFor("Boolean(document.querySelector('#sync-remote-providers-dialog'))", "provider sync dialog");
  await cdp.waitFor("Boolean([...document.querySelectorAll('#sync-remote-providers-dialog input[type=checkbox]')].some((item) => item.checked))", "default provider selected");
  await cdp.click("[...document.querySelectorAll('#sync-remote-providers-dialog .session-rename-dialog-actions button')].at(-1)", "sync provider");
  await cdp.waitFor("!document.querySelector('#sync-remote-providers-dialog')", "provider sync completion", 60_000);
  assertCase("provider-synced-through-settings", true);
}

async function createRemoteSession() {
  await cdp.click("document.querySelector('[data-nav=home]')", "Home");
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true] [data-action=new-remote-session]'))", "remote session entry", 60_000);
  await cdp.click("document.querySelector('[data-remote-host][data-connected=true] [data-action=new-remote-session]')", "new remote session");
  await cdp.waitFor("Boolean(document.querySelector('#new-remote-session-dialog'))", "remote session dialog");
  await cdp.click("[...document.querySelectorAll('#new-remote-session-dialog .session-rename-dialog-actions button')].at(-1)", "browse remote folder");
  await cdp.waitFor("Boolean([...document.querySelectorAll('.remote-session-dialog-list button')].some((item) => item.innerText.trim() === 'remote-project'))", "remote project directory");
  await cdp.click("[...document.querySelectorAll('.remote-session-dialog-list button')].find((item) => item.innerText.trim() === 'remote-project')", "open remote project");
  await cdp.waitFor("Boolean(document.querySelector('#new-remote-session-dialog .remote-session-dialog-path'))", "remote project path");
  await cdp.click("[...document.querySelectorAll('#new-remote-session-dialog .session-rename-dialog-actions button')].at(-1)", "register remote project");
  await cdp.waitFor("!document.querySelector('#new-remote-session-dialog')", "remote session creation");
  await cdp.waitFor("[...document.querySelectorAll('[data-sidebar-session-row]')].some((row) => row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active')))", "active remote session");
  const sessionId = await cdp.evaluate("[...document.querySelectorAll('[data-sidebar-session-row]')].find((row) => row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active')))?.getAttribute('data-sidebar-session-row') || null");
  assertCase("remote-session-created", typeof sessionId === "string" && sessionId.startsWith("remote:"));
  return sessionId;
}

async function sendComposer(prompt, label) {
  const filled = await cdp.evaluate(`(() => {
    const editor = document.querySelector('.composer-input[contenteditable=true]');
    if (!editor) return false;
    editor.focus();
    editor.replaceChildren(document.createTextNode(${JSON.stringify(prompt)}));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    return true;
  })()`);
  assertCase(`${label}-entered`, filled);
  await cdp.waitFor("Boolean(document.querySelector('.send-btn:not(:disabled)'))", `${label} send enabled`);
  await cdp.click("document.querySelector('.send-btn:not(:disabled)')", `${label} send`);
}

async function approvePermission() {
  await cdp.waitFor("Boolean(document.querySelector('.permission-card'))", "Desktop approval card", 60_000);
  const approved = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.permission-card-actions button')];
    if (buttons.length !== 3 || buttons.at(-1).disabled) return false;
    buttons.at(-1).click();
    return true;
  })()`);
  assertCase("remote-write-approved-in-desktop", approved);
}

async function waitForModelMarker(marker, count = 1) {
  return waitUntil(() => modelRequests.filter((request) => request.marker === marker).length >= count, `model request ${marker}`);
}

async function remoteReadyLine() {
  const result = await sshExec([
    "set -eu",
    "sed -n '/^PI_HOST_READY /p' \"$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.log\" | tail -n 1",
    "",
  ].join("\n"));
  const line = result.stdout.trim();
  if (!line.startsWith("PI_HOST_READY ")) throw new Error(`remote Host ready line missing: ${redact(line)}`);
  return JSON.parse(line.slice("PI_HOST_READY ".length));
}

async function restartRemoteHost(remotePort) {
  const script = [
    "set -eu",
    'pidfile="$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.pid"',
    'entry="$HOME/.pi-desktop/pi-host/current/pi-host.js"',
    'if [ -f "$pidfile" ]; then',
    '  pid=$(cat "$pidfile" 2>/dev/null || true)',
    '  case "$pid" in *[!0-9]*|\'\') pid="" ;; esac',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
    '    command_line=$(tr "\\000" " " < "/proc/$pid/cmdline" 2>/dev/null || true)',
    '    case "$command_line" in *"$entry"*) kill -TERM "$pid" 2>/dev/null || true ;; esac',
    '    waited=0',
    '    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done',
    '    command_line=$(tr "\\000" " " < "/proc/$pid/cmdline" 2>/dev/null || true)',
    '    case "$command_line" in *"$entry"*) kill -KILL "$pid" 2>/dev/null || true ;; esac',
    "  fi",
    "fi",
    ': > "$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.log"',
    ': > "$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.err"',
    `nohup node "$entry" --port ${shellQuote(remotePort)} >"$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.log" 2>"$HOME/.pi-desktop/pi-host/.bootstrap/pi-host.err" </dev/null &`,
    'printf "%s\\n" "$!" > "$pidfile"',
    "",
  ].join("\n");
  await sshExec(script, 30_000);
  await waitUntil(async () => {
    try {
      const ready = await remoteReadyLine();
      return ready.port === remotePort;
    } catch {
      return false;
    }
  }, "remote Host restart", 60_000);
}

async function runTerminalScenario(sessionId) {
  await cdp.click("document.querySelector('.app-work-panel-toggle')", "WorkPanel");
  await cdp.waitFor("Boolean(document.querySelector('[data-testid=work-panel]'))", "WorkPanel");
  if (!(await cdp.evaluate("Boolean(document.querySelector('[data-work-panel-launcher-item=terminal]'))"))) {
    await cdp.click("document.querySelector('.work-panel-new-tab')", "WorkPanel tab launcher");
  }
  await cdp.waitFor("Boolean(document.querySelector('[data-work-panel-launcher-item=terminal]'))", "remote terminal launcher");
  await cdp.click("document.querySelector('[data-work-panel-launcher-item=terminal]')", "remote terminal");
  await cdp.waitFor("Boolean(document.querySelector('.remote-terminal-status.is-connected'))", "remote terminal connected", 60_000);

  const openRequestId = `e2e-terminal-${Date.now()}`;
  const opened = await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.remoteTerminalOpen, {
      sessionId: ${JSON.stringify(sessionId)}, openRequestId: ${JSON.stringify(openRequestId)}, cols: 90, rows: 28,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  })()`);
  const beforeInput = Buffer.from(`printf '${terminalBeforeMarker}\\n'\\n`).toString("base64");
  await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    window.__piSshTerminalOutput = '';
    window.__piSshTerminalOff = bridge.on(bridge.channels.event.remoteTerminal, (event) => {
      if (event.sessionId === ${JSON.stringify(sessionId)} && event.type === 'output') window.__piSshTerminalOutput += atob(event.output);
    });
    const result = await bridge.invoke(bridge.channels.invoke.remoteTerminalInput, {
      sessionId: ${JSON.stringify(sessionId)}, terminalId: ${JSON.stringify(opened.terminalId)}, data: ${JSON.stringify(beforeInput)},
    });
    if (!result.ok) throw new Error(result.error.message);
    return true;
  })()`);
  await cdp.waitFor(`String(window.__piSshTerminalOutput || '').includes(${JSON.stringify(terminalBeforeMarker)})`, "remote terminal command output");
  pass("remote-terminal-command-executes");

  await stopSshd();
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=false]'))", "terminal SSH disconnect", 30_000);
  await startSshd();
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true]'))", "terminal SSH reconnect", 60_000);
  await cdp.waitFor("Boolean(document.querySelector('.remote-terminal-status.is-connected'))", "terminal status after reconnect", 60_000);

  const reattached = await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.remoteTerminalOpen, {
      sessionId: ${JSON.stringify(sessionId)}, terminalId: ${JSON.stringify(opened.terminalId)}, openRequestId: ${JSON.stringify(openRequestId)}, cols: 90, rows: 28,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  })()`);
  const replay = Buffer.from(reattached.replay, "base64").toString("utf8");
  assertCase("remote-terminal-replay-after-ssh-reconnect", replay.includes(terminalBeforeMarker));
  const afterInput = Buffer.from(`printf '${terminalAfterMarker}\\n'\\n`).toString("base64");
  await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.remoteTerminalInput, {
      sessionId: ${JSON.stringify(sessionId)}, terminalId: ${JSON.stringify(reattached.terminalId)}, data: ${JSON.stringify(afterInput)},
    });
    if (!result.ok) throw new Error(result.error.message);
    return true;
  })()`);
  await cdp.waitFor(`String(window.__piSshTerminalOutput || '').includes(${JSON.stringify(terminalAfterMarker)})`, "reattached terminal command output");
  pass("remote-terminal-accepts-input-after-ssh-reconnect");
  await cdp.evaluate("window.__piSshTerminalOff?.(); window.__piSshTerminalOff = null;");
  return reattached.terminalId;
}

async function runQueueRestartScenario(sessionId, remotePort) {
  const started = await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.agentPrompt, {
      sessionId: ${JSON.stringify(sessionId)}, content: ${JSON.stringify(`${queueHoldMarker}: keep the Host busy`)},
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  })()`);
  assertCase("remote-turn-starts-before-host-restart", Boolean(started?.turnId));
  await waitForModelMarker(queueHoldMarker);
  const queueEntry = await cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.agentQueuePush, {
      sessionId: ${JSON.stringify(sessionId)}, content: ${JSON.stringify(`${queueAfterRestartMarker}: durable queue item`)},
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  })()`);
  assertCase("remote-turn-enters-durable-queue", Boolean(queueEntry?.id));
  assertCase("queued-model-not-started-before-restart", modelRequests.filter((request) => request.marker === queueAfterRestartMarker).length === 0);

  await restartRemoteHost(remotePort);
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true]'))", "Host connection after process restart", 60_000);
  await waitForModelMarker(queueAfterRestartMarker, 1);
  assertCase("queued-turn-resumes-after-host-process-restart", true);
  releaseHeldModels(queueAfterRestartMarker);
  await cdp.waitFor("document.body.innerText.includes('QUEUE_RESTORED_AFTER_HOST_RESTART')", "queued turn completion after Host restart", 60_000);
}

async function run() {
  for (const directory of [remoteHome, clientHome, sshHome, desktopDataDir, profileDir, browseRoot, projectDir, fixtureDir, remoteBin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(projectDir, "README.md"), "# SSH Desktop E2E remote read\n", { mode: 0o600 });

  const desktopPackage = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
  const hostPackage = JSON.parse(readFileSync(join(root, "apps/pi-host/package.json"), "utf8"));
  version = desktopPackage.version;
  if (!version || hostPackage.version !== version) throw new Error(`desktop/pi-host versions differ (${version}/${hostPackage.version})`);
  artifactName = `pi-host-${version}-linux-x64.tar.gz`;
  releaseUrl = `https://github.com/vastsa/PI-Desktop/releases/download/v${version}/${artifactName}`;
  if (!bundleOverride) bundleDir = join(runRoot, basename(artifactName, ".tar.gz"));
  if (basename(bundleDir) !== basename(artifactName, ".tar.gz")) {
    throw new Error(`E2E bundle directory must be named ${basename(artifactName, ".tar.gz")}`);
  }
  cliPath = join(bundleDir, "pi-host.js");
  sidecarPath = join(bundleDir, "agent-runtime", "sidecar.js");

  if (ownsBundle) {
    runSync(process.execPath, [
      join(root, "apps/pi-host/scripts/bundle.mjs"),
      "--host-core", hostCore,
      "--platform", "linux",
      "--arch", "x64",
      "--out", bundleDir,
    ]);
  }
  if (!existsSync(cliPath) || !existsSync(sidecarPath)) throw new Error("pi-host bundle or sidecar is missing");
  const archivePath = join(fixtureDir, artifactName);
  runSync("tar", ["-czf", archivePath, "-C", runRoot, basename(bundleDir)]);
  const digest = await sha256File(archivePath);

  await startFixtureServer();
  const modelPort = await startModelFixture();
  const modelBaseUrl = `http://127.0.0.1:${modelPort}/v1`;
  await startLocalHostAndSeedProvider(modelBaseUrl);
  writeFileSync(join(fixtureDir, `${artifactName}.sha256`), `${digest}  ${artifactName}\n`, { mode: 0o600 });

  const curlBinary = existsSync("/usr/bin/curl") ? "/usr/bin/curl" : "/bin/curl";
  if (!existsSync(curlBinary)) throw new Error("curl is missing");
  const forceCommand = makeRemoteWrappers(curlBinary);
  await configureSshd(forceCommand);

  cdp = await startElectron();
  await bootstrapFromSettings();
  const sessionId = await createRemoteSession();
  assertCase("remote-project-read-through-desktop", await cdp.evaluate("document.body.innerText.includes('remote-project')"));

  await sendComposer(`${writeMarker}: create ${writeFileName} with the requested contents.`, "remote-write");
  await waitForModelMarker(writeMarker);
  await approvePermission();
  await cdp.waitFor("document.body.innerText.includes('REMOTE_SSH_DESKTOP_WRITE_COMPLETE')", "remote write completion", 60_000);
  await waitUntil(() => existsSync(join(projectDir, writeFileName)) && readFileSync(join(projectDir, writeFileName), "utf8") === writeFileContents, "remote write result", 15_000);
  assertCase("remote-write-created-on-remote-workspace", true);
  assertCase("remote-write-did-not-land-in-desktop-data", !existsSync(join(desktopDataDir, writeFileName)));

  await sendComposer(`${disconnectMarker}: request one approved write after reconnect.`, "disconnect-approval");
  await waitForModelMarker(disconnectMarker);
  await cdp.waitFor("Boolean(document.querySelector('.permission-card'))", "approval before SSH drop", 60_000);
  await stopSshd();
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=false]'))", "SSH disconnected while approval pending", 30_000);
  await startSshd();
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true]'))", "SSH host reconnected", 60_000);
  await cdp.waitFor("Boolean(document.querySelector('.permission-card'))", "approval restored from Host snapshot", 60_000);
  pass("pending-approval-restored-after-ssh-disconnect");
  await approvePermission();
  await cdp.waitFor("document.body.innerText.includes('REMOTE_SSH_DESKTOP_DISCONNECT_COMPLETE')", "post-reconnect approval completion", 60_000);
  await waitUntil(() => existsSync(join(projectDir, disconnectFileName)) && readFileSync(join(projectDir, disconnectFileName), "utf8") === disconnectFileContents, "post-reconnect remote write", 15_000);
  assertCase("post-reconnect-write-executed-once", modelRequests.filter((request) => request.marker === disconnectMarker).length === 2);

  const terminalId = await runTerminalScenario(sessionId);
  assertCase("terminal-session-identity-preserved", typeof terminalId === "string" && terminalId.length > 0);
  const remoteReady = await remoteReadyLine();
  await runQueueRestartScenario(sessionId, remoteReady.port);

  assertCase("model-request-used-disposable-provider", modelRequests.length > 0 && modelRequests.every((request) => request.authorization === `Bearer ${apiKey}`));
  assertCase("no-disposable-secret-in-desktop-log", !electronOutput.includes(apiKey) && !localHostOutput.includes(apiKey));
  pass("E2E-231 real Desktop SSH journey complete", `version=${version}, artifactSha256=${digest}`);
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  console.error(`[remote-ssh-desktop-e2e] FAIL ${redact(error instanceof Error ? error.stack ?? error.message : error)}`);
  if (electronOutput) console.error(`Electron diagnostics: ${redact(electronOutput.slice(-3000))}`);
  if (localHostOutput) console.error(`Local Host diagnostics: ${redact(localHostOutput.slice(-3000))}`);
} finally {
  cdp?.close();
  releaseHeldModels();
  await terminateProcessTree(electronProcess);
  await terminateProcessTree(localHostProcess);
  await stopSshd().catch(() => undefined);
  if (fixtureServer) await new Promise((resolveClose) => fixtureServer.close(() => resolveClose()));
  if (modelServer) await new Promise((resolveClose) => modelServer.close(() => resolveClose()));
  rmSync(runRoot, { recursive: true, force: true });
}
