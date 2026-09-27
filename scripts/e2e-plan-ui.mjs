#!/usr/bin/env node

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "apps", "desktop");

const REQUIRED_CASE_IDS = [
  "E2E-106-renderer",
  "E2E-111-renderer",
  "E2E-117-en",
  "E2E-117-zh-CN",
  "E2E-117-responsive",
];
const LIVE_CASE_ID = "E2E-106-live-agent";
const LIVE_ENV_AVAILABLE = [
  "PI_DESKTOP_TEST_API_KEY",
  "PI_DESKTOP_TEST_BASE_URL",
  "PI_DESKTOP_TEST_MODEL",
].every((name) => Boolean(process.env[name]?.trim()));
const CASE_IDS = LIVE_ENV_AVAILABLE
  ? [...REQUIRED_CASE_IDS, LIVE_CASE_ID]
  : REQUIRED_CASE_IDS;

const WAIT_TIMEOUT_MS = 45_000;
const LIVE_TIMEOUT_MS = 180_000;
const CDP_TIMEOUT_MS = 12_000;
const CLEANUP_TIMEOUT_MS = 8_000;
const POLL_MS = 100;

const CHECKPOINTS = {
  first: {
    title: "\nPlan UI first\n",
    question: "\nApprove first checkpoint?\n",
    markdown:
      "\n# Plan UI first checkpoint\n\n- Render the pending approval bar.\n- Keep the artifact bytes exact.\n\n",
  },
  second: {
    title: "\nPlan UI second\n",
    question: "\nApprove second checkpoint?\n",
    markdown:
      "\n# Plan UI second checkpoint\n\n- Refresh the pending proposal from SQLite.\n- Preserve the second artifact bytes exactly.\n\n",
  },
};

const LIVE_MARKER = "PLAN_LIVE_EXECUTED";
const LIVE_CHECKPOINT = {
  title: "Plan UI live exact plan",
  markdown: "# Plan UI live exact plan\n\n- After approval, report exactly PLAN_LIVE_EXECUTED.",
  question: "Approve the live Plan UI plan?",
};
const LIVE_PROMPT = [
  "This is a deterministic live acceptance test.",
  "Immediately call EnterPlanMode as the only tool call in the assistant message. Emit no prose.",
  "After the EnterPlanMode result, immediately call SubmitPlan as the only tool call in the next assistant message. Emit no prose before that call.",
  "Use exactly the following SubmitPlan values:",
  `title: ${LIVE_CHECKPOINT.title}`,
  "markdown (exact bytes, without code fences):",
  "---BEGIN MARKDOWN---",
  LIVE_CHECKPOINT.markdown,
  "---END MARKDOWN---",
  `question: ${LIVE_CHECKPOINT.question}`,
  "Do not call Read, Bash, Write, Edit, or any other tool.",
  `After approval, report exactly ${LIVE_MARKER} and do not call any tool.`,
].join("\n");

const results = new Map();

