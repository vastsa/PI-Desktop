#!/usr/bin/env node
/**
 * Real Desktop remote-session E2E: pair through Settings, browse and register
 * a remote project, create a session, approve a remote Write request, and
 * inspect the resulting remote workspace diff in the WorkPanel.
 *
 * The Host, model, Electron profile, and both data directories are local and
 * temporary. No external model service or existing Desktop profile is used.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertDesktopBuild,
  repositoryRoot,
  resolveElectronBinary,
} from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const electronBinary = resolveElectronBinary(root).electronBinary;
const hostBinary = resolveHostBinary();
const bundleOverride = process.env.PI_DESKTOP_HOST_BUNDLE_DIR;
const ownsBundle = !bundleOverride;
const bundleDir = bundleOverride ?? mkdtempSync(join(tmpdir(), "pi-host-remote-desktop-bundle-"));
const cliPath = join(bundleDir, "pi-host.js");
const sidecarPath = join(bundleDir, "agent-runtime", "sidecar.js");
const workspaceName = "remote-project";
const fileName = "remote-desktop-e2e.txt";
const fileContents = "written by the approved remote Desktop E2E\n";
const modelName = "remote-desktop-e2e-model";
const apiKey = "pi-desktop-remote-desktop-e2e-key";
const writeCallId = "call_remote_desktop_e2e_write";
const turnMarker = "REMOTE_DESKTOP_E2E_WRITE";
let pairingTokenForRedaction = "";

function assertCase(id, ok, detail = "") {
  if (!ok) throw new Error(`FAIL ${id}${detail ? ` — ${detail}` : ""}`);
  console.log(`PASS ${id}${detail ? ` — ${detail}` : ""}`);
}

function redact(value) {
  let result = String(value ?? "").replaceAll(apiKey, "[redacted]");
  if (pairingTokenForRedaction) result = result.replaceAll(pairingTokenForRedaction, "[redacted]");
  return result;
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name;
}

function streamCompletion(response, toolCall) {
  const completion = {
    id: "remote-desktop-e2e-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: modelName,
  };
  const delta = toolCall
    ? {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: writeCallId,
          type: "function",
          function: {
            name: "Write",
            arguments: JSON.stringify(toolCall),
          },
        }],
      }
    : { role: "assistant", content: "REMOTE_DESKTOP_E2E_COMPLETE" };
  const finishReason = toolCall ? "tool_calls" : "stop";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
  });
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  const signal = process.platform === "win32" ? child.kill("SIGTERM") : (() => {
    try {
      process.kill(-child.pid, "SIGTERM");
      return true;
    } catch {
      return child.kill("SIGTERM");
    }
  })();
  void signal;
  if (await waitForChildExit(child, 5_000)) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await waitForChildExit(child, 5_000);
}

async function allocatePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  if (!port) throw new Error("could not allocate a loopback port");
  return port;
}

class CdpClient {
  static async connect(port) {
    const deadline = Date.now() + 45_000;
    let target;
    let pageTargets = [];
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1_000),
        });
        const targets = await response.json();
        pageTargets = targets.filter((item) =>
          item.type === "page" && item.webSocketDebuggerUrl,
        );
        target = pageTargets.find((item) => {
          try {
            const url = new URL(item.url);
            return url.pathname.endsWith("/out/renderer/index.html") &&
              !url.searchParams.has("surface");
          } catch {
            return false;
          }
        });
        if (target) break;
      } catch {
        // Electron has not opened its debugging endpoint yet.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!target) {
      const available = pageTargets.map(({ title, url }) => ({ title, url }));
      throw new Error(`Electron main renderer CDP target did not appear: ${JSON.stringify(available)}`);
    }
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
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReply(new Error(`CDP ${method} timed out`));
      }, 12_000);
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
      throw new Error(`Renderer evaluation failed: ${redact(reason)}`);
    }
    return result?.result?.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const detail = await this.evaluate(`JSON.stringify({
      title: document.title,
      url: location.href,
      shell: Boolean(document.querySelector('.app-shell')),
      sidebar: Boolean(document.querySelector('.sidebar')),
      body: document.body?.innerText?.slice(-900) || ''
    })`);
    throw new Error(`Timed out waiting for ${label}; target=${this.targetUrl}: ${redact(detail)}`);
  }

  async click(expression, label) {
    const clicked = await this.evaluate(`(() => {
      const node = ${expression};
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') return false;
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not click ${label}`);
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

function runProviderImport(cli, dataDir, env, baseUrl) {
  return new Promise((resolveImport, rejectImport) => {
    const child = spawn(process.execPath, [cli, "provider-import", "--data-dir", dataDir], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectImport);
    child.once("exit", (code) => resolveImport({ code, stdout, stderr, baseUrl }));
    child.stdin.end(JSON.stringify({
      version: 1,
      providers: [{
        sourceId: "remote-desktop-e2e-provider",
        input: {
          name: "Remote Desktop E2E",
          vendorKey: "custom",
          type: "openai_compatible",
          protocol: "openai_compatible",
          baseUrl,
          authKind: "api_key_and_base_url",
          apiStyle: "chat_completions",
          secretValue: apiKey,
          models: [{
            id: modelName,
            contextWindow: 128_000,
            maxTokens: 8_192,
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
          }],
        },
      }],
      defaultModel: { sourceId: "remote-desktop-e2e-provider", modelId: modelName },
    }));
  });
}

// Keep Host's Unix admin socket path short enough for macOS sockaddr_un.
const temporaryRoot = mkdtempSync(join(tmpdir(), "pire-"));
const desktopDataDir = join(temporaryRoot, "desktop-data");
const hostDataDir = join(temporaryRoot, "h");
const profileDir = join(temporaryRoot, "electron-profile");
const homeDir = join(temporaryRoot, "home");
const browseRoot = join(temporaryRoot, "remote-workspace");
const projectDir = join(browseRoot, workspaceName);
for (const directory of [desktopDataDir, hostDataDir, profileDir, homeDir, projectDir]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(join(projectDir, "README.md"), "# remote Desktop E2E workspace\n");

let modelServer;
let hostProcess;
let electronProcess;
let cdp;
let hostOutput = "";
let electronOutput = "";
let modelAuth = null;
let modelCalls = 0;

try {
  if (ownsBundle) {
    const result = spawnSync(process.execPath, [
      join(root, "apps/pi-host/scripts/bundle.mjs"),
      "--host-core", hostBinary,
      "--platform", process.platform,
      "--arch", process.arch,
      "--out", bundleDir,
    ], { cwd: root, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(`pi-host bundle failed with exit code ${result.status}`);
    }
  }
  if (!existsSync(cliPath) || !existsSync(sidecarPath)) {
    throw new Error("pi-host CLI bundle or agent sidecar is missing");
  }

  const modelServerRef = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelName, object: "model" }] }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (requestBody += chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(requestBody);
        modelAuth = request.headers.authorization ?? null;
        modelCalls += 1;
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const hasToolResult = messages.some((message) => message?.role === "tool");
        if (hasToolResult) {
          streamCompletion(response, null);
          return;
        }
        const lastUser = [...messages].reverse().find((message) => message?.role === "user");
        const prompt = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
        if (!prompt.includes(turnMarker)) throw new Error("remote Desktop prompt marker is missing");
        if (!(body.tools ?? []).some((tool) => toolName(tool) === "Write")) {
          throw new Error("remote Host did not expose Write to the model");
        }
        streamCompletion(response, { path: fileName, content: fileContents });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: redact(error), type: "fixture_error" } }));
      }
    });
  });
  modelServer = modelServerRef;
  await new Promise((resolveListen, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolveListen);
  });
  const modelPort = modelServer.address().port;
  const modelBaseUrl = `http://127.0.0.1:${modelPort}/v1`;

  const hostEnv = { ...process.env, HOME: homeDir, PI_DESKTOP_HOST_BIN: hostBinary };
  delete hostEnv.ELECTRON_RUN_AS_NODE;
  hostProcess = spawn(process.execPath, [
    cliPath,
    "--data-dir", hostDataDir,
    "--port", "0",
    "--host-core", hostBinary,
    "--sidecar", sidecarPath,
    "--browse-root", browseRoot,
    "--log-level", "warn",
    "--remote-max-permission-mode", "ask",
    "--apply-ceiling-to-paired-devices", "true",
    "--pair",
  ], { env: hostEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let hostReadyInfo = null;
  let pairing = null;
  let hostLineBuffer = "";
  const hostReady = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`pi-host startup timed out: ${redact(hostOutput.slice(-2400))}`)), 60_000);
    const readLines = (chunk) => {
      hostOutput = `${hostOutput}${String(chunk)}`.slice(-12_000);
      hostLineBuffer += String(chunk);
      while (hostLineBuffer.includes("\n")) {
        const newline = hostLineBuffer.indexOf("\n");
        const line = hostLineBuffer.slice(0, newline).trim();
        hostLineBuffer = hostLineBuffer.slice(newline + 1);
        if (line.startsWith("PI_HOST_READY ")) hostReadyInfo = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          rejectReady(new Error(`pi-host failed: ${redact(line)}`));
          return;
        }
        if (hostReadyInfo && pairing) {
          clearTimeout(timer);
          resolveReady({ readyInfo: hostReadyInfo, pairing });
          return;
        }
      }
    };
    hostProcess.stdout.on("data", readLines);
    hostProcess.stderr.on("data", (chunk) => {
      hostOutput = `${hostOutput}\n${String(chunk)}`.slice(-12_000);
    });
    hostProcess.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    hostProcess.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`pi-host exited before pairing (code=${code}): ${redact(hostOutput.slice(-2400))}`));
    });
  });
  const hostBoot = await hostReady;
  const readyInfo = hostBoot.readyInfo;
  const pairToken = hostBoot.pairing;
  pairingTokenForRedaction = pairToken.token;
  assertCase("remote-host-starts-loopback", readyInfo.host === "127.0.0.1" && readyInfo.port > 0);

  const providerImport = await runProviderImport(cliPath, hostDataDir, hostEnv, modelBaseUrl);
  const providerLine = providerImport.stdout.split("\n").find((line) => line.startsWith("PI_HOST_PROVIDERS "));
  const providerSummary = providerLine ? JSON.parse(providerLine.slice("PI_HOST_PROVIDERS ".length)) : null;
  assertCase("remote-host-default-model-configured", providerImport.code === 0 && providerSummary?.defaultSet === true);
  assertCase("provider-secret-does-not-appear-in-cli-output", !providerImport.stdout.includes(apiKey) && !providerImport.stderr.includes(apiKey));

  const cdpPort = await allocatePort();
  const electronEnv = {
    ...process.env,
    HOME: homeDir,
    PI_DESKTOP_DATA_DIR: desktopDataDir,
    PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  // Linux CI has no desktop keyring. The isolated fixture stores disposable
  // credentials only, so select Electron's basic_text backend explicitly.
  electronProcess = spawn(electronBinary, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--disable-gpu",
    ...(process.platform === "linux" ? ["--no-sandbox", "--password-store=basic"] : []),
    ".",
  ], { cwd: appDir, env: electronEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream.on("data", (chunk) => {
      electronOutput = `${electronOutput}${String(chunk)}`.slice(-12_000);
    });
  }
  electronProcess.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      electronOutput = `${electronOutput}\nElectron exited with ${code}/${signal ?? "none"}`.slice(-12_000);
    }
  });
  cdp = await CdpClient.connect(cdpPort);
  await cdp.waitFor("Boolean(document.querySelector('.app-shell') && document.querySelector('.sidebar'))", "Desktop shell");
  assertCase("isolated-local-session-can-be-created", await cdp.evaluate("Boolean(document.querySelector('[data-action=\"new-standalone-session\"]'))"));
  await cdp.click("document.querySelector('[data-action=\"new-standalone-session\"]')", "new local session");
  await cdp.waitFor("Boolean([...document.querySelectorAll('[data-sidebar-session-row]')].some((row) => !row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active'))))", "active local session");
  const localSessionId = await cdp.evaluate("[...document.querySelectorAll('[data-sidebar-session-row]')].find((row) => !row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active')))?.getAttribute('data-sidebar-session-row') || null");
  assertCase("local-session-remains-local", typeof localSessionId === "string" && !localSessionId.startsWith("remote:"));

  await cdp.click("document.querySelector('[data-nav=settings]')", "Settings");
  await cdp.waitFor("Boolean(document.querySelector('.settings-shell'))", "Settings page");
  await cdp.click("[...document.querySelectorAll('.settings-nav-item')].find((item) => /^(about|关于|info|信息)$/i.test(item.innerText.trim()))", "About settings");
  await cdp.waitFor("Boolean([...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '')))", "Developer mode setting");
  const devModeEnabled = await cdp.evaluate("[...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '') && item.getAttribute('aria-checked') === 'true')");
  if (!devModeEnabled) {
    await cdp.click("[...document.querySelectorAll('[role=switch]')].find((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || ''))", "Developer mode switch");
    await cdp.waitFor("[...document.querySelectorAll('[role=switch]')].some((item) => /developer|开发者/i.test(item.getAttribute('aria-label') || '') && item.getAttribute('aria-checked') === 'true')", "Developer mode enabled");
  }
  await cdp.click("[...document.querySelectorAll('.settings-nav-item')].find((item) => /remote hosts|远程主机/i.test(item.innerText))", "Remote Hosts settings");
  await cdp.waitFor("Boolean(document.querySelector('#remote-host-add-panel-pair'))", "Pair form");
  await cdp.click("document.querySelector('#remote-host-add-pair')", "Pair tab");
  const remoteUrl = `ws://127.0.0.1:${readyInfo.port}/v1/racp/ws`;
  const fillPairForm = await cdp.evaluate(`(() => {
    const form = document.querySelector('#remote-host-add-panel-pair');
    const inputs = [...form.querySelectorAll('input')];
    const values = ${JSON.stringify(["Remote E2E Host", remoteUrl, pairToken.token])};
    if (inputs.length !== values.length) return false;
    for (let index = 0; index < inputs.length; index += 1) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(inputs[index], values[index]);
      inputs[index].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: values[index] }));
      inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  assertCase("pair-form-filled-through-desktop", fillPairForm);
  const pairFormMatches = await cdp.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('#remote-host-add-panel-pair input')];
    const values = ${JSON.stringify(["Remote E2E Host", remoteUrl, pairToken.token])};
    return inputs.length === values.length && inputs.every((input, index) => input.value === values[index]);
  })()`);
  assertCase("pair-form-values-reach-renderer", pairFormMatches);
  await cdp.click("document.querySelector('#remote-host-add-panel-pair button[type=submit]')", "Pair host");
  await cdp.waitFor("Boolean(document.querySelector('.settings-remote-host-card') || document.querySelector('.toast.error'))", "pair request result", 15_000);
  const pairFeedback = await cdp.evaluate(`(() => ({
    card: [...document.querySelectorAll('.settings-remote-host-card')].some((item) => item.innerText.includes('Remote E2E Host')),
    error: document.querySelector('.toast.error .toast-message')?.innerText || ''
  }))()`);
  if (!pairFeedback.card) throw new Error(`Pair request failed in Settings: ${redact(pairFeedback.error || "no Host card or error toast")}`);
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true]'))", "connected remote Host sidebar section");
  assertCase("host-paired-through-settings-ui", true);

  await cdp.click("document.querySelector('[data-nav=home]')", "return to chat");
  await cdp.waitFor("Boolean(document.querySelector('[data-remote-host][data-connected=true] [data-action=new-remote-session]'))", "remote session entry");
  await cdp.click("document.querySelector('[data-remote-host][data-connected=true] [data-action=new-remote-session]')", "new remote session");
  await cdp.waitFor("Boolean(document.querySelector('#new-remote-session-dialog'))", "remote session dialog");
  await cdp.click("[...document.querySelectorAll('#new-remote-session-dialog .session-rename-dialog-actions button')].at(-1)", "browse remote folder");
  await cdp.waitFor(`Boolean([...document.querySelectorAll('.remote-session-dialog-list button')].some((item) => item.innerText.trim() === ${JSON.stringify(workspaceName)}))`, "remote project directory in browser");
  await cdp.click(` [...document.querySelectorAll('.remote-session-dialog-list button')].find((item) => item.innerText.trim() === ${JSON.stringify(workspaceName)})`, "open remote project directory");
  await cdp.waitFor("Boolean(document.querySelector('#new-remote-session-dialog .remote-session-dialog-path'))", "remote project path");
  await cdp.click("[...document.querySelectorAll('#new-remote-session-dialog .session-rename-dialog-actions button')].at(-1)", "register remote project and create session");
  await cdp.waitFor("!document.querySelector('#new-remote-session-dialog')", "remote project registration");
  await cdp.waitFor("[...document.querySelectorAll('[data-sidebar-session-row]')].some((row) => row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active')))", "active remote session");
  const remoteSessionId = await cdp.evaluate("[...document.querySelectorAll('[data-sidebar-session-row]')].find((row) => row.getAttribute('data-sidebar-session-row').startsWith('remote:') && (row.getAttribute('aria-current') === 'page' || row.classList.contains('active')))?.getAttribute('data-sidebar-session-row') || null");
  assertCase("remote-session-created-and-selected", typeof remoteSessionId === "string" && remoteSessionId.startsWith("remote:"));
  assertCase("local-session-preserved-after-remote-entry", await cdp.evaluate(`Boolean(document.querySelector('[data-sidebar-session-row=${JSON.stringify(localSessionId)}]'))`));

  const prompt = `${turnMarker}: create ${fileName} in the remote workspace with the requested contents, then summarize the result.`;
  const filledPrompt = await cdp.evaluate(`(() => {
    const editor = document.querySelector('.composer-input[contenteditable=true]');
    if (!editor) return false;
    editor.focus();
    editor.replaceChildren(document.createTextNode(${JSON.stringify(prompt)}));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    return true;
  })()`);
  assertCase("remote-request-entered-in-composer", filledPrompt);
  await cdp.waitFor("Boolean(document.querySelector('.send-btn:not(:disabled)'))", "enabled Composer send button");
  await cdp.click("document.querySelector('.send-btn:not(:disabled)')", "send remote request");
  await cdp.waitFor("Boolean(document.querySelector('.permission-card'))", "remote tool approval card", 60_000);
  assertCase("remote-write-requires-desktop-approval", await cdp.evaluate("Boolean(document.querySelector('.permission-card')?.innerText.includes('Write'))"));
  const approved = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.permission-card-actions button')];
    if (buttons.length !== 3 || buttons.at(-1).disabled) return false;
    buttons.at(-1).click();
    return true;
  })()`);
  assertCase("remote-write-approved-once-from-desktop", approved);
  await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify("REMOTE_DESKTOP_E2E_COMPLETE")})`, "assistant completion in remote transcript", 60_000);

  const remoteFilePath = join(projectDir, fileName);
  const fileDeadline = Date.now() + 10_000;
  while (Date.now() < fileDeadline && !existsSync(remoteFilePath)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assertCase("approved-write-created-file-on-remote-workspace", existsSync(remoteFilePath) && readFileSync(remoteFilePath, "utf8") === fileContents);
  assertCase("remote-file-did-not-land-in-desktop-data", !existsSync(join(desktopDataDir, fileName)));
  assertCase("local-session-still-visible-after-remote-turn", await cdp.evaluate(`Boolean(document.querySelector('[data-sidebar-session-row=${JSON.stringify(localSessionId)}]'))`));
  assertCase("remote-model-request-used-host-provider", modelCalls >= 2 && modelAuth === `Bearer ${apiKey}`);
  assertCase("secret-does-not-appear-in-host-or-desktop-logs", !hostOutput.includes(apiKey) && !electronOutput.includes(apiKey));

  await cdp.click("document.querySelector('.app-work-panel-toggle')", "open WorkPanel");
  await cdp.waitFor("Boolean(document.querySelector('[data-testid=work-panel]'))", "WorkPanel");
  let reviewLauncher = await cdp.evaluate("document.querySelector('[data-work-panel-launcher-item=review]') !== null");
  if (!reviewLauncher) {
    await cdp.click("document.querySelector('.work-panel-new-tab')", "open WorkPanel tab launcher");
    await cdp.waitFor("Boolean(document.querySelector('[data-work-panel-launcher-item=review]'))", "Review launcher item");
    reviewLauncher = true;
  }
  if (reviewLauncher) {
    await cdp.click("document.querySelector('[data-work-panel-launcher-item=review]')", "open remote Review");
    await cdp.waitFor(`Boolean([...document.querySelectorAll('.review-change-card-path')].some((item) => item.innerText.trim() === ${JSON.stringify(fileName)}))`, "remote file in Review diff");
    assertCase("workpanel-review-reads-remote-diff", true);
  }

  assertCase("desktop-and-remote-session-journey-complete", true, remoteSessionId);
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack ?? error.message : error));
  if (electronOutput) console.error(`Electron diagnostics: ${redact(electronOutput.slice(-2400))}`);
  if (hostOutput) console.error(`Host diagnostics: ${redact(hostOutput.slice(-2400))}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  await terminateProcessTree(electronProcess);
  await terminateProcessTree(hostProcess);
  if (modelServer) {
    await new Promise((resolveClose) => modelServer.close(() => resolveClose()));
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
}