function shortText(value, max = 700) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function jsonText(value, max = 900) {
  try {
    return shortText(JSON.stringify(value), max);
  } catch {
    return shortText(value, max);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function record(id, ok, detail = "") {
  if (results.has(id)) return;
  results.set(id, { id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` - ${detail}` : ""}`);
}

function expectedDiagnostic(text) {
  return [
    /MODEL_NOT_CONFIGURED/i,
    /PROVIDER_SECRET_MISSING/i,
    /No provider configured/i,
    /Provider API key missing/i,
    /No model selected for provider/i,
    /provider.{0,30}not configured/i,
  ].some((pattern) => pattern.test(text));
}

function classifyExpectedDiagnostic(text, source) {
  if (!expectedDiagnostic(text)) return false;
  console.log(`EXPECTED ${source} provider-not-configured outcome - ${shortText(text)}`);
  return true;
}

function addCandidate(candidates, value) {
  if (value && !candidates.includes(value)) candidates.push(value);
}

function resolveHostBinary() {
  const candidates = [];
  const configured = process.env.PI_DESKTOP_HOST_BIN?.trim();
  if (configured) {
    const absolute = resolve(configured);
    addCandidate(candidates, absolute);
    if (process.platform === "win32" && !absolute.toLowerCase().endsWith(".exe")) {
      addCandidate(candidates, `${absolute}.exe`);
    }
  }

  const binaryName = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
  addCandidate(candidates, join(root, "target", "debug", binaryName));
  addCandidate(candidates, join(root, "..", "..", "..", "target", "debug", binaryName));

  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error(`host binary missing; tried: ${candidates.join(", ")}`);
  }
  return resolve(binary);
}

function resolveElectronBinary() {
  const binary = process.platform === "win32"
    ? join(appDir, "node_modules", "electron", "dist", "electron.exe")
    : join(appDir, "node_modules", ".bin", "electron");
  assert(existsSync(binary), `Electron binary missing: ${binary}`);
  return binary;
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveServer, reject) => {
    server.close((error) => (error ? reject(error) : resolveServer()));
  });
  assert(port > 0, "failed to allocate a free localhost port");
  return port;
}

function failPending(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

class CdpClient {
  constructor(onFailure) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.onFailure = onFailure;
    this.closed = false;
  }

  static async connect(url, onFailure) {
    assert(typeof WebSocket === "function", "Node 22 WebSocket global is unavailable");
    const client = new CdpClient(onFailure);
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      client.socket = socket;
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", () => {
        rejectOpen(new Error(`CDP WebSocket connection failed: ${url}`));
      }, { once: true });
    });

    client.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        client.fail(new Error(`invalid CDP message: ${errorText(error)}`));
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = client.pending.get(String(message.id));
        if (!entry) return;
        client.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(
            `CDP ${entry.method} failed: ${message.error.message || jsonText(message.error)}`,
          );
          error.cdp = true;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        const listeners = client.handlers.get(message.method) ?? [];
        for (const listener of listeners) listener(message.params ?? {});
      }
    });
    client.socket.addEventListener("close", () => {
      if (client.closed) return;
      client.closed = true;
      const error = new Error("CDP WebSocket closed unexpectedly");
      error.cdp = true;
      failPending(client.pending, error);
      client.onFailure?.(error);
    });
    client.socket.addEventListener("error", () => {
      if (client.closed) return;
      const error = new Error("CDP WebSocket error");
      error.cdp = true;
      client.onFailure?.(error);
    });
    return client;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    error.cdp = true;
    failPending(this.pending, error);
    this.onFailure?.(error);
  }

  on(method, listener) {
    const listeners = this.handlers.get(method) ?? [];
    listeners.push(listener);
    this.handlers.set(method, listeners);
    return () => {
      const current = this.handlers.get(method) ?? [];
      this.handlers.set(method, current.filter((candidate) => candidate !== listener));
    };
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed || !this.socket) {
      const error = new Error(`CDP is unavailable for ${method}`);
      error.cdp = true;
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(String(id))) return;
        const error = new Error(`CDP timeout ${method} after ${timeoutMs}ms`);
        error.cdp = true;
        rejectResult(error);
      }, timeoutMs);
      this.pending.set(String(id), {
        method,
        resolve: resolveResult,
        reject: rejectResult,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        const cdpError = error instanceof Error ? error : new Error(String(error));
        cdpError.cdp = true;
        rejectResult(cdpError);
      }
    });
  }

  async evaluate(expression, context = "renderer") {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "renderer evaluation threw";
      throw new Error(`${context} evaluation failed: ${shortText(description)}`);
    }
    return response?.result?.value;
  }

  async evaluateMain(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: false,
      returnByValue: false,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        "Electron Main evaluation threw";
      throw new Error(`Electron Main evaluation failed: ${shortText(description)}`);
    }
    const remote = response?.result;
    if (remote?.subtype !== "promise" || !remote.objectId) return remote?.value;
    const awaited = await this.send("Runtime.awaitPromise", {
      promiseObjectId: remote.objectId,
      returnByValue: true,
    });
    if (awaited?.exceptionDetails) {
      const description =
        awaited.exceptionDetails.exception?.description ||
        awaited.exceptionDetails.text ||
        "Electron Main promise rejected";
      throw new Error(`Electron Main evaluation failed: ${shortText(description)}`);
    }
    return awaited?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    failPending(this.pending, new Error("CDP closed by acceptance harness"));
    try {
      this.socket?.close();
    } catch {
      // The socket is already being torn down.
    }
  }
}

function ensureHealthy(state) {
  if (state.electronExitError) throw state.electronExitError;
  if (state.cdpError) throw state.cdpError;
  if (state.mainCdpError) throw state.mainCdpError;
  if (state.unexpectedConsoleError) throw state.unexpectedConsoleError;
}

async function waitFor(predicate, label, state, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    ensureHealthy(state);
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.cdp || error?.fatal) throw error;
      lastError = error;
    }
    await delay(POLL_MS);
  }
  ensureHealthy(state);
  throw new Error(
    `timeout waiting for ${label}${lastError ? `; last error: ${shortText(errorText(lastError))}` : ""}`,
  );
}

async function fetchJsonList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  return response.json();
}

function addElectronOutput(state, streamName, chunk) {
  const text = String(chunk);
  state.electronOutput += `[${streamName}] ${text}`;
  if (process.env.DEBUG_PI_DESKTOP_E2E === "1") process.stderr.write(text);
}

function attachElectronOutput(child, state) {
  child.stdout?.on("data", (chunk) => addElectronOutput(state, "stdout", chunk));
  child.stderr?.on("data", (chunk) => addElectronOutput(state, "stderr", chunk));
}

function startElectron(state) {
  const child = spawn(
    state.electronBinary,
    [
      `--remote-debugging-port=${state.cdpPort}`,
      `--inspect=${state.inspectorPort}`,
      `--user-data-dir=${state.profileDir}`,
      ".",
    ],
    {
      cwd: appDir,
      env: {
        ...process.env,
        PI_DESKTOP_DATA_DIR: state.dataDir,
        PI_DESKTOP_HOST_BIN: state.hostBinary,
        PI_DESKTOP_PLAN_UI_PROBE: "1",
        ELECTRON_RENDERER_URL: "",
        PI_DESKTOP_START_MAXIMIZED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform !== "win32",
    },
  );
  state.electron = child;
  attachElectronOutput(child, state);
  child.once("error", (error) => {
    if (state.stopping) return;
    state.electronExitError = new Error(`Electron failed to start: ${errorText(error)}`);
  });
  child.once("exit", (code, signal) => {
    if (state.stopping) return;
    state.electronExitError = new Error(
      `Electron exited before acceptance completed (code=${code}, signal=${signal || "none"})\n${shortText(state.electronOutput, 2_000)}`,
    );
    state.cdp?.fail(state.electronExitError);
  });
}

async function connectMain(state) {
  const target = await waitFor(
    async () => {
      try {
        const targets = await fetchJsonList(state.inspectorPort);
        return targets.find(
          (candidate) =>
            candidate.type === "node" && candidate.webSocketDebuggerUrl,
        );
      } catch {
        return null;
      }
    },
    "/json/list Electron Main inspector target",
    state,
  );
  state.mainCdp = await CdpClient.connect(target.webSocketDebuggerUrl, (error) => {
    if (state.stopping) return;
    state.mainCdpError = new Error(
      `${errorText(error)}${state.electronOutput ? `\nElectron output:\n${shortText(state.electronOutput, 3_000)}` : ""}`,
    );
    state.mainCdpError.cdp = true;
  });
  await state.mainCdp.send("Runtime.enable");
  await waitFor(
    async () => {
      const available = await state.mainCdp.evaluateMain(
        "typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'",
        "Electron Main",
      );
      return available === true;
    },
    "gated Plan UI probe availability",
    state,
  );
}

async function connectRenderer(state) {
  const list = await waitFor(
    async () => {
      try {
        const targets = await fetchJsonList(state.cdpPort);
        return targets.find(
          (target) =>
            target.type === "page" &&
            target.webSocketDebuggerUrl &&
            (target.url.startsWith("file:") || target.title === "PI-Desktop"),
        );
      } catch {
        return null;
      }
    },
    "/json/list renderer target",
    state,
  );
  state.cdp = await CdpClient.connect(list.webSocketDebuggerUrl, (error) => {
    if (state.stopping) return;
    state.cdpError = new Error(
      `${errorText(error)}${state.electronOutput ? `\nElectron output:\n${shortText(state.electronOutput, 3_000)}` : ""}`,
    );
    state.cdpError.cdp = true;
  });
  state.cdp.on("Runtime.consoleAPICalled", (params) => {
    const level = params.type || "log";
    const text = (params.args || [])
      .map((argument) => {
        if (Object.hasOwn(argument, "value")) {
          return typeof argument.value === "string"
            ? argument.value
            : jsonText(argument.value);
        }
        return argument.description || argument.unserializableValue || argument.type || "";
      })
      .join(" ");
    if (level !== "error" && level !== "assert") return;
    const entry = { source: "Runtime.consoleAPICalled", level, text };
    state.consoleDiagnostics.push(entry);
    if (classifyExpectedDiagnostic(text, entry.source)) return;
    state.unexpectedConsoleError = new Error(`unexpected renderer console ${level}: ${text}`);
    state.cdp?.fail(state.unexpectedConsoleError);
  });
  state.cdp.on("Runtime.exceptionThrown", (params) => {
    const text =
      params.exceptionDetails?.exception?.description ||
      params.exceptionDetails?.text ||
      "renderer exception";
    const entry = { source: "Runtime.exceptionThrown", level: "exception", text };
    state.consoleDiagnostics.push(entry);
    if (classifyExpectedDiagnostic(text, entry.source)) return;
    state.unexpectedConsoleError = new Error(`unexpected renderer exception: ${text}`);
    state.cdp?.fail(state.unexpectedConsoleError);
  });
  state.cdp.on("Log.entryAdded", (params) => {
    if (params.level !== "error") return;
    const text = params.text || jsonText(params);
    const entry = { source: "Log.entryAdded", level: params.level, text };
    state.consoleDiagnostics.push(entry);
    if (classifyExpectedDiagnostic(text, entry.source)) return;
    state.unexpectedConsoleError = new Error(`unexpected renderer log error: ${text}`);
    state.cdp?.fail(state.unexpectedConsoleError);
  });

  await state.cdp.send("Runtime.enable");
  await state.cdp.send("Page.enable");
  await state.cdp.send("DOM.enable");
  await state.cdp.send("Log.enable");
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

async function terminateChildTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveKill) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolveKill());
      killer.once("error", () => resolveKill());
      setTimeout(() => resolveKill(), CLEANUP_TIMEOUT_MS).unref?.();
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the checks.
      }
    }
  }
  if (!(await waitForChildExit(child, CLEANUP_TIMEOUT_MS))) {
    if (process.platform === "win32") {
      try {
        child.kill();
      } catch {
        // Best effort after taskkill timeout.
      }
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort cleanup.
        }
      }
    }
    await waitForChildExit(child, CLEANUP_TIMEOUT_MS);
  }
}

async function captureScreenshot(state, name) {
  ensureHealthy(state);
  const response = await state.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const path = join(state.artifactDir, `${name}.png`);
  await writeFile(path, Buffer.from(response.data, "base64"));
  state.screenshots.push(path);
  console.log(`ARTIFACT ${path}`);
  return path;
}

async function setViewport(state, width, height) {
  await state.cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function clearViewport(state) {
  await state.cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function inspectUi(state) {
  const result = await state.cdp.evaluate(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (node) => (node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const label = (node) => (node?.getAttribute("aria-label") || text(node)).trim();
    const modeButtons = [...document.querySelectorAll(".composer-shell button.mode-chip")]
      .filter(visible)
      .map((node) => ({ label: label(node), disabled: Boolean(node.disabled) }));
    const operatingModes = modeButtons.filter((item) =>
      ["Agent", "Plan", "智能体", "规划"].includes(item.label),
    );
    const bar = document.querySelector('[data-testid="plan-approval-bar"]');
    const approvalMain = bar?.querySelector(".plan-approval-approve-main");
    const approvalMenu = bar?.querySelector(".plan-approval-approve-menu");
    const reject = bar?.querySelector(".plan-approval-reject");
    const prompt = document.querySelector(".composer-input");
    const model = document.querySelector(".composer-model-thinking button");
    const mode = operatingModes[0];
    const permission = document.querySelector(".composer-permission button");
    const send = document.querySelector(".composer-shell .send-btn");
    const barText = text(bar);
    const bodyText = document.body?.innerText || "";
    const menuSelectedAsk = Boolean(
      bar?.querySelector('[data-approval-mode="ask"][aria-checked="true"]'),
    );
    const activeRow = [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) =>
        node.getAttribute("aria-current") === "page" || node.classList.contains("active"),
      );
    return {
      ready: Boolean(document.querySelector(".app-shell") && prompt),
      booting: Boolean(document.querySelector(".app-shell.is-booting")),
      lang: document.documentElement.lang || "",
      bodyText,
      activeSessionId: activeRow?.getAttribute("data-sidebar-session-row") || null,
      modeLabels: operatingModes.map((item) => item.label),
      modeControlCount: operatingModes.length,
      modeDisabled: mode ? mode.disabled : null,
      topbarModeControlCount: document.querySelectorAll(".conversation-topbar button.mode-chip").length,
      permissionVisible: visible(permission),
      permissionDisabled: permission ? Boolean(permission.disabled) : null,
      modelDisabled: model ? Boolean(model.disabled) : null,
      sendDisabled: send ? Boolean(send.disabled) : null,
      promptReadOnly: prompt ? Boolean(prompt.readOnly) : null,
      promptAriaReadOnly: prompt?.getAttribute("aria-readonly") || null,
      bar: bar && visible(bar)
        ? {
            status: bar.getAttribute("data-status") || "",
            executionState: bar.getAttribute("data-execution-state") || "",
            text: barText,
            title: text(bar.querySelector(".plan-approval-title")),
            question: text(bar.querySelector(".plan-approval-question")),
            artifactLabel: label(bar.querySelector("[data-testid=plan-open-artifact]")),
            artifactVisible: visible(bar.querySelector("[data-testid=plan-open-artifact]")),
            expiry: text(bar.querySelector(".plan-approval-expiry")),
            statusText: text(bar.querySelector(".plan-approval-status")),
            actionText: text(bar.querySelector(".plan-approval-actions")),
            rejectLabel: reject && visible(reject) ? label(reject) : null,
            approveLabel: approvalMain && visible(approvalMain) ? label(approvalMain) : null,
            approvalMenuVisible: approvalMenu ? visible(approvalMenu) : false,
            askMenuSelected: menuSelectedAsk,
            actionButtonCount: bar.querySelectorAll(".plan-approval-actions button").length,
          }
        : null,
      visibleForbidden: [
        /\\bchat mode\\b/i,
        /\\/chat-mode/i,
        /request[_ -]changes?/i,
        /\\bfeedback\\b/i,
      ].flatMap((pattern) => {
        const match = bodyText.match(pattern);
        return match ? [match[0]] : [];
      }),
      inlineApprovalNoise: [
        /\\bmarkdown\\b/i,
        /\\bhash\\b/i,
        /sha[- ]?256/i,
        /\\bsize\\b/i,
        /\\bbyte size\\b/i,
        /\\bbytes?\\b/i,
        /\\brevision\\b/i,
        /\\bfeedback\\b/i,
        /#[0-9a-f]{8,}/i,
      ].flatMap((pattern) => {
        const match = barText.match(pattern);
        return match ? [match[0]] : [];
      }),
      executionErrorText: text(document.querySelector(".chat-error-layer")),
    };
  })()`);
  return result;
}

async function waitForRendererReady(state) {
  return waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.ready && !snapshot.booting ? snapshot : null;
    },
    "renderer shell ready",
    state,
  );
}

async function reloadRenderer(state) {
  const loadEvent = new Promise((resolveLoad) => {
    const off = state.cdp.on("Page.loadEventFired", () => {
      off();
      resolveLoad();
    });
    setTimeout(() => {
      off();
      resolveLoad();
    }, WAIT_TIMEOUT_MS).unref?.();
  });
  await state.cdp.send("Page.reload", { ignoreCache: false });
  await loadEvent;
  await waitForRendererReady(state);
}

async function selectSession(state, sessionId) {
  const selection = await state.cdp.evaluate(`(async () => {
    const wanted = ${JSON.stringify(sessionId)};
    const findRow = () => [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) => node.getAttribute("data-sidebar-session-row") === wanted);
    let row = findRow();
    if (!row) {
      for (const toggle of document.querySelectorAll('[data-action="toggle-project-collapse"][aria-expanded="false"]')) {
        toggle.click();
      }
      for (const more of document.querySelectorAll(".sidebar-load-more")) more.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      row = findRow();
    }
    if (row) {
      row.querySelector("button.thread-item-main")?.click();
      return { method: "dom", found: true };
    }
    if (typeof window.__PI_DESKTOP__?.selectSession === "function") {
      await window.__PI_DESKTOP__.selectSession(wanted);
      return { method: "renderer-session-api", found: false };
    }
    return {
      method: "none",
      found: false,
      rows: [...document.querySelectorAll("[data-sidebar-session-row]")]
        .map((node) => node.getAttribute("data-sidebar-session-row")),
    };
  })()`);
  assert(selection?.method !== "none", `session row ${sessionId} was not found: ${jsonText(selection)}`);
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.activeSessionId === sessionId && !snapshot.booting;
    },
    `active session ${sessionId}`,
    state,
  );
}

async function submitComposerPrompt(state, prompt) {
  const result = await state.cdp.evaluate(`(() => {
    const input = document.querySelector(".composer-input");
    if (!(input instanceof HTMLTextAreaElement)) return { submitted: false, reason: "composer textarea missing" };
    if (input.readOnly) return { submitted: false, reason: "composer textarea is read-only" };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return { submitted: false, reason: "textarea value setter missing" };
    input.focus();
    setter.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(prompt)},
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { submitted: true };
  })()`);
  assert(result?.submitted === true, `real Composer fill failed: ${jsonText(result)}`);
  await waitFor(
    async () => (await inspectUi(state)).sendDisabled === false,
    "filled live Composer Send enabled",
    state,
    LIVE_TIMEOUT_MS,
  );
  await clickSelector(state, ".composer-shell .send-btn", "live Composer Send");
}

async function clickSelector(state, selector, description) {
  const result = await state.cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { clicked: false };
    if (node instanceof HTMLElement && node.offsetParent === null) return { clicked: false, hidden: true };
    node.click();
    return { clicked: true };
  })()`);
  assert(result?.clicked, `could not click ${description || selector}`);
}

async function clickApprovalMenuAndCheckAsk(state) {
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "approval mode menu");
  await waitFor(
    async () => (await inspectUi(state)).bar?.approvalMenuVisible,
    "approval mode menu",
    state,
  );
  const snapshot = await inspectUi(state);
  assert(snapshot.bar.askMenuSelected === true, `Ask was not selected by default: ${jsonText(snapshot.bar)}`);
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "close approval mode menu");
}

async function getPreloadResult(state, channelName, args = []) {
  const result = await state.cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    if (!bridge?.invoke || !bridge.channels?.invoke?.${channelName}) {
      throw new Error("required preload channel is unavailable: ${channelName}");
    }
    return bridge.invoke(bridge.channels.invoke.${channelName}, ...${JSON.stringify(args)});
  })()`);
  assert(result?.ok === true, `preload ${channelName} failed: ${jsonText(result)}`);
  return result.data;
}

async function getSettings(state) {
  return getPreloadResult(state, "settingsGet");
}

async function setLanguage(state, language) {
  let lastResult = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await state.cdp.evaluate(`(async () => {
      const bridge = window.piDesktop;
      const getChannel = bridge?.channels?.invoke?.settingsGet;
      const setChannel = bridge?.channels?.invoke?.settingsSet;
      if (!bridge?.invoke || !getChannel || !setChannel) {
        throw new Error("settings preload API is unavailable");
      }
      const current = await bridge.invoke(getChannel);
      if (!current?.ok) return current;
      // Language is an app-shell setting. Omit the unchanged command-shell
      // field so the host does not treat this write as a shell mutation while
      // a rejected Plan turn is still completing its asynchronous cleanup.
      const { defaultCommandShell: _defaultCommandShell, ...withoutShell } = current.data || {};
      const next = { ...withoutShell, language: ${JSON.stringify(language)} };
      return bridge.invoke(setChannel, next);
    })()`);
    if (result?.ok === true) return;
    lastResult = result;
    if (result?.error?.code !== "PLAN_CONFIGURATION_BLOCKED") break;
    await waitFor(
      async () => {
        const statuses = await Promise.all(
          [state.sessionId, state.otherSessionId]
            .filter(Boolean)
            .map((sessionId) => getPreloadResult(state, "agentGetStatus", [sessionId])),
        );
        return statuses.every((status) => status?.isRunning === false && !status?.currentTurnId);
      },
      "all sessions idle before settings locale update",
      state,
      5_000,
    ).catch(() => undefined);
    await delay(250);
  }
  throw new Error(`settings language=${language} failed: ${jsonText(lastResult)}`);
}

async function getSession(state, sessionId) {
  const result = await getPreloadResult(state, "sessionGet", [sessionId]);
  return result?.session ?? null;
}

async function getSessions(state) {
  const result = await getPreloadResult(state, "sessionList");
  return Array.isArray(result?.sessions) ? result.sessions : [];
}

async function getPendingPlan(state, sessionId) {
  const result = await getPreloadResult(state, "plansPending", [{ sessionId }]);
  return Array.isArray(result?.plans)
    ? result.plans.find((proposal) => proposal?.status === "pending") || null
    : null;
}

function assertPlanProbeIdentity(state, response, label) {
  assert(
    Number.isSafeInteger(response?.electronMainPid) && response.electronMainPid > 0,
    `${label} did not return a valid Electron Main PID: ${jsonText(response)}`,
  );
  assert(
    Number.isSafeInteger(response?.hostChildPid) && response.hostChildPid > 0,
    `${label} did not return a valid Host child PID: ${jsonText(response)}`,
  );
  assert(
    response.electronMainPid === state.electron?.pid,
    `${label} Electron Main PID does not match the launched process: ${jsonText(response)}`,
  );
  const identity = {
    electronMainPid: response.electronMainPid,
    hostChildPid: response.hostChildPid,
  };
  if (!state.probeIdentity) {
    state.probeIdentity = identity;
  } else {
    assert(
      identity.electronMainPid === state.probeIdentity.electronMainPid &&
        identity.hostChildPid === state.probeIdentity.hostChildPid,
      `${label} changed process identity: ${jsonText({
        expected: state.probeIdentity,
        actual: identity,
      })}`,
    );
  }
  return response;
}

function assertRuntimeIdentity(state, response, label, expectedRuntimeId) {
  assertPlanProbeIdentity(state, response, label);
  assert(
    typeof response?.runtimeId === "string" && response.runtimeId.length > 0,
    `${label} did not return a runtime ID: ${jsonText(response)}`,
  );
  assert(
    response.sessionId === state.liveSessionId,
    `${label} session identity mismatch: ${jsonText(response)}`,
  );
  if (expectedRuntimeId !== undefined) {
    assert(
      response.runtimeId === expectedRuntimeId,
      `${label} changed runtime identity: ${jsonText({ expectedRuntimeId, actual: response.runtimeId })}`,
    );
  }
  if (Number.isSafeInteger(response.sidecarChildPid) && response.sidecarChildPid > 0) {
    if (state.sidecarChildPid === null) state.sidecarChildPid = response.sidecarChildPid;
    assert(
      response.sidecarChildPid === state.sidecarChildPid,
      `${label} changed sidecar process identity: ${jsonText(response)}`,
    );
  }
  return response;
}

async function runPlanProbe(state, request) {
  ensureHealthy(state);
  assert(state.mainCdp && !state.mainCdp.closed, "Electron Main inspector is unavailable");
  const response = await state.mainCdp.evaluateMain(
    `(async () => {
      const probe = globalThis.__PI_DESKTOP_PLAN_UI_PROBE;
      if (typeof probe !== "function") throw new Error("Plan UI probe is unavailable");
      return probe(${JSON.stringify(request)});
    })()`,
    "Electron Main",
  );
  assertPlanProbeIdentity(state, response, `Plan probe ${request.operation}`);
  assert(response?.ok === true, `Plan probe ${request.operation} failed: ${jsonText(response)}`);
  return response;
}

async function assertPlanProbeIdentityAt(state, label) {
  return runPlanProbe(state, { operation: "identity" }).then((response) => {
    assert(response.operation === "identity", `${label} returned the wrong probe operation`);
    return response;
  });
}

async function settlePlanProbe(state, sessionId, turnId, status) {
  return runPlanProbe(state, {
    operation: "settle",
    sessionId,
    turnId,
    status,
  });
}

async function verifyArtifact(state, proposal, checkpoint) {
  const artifact = proposal?.artifact;
  assert(artifact?.relativePath, `proposal has no artifact: ${jsonText(proposal)}`);
  assert(
    /^\.pi\/plan\/[^/\\]+\.md$/.test(artifact.relativePath),
    `unexpected artifact path: ${artifact.relativePath}`,
  );
  const artifactPath = join(state.workspace, ...artifact.relativePath.split("/"));
  const bytes = await readFile(artifactPath);
  const expected = Buffer.from(checkpoint.markdown, "utf8");
  assert(bytes.equals(expected), `artifact bytes differ at ${artifact.relativePath}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert(artifact.sha256 === sha256, `artifact hash mismatch: ${jsonText(artifact)}`);
  assert(artifact.sizeBytes === bytes.length, `artifact size mismatch: ${jsonText(artifact)}`);
  return { artifactPath: artifact.relativePath, sha256, sizeBytes: bytes.length };
}

function toolNameOf(message) {
  if (typeof message?.toolName === "string") return message.toolName;
  if (typeof message?.name === "string") return message.name;
  if (typeof message?.content !== "string") return null;
  try {
    const parsed = JSON.parse(message.content);
    return typeof parsed?.toolName === "string" ? parsed.toolName : null;
  } catch {
    return null;
  }
}

function assertLiveTranscriptEvidence(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  assert(
    messages.some((message) => message?.role === "user" && message.content === LIVE_PROMPT),
    "live renderer prompt is missing from the durable transcript",
  );
  const toolMessages = messages.filter((message) => message?.role === "tool");
  const toolNames = toolMessages.map(toolNameOf).filter(Boolean);
  assert(
    toolNames.join(",") === "EnterPlanMode,SubmitPlan",
    `live Plan tool sequence was not deterministic: ${jsonText(toolNames)}`,
  );
  const submitIndex = messages.findIndex(
    (message) => message?.role === "tool" && toolNameOf(message) === "SubmitPlan",
  );
  assert(submitIndex >= 0, "durable SubmitPlan activity is missing");
  const priorAssistantText = messages
    .slice(0, submitIndex)
    .filter((message) => message?.role === "assistant")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean);
  assert(
    priorAssistantText.length === 0,
    `live flow emitted prose before SubmitPlan: ${jsonText(priorAssistantText)}`,
  );
}

async function workspaceFiles(rootPath, current = rootPath) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await workspaceFiles(rootPath, fullPath));
    else if (entry.isFile()) files.push(fullPath.slice(rootPath.length + 1).replaceAll("\\", "/"));
  }
  return files.sort();
}

async function submitPlan(state, sessionId, revision) {
  const checkpoint = CHECKPOINTS[revision];
  assert(checkpoint, `unknown Plan checkpoint revision: ${revision}`);
  const result = await runPlanProbe(state, {
    operation: "submit",
    workspace: state.workspace,
    sessionId,
    revision,
    title: checkpoint.title,
    markdown: checkpoint.markdown,
    question: checkpoint.question,
  });
  assert(result.status === "pending", `Plan submit was not pending: ${jsonText(result)}`);
  const proposal = result.proposal;
  assert(proposal?.id, `Plan submit returned no proposal: ${jsonText(result)}`);
  assert(proposal.sessionId === sessionId, `proposal session mismatch: ${jsonText(proposal)}`);
  assert(proposal.turnId === result.turnId, `proposal turn mismatch: ${jsonText(proposal)}`);
  assert(
    proposal.toolCallId === `plan-ui-probe-${revision}`,
    `proposal tool identity mismatch: ${jsonText(proposal)}`,
  );
  assert(proposal.markdown === checkpoint.markdown, "proposal Markdown is not byte-identical");
  assert(proposal.title === checkpoint.title.trim(), `proposal title mismatch: ${jsonText(proposal)}`);
  assert(
    proposal.question === checkpoint.question.trim(),
    `proposal question mismatch: ${jsonText(proposal)}`,
  );
  assert(
    Number.isFinite(Date.parse(proposal.expiresAt)),
    `invalid proposal expiry: ${jsonText(proposal)}`,
  );
  const artifact = await verifyArtifact(state, proposal, checkpoint);
  return {
    ...result,
    proposalId: proposal.id,
    proposalVersion: proposal.version,
    artifactPath: artifact.artifactPath,
    artifactSha256: artifact.sha256,
    artifactSizeBytes: artifact.sizeBytes,
    expiresAt: proposal.expiresAt,
  };
}

function assertNoLegacyUi(snapshot, scope = "shell") {
  assert(snapshot.visibleForbidden.length === 0, `${scope} exposes removed controls: ${jsonText(snapshot.visibleForbidden)}`);
  assert(snapshot.inlineApprovalNoise.length === 0, `${scope} exposes forbidden inline approval content: ${jsonText(snapshot.inlineApprovalNoise)}`);
}

function assertShellStructure(snapshot, expectedMode, locale) {
  const expectedLabel = locale === "zh-CN" ? "规划" : "Plan";
  assert(snapshot.modeControlCount === 1, `expected one active-session mode control, got ${snapshot.modeControlCount}`);
  assert(snapshot.modeLabels[0] === expectedLabel, `expected Composer ${expectedLabel}, got ${jsonText(snapshot.modeLabels)}`);
  assert(snapshot.topbarModeControlCount === 0, "conversation topbar contains a duplicate operating-mode control");
  assert(snapshot.permissionVisible, "Composer permission control is missing");
  assert(snapshot.activeSessionId, "no active rendered session row");
  if (expectedMode === "plan") {
    assert(snapshot.modeLabels.includes(expectedLabel), `Plan shell label missing for ${locale}`);
  }
}

function assertPendingUi(snapshot, locale, revision) {
  assert(snapshot.bar?.status === "pending", `expected pending Plan card, got ${jsonText(snapshot.bar)}`);
  assert(snapshot.bar.title === `Plan UI ${revision}`, `pending title mismatch: ${jsonText(snapshot.bar)}`);
  assert(snapshot.bar.question === `Approve ${revision} checkpoint?`, `pending question mismatch: ${jsonText(snapshot.bar)}`);
  assert(snapshot.bar.artifactVisible, "pending Plan artifact opener is not visible");
  assert(snapshot.bar.artifactLabel.includes(locale === "zh-CN" ? "打开规划文件" : "Open plan artifact"), `localized artifact opener missing: ${snapshot.bar.artifactLabel}`);
  assert(snapshot.bar.expiry, "pending Plan expiry/countdown is not visible");
  assert(snapshot.bar.rejectLabel === (locale === "zh-CN" ? "拒绝" : "Reject"), `reject label mismatch: ${snapshot.bar.rejectLabel}`);
  assert(
    snapshot.bar.approveLabel?.includes(locale === "zh-CN" ? "每次询问" : "Ask"),
    `Ask is not the default approval action: ${snapshot.bar.approveLabel}`,
  );
  assert(snapshot.bar.actionButtonCount === 3, `unexpected pending approval actions: ${snapshot.bar.actionButtonCount}`);
  assert(snapshot.promptReadOnly === true && snapshot.promptAriaReadOnly === "true", "pending Plan prompt is not read-only");
  assert(snapshot.modelDisabled === true, "pending Plan model control is not gated");
  assert(snapshot.modeDisabled === true, "pending Plan mode control is not gated");
  assert(snapshot.permissionDisabled === true, "pending Plan permission control is not gated");
  assert(snapshot.sendDisabled === true, "pending Plan send control is not gated");
  assertNoLegacyUi(snapshot, `pending ${locale}`);
}

function assertRejectedEditable(snapshot, locale) {
  assert(snapshot.bar?.status === "rejected", `expected visible rejected Plan card: ${jsonText(snapshot.bar)}`);
  assert(snapshot.bar.rejectLabel === null && snapshot.bar.approveLabel === null, "terminal rejected card still exposes an approval action");
  assert(snapshot.promptReadOnly === false && snapshot.promptAriaReadOnly !== "true", "rejected Plan prompt remains read-only");
  assert(snapshot.modelDisabled === false, "rejected Plan model control remains gated");
  assert(snapshot.modeDisabled === false, "rejected Plan mode control remains gated");
  assert(snapshot.permissionDisabled === false, "rejected Plan permission control remains gated");
  assertNoLegacyUi(snapshot, `rejected ${locale}`);
}

function assertApprovedTerminal(snapshot, locale) {
  const allowedStatuses = new Set(["approved", "queued", "running", "completed", "interrupted"]);
  assert(snapshot.bar, "approved Plan checkpoint is not visible in the current renderer lifetime");
  assert(allowedStatuses.has(snapshot.bar.status), `unexpected approved terminal status: ${jsonText(snapshot.bar)}`);
  assert(snapshot.bar.rejectLabel === null && snapshot.bar.approveLabel === null, "approved card still exposes an approval action");
  assert(snapshot.promptReadOnly === false && snapshot.promptAriaReadOnly !== "true", "approved session input is still read-only");
  assert(snapshot.modeLabels[0] === (locale === "zh-CN" ? "智能体" : "Agent"), `approved session did not switch to Agent: ${jsonText(snapshot.modeLabels)}`);
  assert(snapshot.modeDisabled === false, "approved session mode control remains gated");
  assert(snapshot.modelDisabled === false, "approved session model control remains gated");
  assert(snapshot.permissionDisabled === false, "approved session permission control remains gated");
  assertNoLegacyUi(snapshot, `approved ${locale}`);
}

function assertReloadedTerminalAbsent(snapshot, locale, expectedStatus, modeLabel) {
  assert(
    snapshot.bar === null,
    `renderer reload rehydrated a terminal ${expectedStatus} checkpoint: ${jsonText(snapshot.bar)}`,
  );
  assert(snapshot.promptReadOnly === false, `reloaded ${expectedStatus} session input is read-only`);
  assert(snapshot.modelDisabled === false, `reloaded ${expectedStatus} model control remains gated`);
  assert(snapshot.modeDisabled === false, `reloaded ${expectedStatus} mode control remains gated`);
  assert(snapshot.permissionDisabled === false, `reloaded ${expectedStatus} permission control remains gated`);
  assert(snapshot.modeLabels[0] === modeLabel, `reloaded ${expectedStatus} session mode mismatch: ${jsonText(snapshot.modeLabels)}`);
  assertNoLegacyUi(snapshot, `reloaded ${locale} ${expectedStatus}`);
}

async function responsiveSnapshot(state) {
  return state.cdp.evaluate(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const outside = [];
    const clipped = [];
    const textNodes = document.querySelectorAll(
      ".plan-approval-title, .plan-approval-question, .plan-approval-artifact-label, .plan-approval-artifact-path, .plan-approval-expiry, .plan-approval-status, .plan-approval-actions button, .composer-shell button",
    );
    for (const node of textNodes) {
      if (!visible(node)) continue;
      const box = node.getBoundingClientRect();
      if (box.left < -1 || box.right > window.innerWidth + 1) outside.push(node.className || node.tagName);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (line.left < box.left - 1 || line.right > box.right + 1 || line.top < box.top - 1 || line.bottom > box.bottom + 1) {
          const style = getComputedStyle(node);
          const intentionalPathEllipsis =
            node.classList.contains("plan-approval-artifact-path") &&
            style.textOverflow === "ellipsis" &&
            style.overflow === "hidden";
          if (!intentionalPathEllipsis) clipped.push(node.className || node.tagName);
          break;
        }
      }
    }
    const approval = document.querySelector(".plan-approval-bar");
    const composer = document.querySelector(".composer-shell");
    const topbar = document.querySelector(".conversation-topbar");
    const overflow = document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1;
    const overlap = approval && composer
      ? approval.getBoundingClientRect().bottom > composer.getBoundingClientRect().top + 1
      : false;
    const regions = [approval, composer, topbar].filter(visible).map((node) => ({ className: node.className, ...rect(node) }));
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      overflow,
      outside,
      clipped,
      overlap,
      regions,
      approval: approval ? rect(approval) : null,
      composer: composer ? rect(composer) : null,
    };
  })()`);
}

async function assertResponsiveViewport(state, width, height) {
  await setViewport(state, width, height);
  await waitFor(
    async () => {
      const current = await state.cdp.evaluate(`({ width: window.innerWidth, height: window.innerHeight })`);
      return current.width === width && current.height === height;
    },
    `viewport ${width}x${height}`,
    state,
  );
  const snapshot = await responsiveSnapshot(state);
  assert(!snapshot.overflow, `horizontal overflow at ${width}x${height}: ${jsonText(snapshot)}`);
  assert(snapshot.outside.length === 0, `control outside viewport at ${width}x${height}: ${jsonText(snapshot.outside)}`);
  assert(snapshot.clipped.length === 0, `control text clipped at ${width}x${height}: ${jsonText(snapshot.clipped)}`);
  assert(!snapshot.overlap, `approval/composer overlap at ${width}x${height}: ${jsonText(snapshot)}`);
  return snapshot;
}

async function approveAndWait(state) {
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-main', "Approve (Ask)");
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.bar && snapshot.bar.status !== "pending" ? snapshot : null;
    },
    "approved Plan terminal or execution status",
    state,
  );
  await waitFor(
    async () => {
      const session = await getSession(state, state.sessionId);
      return session?.mode === "agent";
    },
    "approved session Agent mode",
    state,
  );
}

async function settleExpectedExecutionError(state) {
  const snapshot = await inspectUi(state);
  if (!snapshot.executionErrorText) return;
  if (classifyExpectedDiagnostic(snapshot.executionErrorText, "visible renderer execution status")) return;
  throw new Error(`unexpected visible execution error: ${snapshot.executionErrorText}`);
}

async function runLiveAcceptance(state) {
  const baselineFiles = await workspaceFiles(state.workspace);
  const setup = await runPlanProbe(state, {
    operation: "liveSetup",
    workspace: state.workspace,
  });
  assert(setup.sessionId, `live setup returned no session ID: ${jsonText(setup)}`);
  state.liveSessionId = setup.sessionId;

  await reloadRenderer(state);
  await selectSession(state, state.liveSessionId);
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.activeSessionId === state.liveSessionId &&
        snapshot.promptReadOnly === false &&
        snapshot.modelDisabled === false
        ? snapshot
        : null;
    },
    "live Agent Composer ready",
    state,
    LIVE_TIMEOUT_MS,
  );

  await submitComposerPrompt(state, LIVE_PROMPT);
  const pending = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      const proposal = await getPendingPlan(state, state.liveSessionId);
      return snapshot.bar?.status === "pending" && proposal ? { snapshot, proposal } : null;
    },
    "live pending Plan card",
    state,
    LIVE_TIMEOUT_MS,
  );
  assert(pending.snapshot.bar.title === LIVE_CHECKPOINT.title, `live title mismatch: ${jsonText(pending.snapshot.bar)}`);
  assert(
    pending.snapshot.bar.question === LIVE_CHECKPOINT.question,
    `live question mismatch: ${jsonText(pending.snapshot.bar)}`,
  );
  assert(
    pending.proposal.title === LIVE_CHECKPOINT.title &&
      pending.proposal.markdown === LIVE_CHECKPOINT.markdown &&
      pending.proposal.question === LIVE_CHECKPOINT.question,
    `live proposal metadata is not exact: ${jsonText(pending.proposal)}`,
  );
  const askLabel = pending.snapshot.lang === "zh-CN" ? "每次询问" : "Ask";
  assert(
    pending.snapshot.bar.approveLabel?.includes(askLabel),
    `live approval did not default to Ask: ${jsonText(pending.snapshot.bar)}`,
  );
  await clickApprovalMenuAndCheckAsk(state);
  const artifact = await verifyArtifact(state, pending.proposal, LIVE_CHECKPOINT);
  const transcript = await waitFor(
    async () => {
      const session = await getSession(state, state.liveSessionId);
      try {
        assertLiveTranscriptEvidence(session);
        return session;
      } catch {
        return null;
      }
    },
    "live prompt and deterministic Plan tool transcript",
    state,
    LIVE_TIMEOUT_MS,
  );
  assertLiveTranscriptEvidence(transcript);

  const pendingRuntime = assertRuntimeIdentity(
    state,
    await runPlanProbe(state, {
      operation: "runtimeIdentity",
      sessionId: state.liveSessionId,
    }),
    "runtime identity while live Plan approval is pending",
  );

  await clickSelector(
    state,
    '[data-testid="plan-approval-bar"] .plan-approval-approve-main',
    "live Approve (Ask)",
  );
  const approvedSnapshot = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.bar &&
        snapshot.bar.status !== "pending" &&
        ["Agent", "智能体"].includes(snapshot.modeLabels[0])
        ? snapshot
        : null;
    },
    "live approval transition to Agent",
    state,
    LIVE_TIMEOUT_MS,
  );
  assert(
    ["approved", "queued", "running", "completed"].includes(approvedSnapshot.bar.status),
    `unexpected live approved status: ${jsonText(approvedSnapshot.bar)}`,
  );

  const settled = await waitFor(
    async () => {
      const session = await getSession(state, state.liveSessionId);
      const markerMessage = (session?.messages || []).find(
        (message) => message?.role === "assistant" && String(message.content || "").trim() === LIVE_MARKER,
      );
      const snapshot = await inspectUi(state);
      const status = await getPreloadResult(state, "agentGetStatus", [state.liveSessionId]);
      return markerMessage &&
        snapshot.bodyText.includes(LIVE_MARKER) &&
        status?.status?.isRunning === false
        ? { session, snapshot }
        : null;
    },
    "live approved execution and exact assistant marker",
    state,
    LIVE_TIMEOUT_MS,
  );
  const finalSession = settled.session;
  assert(finalSession?.mode === "agent", `live session did not remain Agent: ${jsonText(finalSession)}`);
  assertLiveTranscriptEvidence(finalSession);
  const finalSnapshot = settled.snapshot;
  assertApprovedTerminal(
    finalSnapshot,
    finalSnapshot.lang === "zh-CN" ? "zh-CN" : "en",
  );
  await assertRuntimeIdentity(
    state,
    await runPlanProbe(state, {
      operation: "runtimeIdentity",
      sessionId: state.liveSessionId,
    }),
    "runtime identity after live approval execution",
    pendingRuntime.runtimeId,
  );
  const files = await workspaceFiles(state.workspace);
  const expectedFiles = [...baselineFiles, artifact.artifactPath].sort();
  assert(
    jsonText(files) === jsonText(expectedFiles),
    `live execution mutated the workspace beyond its Plan artifact: ${jsonText(files)}`,
  );
  assert(
    finalSession.messages.some(
      (message) => message?.role === "assistant" && String(message.content || "").trim() === LIVE_MARKER,
    ),
    "exact live execution marker is not durable",
  );
  const submitIndex = finalSession.messages.findIndex(
    (message) => message?.role === "tool" && toolNameOf(message) === "SubmitPlan",
  );
  const postApprovalAssistantText = finalSession.messages
    .slice(submitIndex + 1)
    .filter((message) => message?.role === "assistant")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean);
  assert(
    postApprovalAssistantText.join("\n") === LIVE_MARKER,
    `live execution emitted text other than the exact marker: ${jsonText(postApprovalAssistantText)}`,
  );
  return `provider=${setup.providerId} model=${setup.modelId} runtime=${pendingRuntime.runtimeId} marker=${LIVE_MARKER} artifact=${artifact.artifactPath}`;
}

async function runAcceptance(state) {
  startElectron(state);
  await connectMain(state);
  const seed = await runPlanProbe(state, {
    operation: "seed",
    workspace: state.workspace,
  });
  assert(seed.sessionId, `Plan probe seed returned no session id: ${jsonText(seed)}`);
  state.sessionId = seed.sessionId;

  await connectRenderer(state);
  await waitForRendererReady(state);
  await setViewport(state, 1280, 800);
  await selectSession(state, state.sessionId);

  const settings = await getSettings(state);
  assert(settings.defaultMode === "agent", `new-session default is not Agent: ${jsonText(settings)}`);
  const sessions = await getSessions(state);
  const defaultAgent = sessions.find((session) => session.id !== state.sessionId && session.mode === "agent");
  assert(defaultAgent, `no newly created Agent session was present: ${jsonText(sessions)}`);
  state.otherSessionId = defaultAgent.id;
  const seededSession = await getSession(state, state.sessionId);
  assert(seededSession?.mode === "plan", `seeded session is not Plan: ${jsonText(seededSession)}`);

  let snapshot = await inspectUi(state);
  assertShellStructure(snapshot, "plan", snapshot.lang === "zh-CN" ? "zh-CN" : "en");
  assertNoLegacyUi(snapshot, "initial shell");

  await setLanguage(state, "en");
  await reloadRenderer(state);
  await assertPlanProbeIdentityAt(state, "identity after English renderer reload");
  await selectSession(state, state.sessionId);
  snapshot = await inspectUi(state);
  assert(snapshot.lang === "en", `English settings API did not reconcile to English: ${jsonText(snapshot)}`);
  assertShellStructure(snapshot, "plan", "en");
  assert(snapshot.promptReadOnly === false, "idle Plan composer is not editable in English");
  assertNoLegacyUi(snapshot, "English idle shell");

  const first = await submitPlan(state, state.sessionId, "first");
  assert(Number.isFinite(Date.parse(first.expiresAt)) && Date.parse(first.expiresAt) > Date.now(), "first Plan expiry is invalid or already elapsed");
  await reloadRenderer(state);
  await assertPlanProbeIdentityAt(state, "identity after first pending renderer reload");
  await selectSession(state, state.sessionId);
  await waitFor(
    async () => {
      const current = await inspectUi(state);
      return current.bar?.status === "pending" ? current : null;
    },
    "English pending Plan card after SQLite reload",
    state,
  );
  snapshot = await inspectUi(state);
  assertPendingUi(snapshot, "en", "first");
  await clickApprovalMenuAndCheckAsk(state);
  await captureScreenshot(state, "e2e-117-en-pending");

  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-reject', "Reject");
  await waitFor(
    async () => {
      const current = await inspectUi(state);
      return current.bar?.status === "rejected" && current.bar.rejectLabel === null ? current : null;
    },
    "rejected editable Plan card",
    state,
  );
  snapshot = await inspectUi(state);
  assertRejectedEditable(snapshot, "en");
  await settlePlanProbe(state, state.sessionId, first.turnId, "aborted");
  await assertPlanProbeIdentityAt(state, "identity after first rejection");
  await captureScreenshot(state, "e2e-117-rejected-editable");

  await selectSession(state, state.otherSessionId);
  snapshot = await inspectUi(state);
  assert(snapshot.activeSessionId === state.otherSessionId, "could not select the independent Agent session");
  assert(snapshot.bar?.status !== "rejected", "rejected Plan terminal state leaked into another session");
  await selectSession(state, state.sessionId);
  snapshot = await inspectUi(state);
  assertRejectedEditable(snapshot, "en");
  record(
    "E2E-111-renderer",
    true,
    "Agent default, sole Composer mode control, pending gate, and session-scoped rejection verified",
  );

  await setLanguage(state, "zh-CN");
  await reloadRenderer(state);
  await assertPlanProbeIdentityAt(state, "identity after rejected renderer reload");
  await selectSession(state, state.sessionId);
  snapshot = await inspectUi(state);
  assert(snapshot.lang === "zh-CN", `zh-CN settings API did not reconcile: ${jsonText(snapshot)}`);
  assertShellStructure(snapshot, "plan", "zh-CN");
  assert(snapshot.modeLabels[0] === "规划", `zh-CN Plan shell label missing: ${jsonText(snapshot.modeLabels)}`);
  assertReloadedTerminalAbsent(snapshot, "zh-CN", "rejected", "规划");

  const second = await submitPlan(state, state.sessionId, "second");
  assert(second.artifactPath !== first.artifactPath, "resubmission reused the first Plan artifact path");
  await reloadRenderer(state);
  await assertPlanProbeIdentityAt(state, "identity after second pending renderer reload");
  await selectSession(state, state.sessionId);
  await waitFor(
    async () => {
      const current = await inspectUi(state);
      return current.bar?.status === "pending" ? current : null;
    },
    "zh-CN pending Plan card after second SQLite reload",
    state,
  );
  snapshot = await inspectUi(state);
  assertPendingUi(snapshot, "zh-CN", "second");
  await clickApprovalMenuAndCheckAsk(state);
  record(
    "E2E-117-en",
    true,
    "English Plan shell, immutable approval metadata, Ask default, gated controls, and rejected editable state verified",
  );
  await captureScreenshot(state, "e2e-117-zh-CN-pending");

  await assertResponsiveViewport(state, 1280, 800);
  const narrow = await assertResponsiveViewport(state, 900, 700);
  await captureScreenshot(state, "e2e-117-responsive-900x700");
  await setViewport(state, 1280, 800);
  record("E2E-117-responsive", true, `1280x800 and 900x700 passed; narrow regions=${narrow.regions.length}`);

  await approveAndWait(state);
  await settlePlanProbe(state, state.sessionId, second.turnId, "completed");
  await waitFor(
    async () => {
      const current = await inspectUi(state);
      return current.bar?.status !== "pending" ? current : null;
    },
    "post-approval renderer reconciliation",
    state,
  );
  snapshot = await inspectUi(state);
  await settleExpectedExecutionError(state);
  assertApprovedTerminal(snapshot, "zh-CN");
  await assertPlanProbeIdentityAt(state, "identity after approval");
  await captureScreenshot(state, "e2e-117-terminal");
  await reloadRenderer(state);
  await assertPlanProbeIdentityAt(state, "identity after approved terminal renderer reload");
  await selectSession(state, state.sessionId);
  snapshot = await inspectUi(state);
  assertReloadedTerminalAbsent(snapshot, "zh-CN", "approved/completed", "智能体");
  await assertPlanProbeIdentityAt(state, "identity during final assertions");

  record(
    "E2E-106-renderer",
    true,
    `rejected first checkpoint, editable planning, distinct second artifact, and Ask approval completed (${first.artifactPath} -> ${second.artifactPath})`,
  );
  record(
    "E2E-117-zh-CN",
    true,
    "zh-CN labels, Ask default, terminal Agent state, pending-only reload hydration, and no stale actions verified",
  );

  if (!LIVE_ENV_AVAILABLE) {
    console.log(
      `SKIP ${LIVE_CASE_ID} - set PI_DESKTOP_TEST_API_KEY, PI_DESKTOP_TEST_BASE_URL, and PI_DESKTOP_TEST_MODEL for the optional live acceptance case`,
    );
  } else {
    try {
      const detail = await runLiveAcceptance(state);
      record(LIVE_CASE_ID, true, detail);
    } catch (error) {
      record(LIVE_CASE_ID, false, errorText(error));
      throw error;
    }
  }
}

async function cleanup(state) {
  state.stopping = true;
  if (state.cdp) await state.cdp.close();
  if (state.mainCdp) await state.mainCdp.close();
  await terminateChildTree(state.electron);
  if (state.tempRoot) {
    await rm(state.tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

async function main() {
  if (!existsSync(join(appDir, "out", "main", "index.js"))) {
    throw new Error(`built Electron main missing: ${join(appDir, "out", "main", "index.js")}`);
  }
  if (!existsSync(join(appDir, "out", "renderer", "index.html"))) {
    throw new Error(`built Electron renderer missing: ${join(appDir, "out", "renderer", "index.html")}`);
  }

  const state = {
    tempRoot: null,
    dataDir: null,
    profileDir: null,
    workspace: null,
    artifactDir: null,
    hostBinary: resolveHostBinary(),
    electronBinary: resolveElectronBinary(),
    cdpPort: await allocatePort(),
    inspectorPort: await allocatePort(),
    electron: null,
    cdp: null,
    mainCdp: null,
    sessionId: null,
    otherSessionId: null,
    liveSessionId: null,
    probeIdentity: null,
    sidecarChildPid: null,
    screenshots: [],
    consoleDiagnostics: [],
    electronOutput: "",
    electronExitError: null,
    cdpError: null,
    mainCdpError: null,
    unexpectedConsoleError: null,
    stopping: false,
  };

  state.tempRoot = await mkdtemp(join(tmpdir(), `pi-plan-ui-${process.pid}-`));
  state.dataDir = join(state.tempRoot, "data");
  state.profileDir = join(state.tempRoot, "profile");
  state.workspace = join(state.tempRoot, "workspace");
  await Promise.all([
    mkdir(state.dataDir, { recursive: true }),
    mkdir(state.profileDir, { recursive: true }),
    mkdir(state.workspace, { recursive: true }),
  ]);
  const callerArtifactDir = process.env.PI_DESKTOP_E2E_ARTIFACT_DIR?.trim();
  state.artifactDir = callerArtifactDir
    ? resolve(callerArtifactDir)
    : join(state.tempRoot, "artifacts");
  await mkdir(state.artifactDir, { recursive: true });

  console.log(`CDP port ${state.cdpPort}`);
  console.log(`Electron Main inspector port ${state.inspectorPort}`);
  console.log(`Temp data ${state.dataDir}`);
  console.log(`Temp profile ${state.profileDir}`);
  console.log(`Temp workspace ${state.workspace}`);
  console.log(`Artifacts ${state.artifactDir}`);

  let primaryError = null;
  try {
    await runAcceptance(state);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    console.error(`FATAL ${primaryError.message}`);
    if (state.electronOutput) {
      console.error(`ELECTRON OUTPUT\n${shortText(state.electronOutput, 4_000)}`);
    }
    if (state.cdp && !state.cdp.closed) {
      try {
        await captureScreenshot(state, "e2e-plan-ui-failure");
      } catch (screenshotError) {
        console.error(`FAILURE SCREENSHOT unavailable: ${errorText(screenshotError)}`);
      }
    }
  } finally {
    try {
      await cleanup(state);
    } catch (cleanupError) {
      const message = `cleanup failed: ${errorText(cleanupError)}`;
      console.error(`FAIL ${message}`);
      primaryError ||= new Error(message);
    }
  }

  for (const id of CASE_IDS) {
    if (!results.has(id)) {
      record(id, false, primaryError ? `not run after fatal failure: ${shortText(primaryError.message)}` : "not run");
    }
  }

  const failed = [...results.values()].filter((result) => !result.ok);
  const passed = [...results.values()].filter((result) => result.ok);
  console.log(`SUMMARY ${passed.length} passed, ${failed.length} failed`);
  if (state.screenshots.length) {
    console.log("SCREENSHOTS");
    for (const path of state.screenshots) console.log(path);
  }
  if (state.consoleDiagnostics.length) {
    const unexpected = state.consoleDiagnostics.filter(
      (entry) => !expectedDiagnostic(entry.text),
    );
    console.log(`CONSOLE ${state.consoleDiagnostics.length} diagnostic(s), ${unexpected.length} unexpected`);
  } else {
    console.log("CONSOLE 0 diagnostics");
  }
  if (primaryError || failed.length) process.exitCode = 1;
}

main().catch((error) => {
  for (const id of CASE_IDS) record(id, false, `startup failure: ${shortText(errorText(error))}`);
  console.error(`FATAL ${errorText(error)}`);
  console.log(`SUMMARY 0 passed, ${CASE_IDS.length} failed`);
  process.exitCode = 1;
});
