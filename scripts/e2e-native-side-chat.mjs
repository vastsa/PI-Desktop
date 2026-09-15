#!/usr/bin/env node
/**
 * Runnable native Pi side-chat journey (E2E-SESSION-native-side-chat-fork-survives-close).
 *
 * Real pieces: the Electron main process hosts the real NativePiSessionService
 * and SDK SessionManager persistence over a temporary agent/session root with
 * an injected synthetic ModelRuntime (no network); the renderer bundle hosts
 * the real app store, session/queue/events slices, SideChatTab and
 * SearchDialog, talking over a real preload/ipcRenderer bridge with the same
 * channel names the app uses.
 *
 * Boundary note: this is not the production main process or the production
 * sidecar transport. The fork route is exercised at the same service call the
 * sidecar makes (`service.fork`), with the real renderer `api.forkSession`
 * contract above it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
// Offline installs skip Electron's download; CI/dev may point at an existing
// signed app bundle through this override instead.
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BINARY ?? resolveElectronBinary(root).electronBinary;
const temp = await mkdtemp(join(tmpdir(), "pi-native-side-chat-"));
const project = join(temp, "fixture-project");

const parentEntries = [
  { type: "session", version: 3, id: "probe-parent", timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-14T00:00:00.500Z", provider: "test-provider", modelId: "test-model" },
  { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-14T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "test-provider", model: "test-model", stopReason: "stop", timestamp: 2 } },
  { type: "custom", id: "future", parentId: "a1", timestamp: "2026-09-14T00:00:03.000Z", customType: "opaque", data: { retained: true } },
];
const longEntries = [
  { type: "session", version: 3, id: "probe-long", timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-14T00:00:00.500Z", provider: "test-provider", modelId: "test-model" },
];
{
  let parentId = "m1";
  for (let index = 0; index < 520; index += 1) {
    longEntries.push({
      type: "message",
      id: `u${index}`,
      parentId,
      timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `row ${index}` }], timestamp: index },
    });
    parentId = `u${index}`;
  }
}

try {
  const agentDir = join(temp, "agent");
  const group = join(agentDir, "sessions", "--fixture-project--");
  await mkdir(group, { recursive: true });
  await mkdir(project);
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "http://127.0.0.1/unused",
          api: "openai-completions",
          models: [
            {
              id: "test-model",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ "test-provider": { type: "api_key", key: "synthetic-probe-key" } }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
  );
  const parentFile = join(group, "probe-parent.jsonl");
  await writeFile(parentFile, `${parentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(join(group, "probe-long.jsonl"), `${longEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  await build({
    entryPoints: [join(root, "scripts/e2e/native-side-chat.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "node_modules"), join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Native side chat probe</title><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "preload.cjs"),
    `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("piDesktop", {
  invoke: (channel, ...args) => ipcRenderer.invoke("probe.invoke", channel, args),
  on: (channel, listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  channels: {},
  platform: process.platform,
  locale: "en",
});
`,
  );
  await writeFile(
    join(temp, "fixture.json"),
    JSON.stringify({
      agentDir,
      sessionRoot: join(agentDir, "sessions"),
      parentFile,
      agentRuntimeEntry: join(root, "packages/agent-runtime/dist/native-pi-session.js"),
      leaseEntry: join(root, "packages/agent-runtime/dist/native-pi-session-lease.js"),
      piAiEntry: join(root, "packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js"),
      piCodingAgentEntry: join(root, "packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    }),
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

app.setPath("userData", path.join(__dirname, "profile"));
app.commandLine.appendSwitch("host-resolver-rules", "MAP * 0.0.0.0");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const parentBytes = fs.readFileSync(FIXTURE.parentFile);
const initialHash = sha256(parentBytes);

function assistantMessage(stopReason, text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    stopReason,
    timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function chunkedStream(piAi, signal) {
  const stream = piAi.createAssistantMessageEventStream();
  const text = "fixture reply";
  const pieces = [text.slice(0, 5), text.slice(5, 8), text.slice(8)];
  let index = 0;
  let settled = false;
  const abortNow = () => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    const text = pieces.slice(0, index).join("");
    const message = {
      ...assistantMessage("aborted", text),
      content: text ? [{ type: "text", text }] : [],
    };
    stream.push({ type: "error", reason: "aborted", error: message });
    stream.end(message);
  };
  const timer = setInterval(() => {
    if (signal?.aborted) return abortNow();
    if (index === pieces.length) {
      settled = true;
      clearInterval(timer);
      const message = assistantMessage("stop", text);
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return;
    }
    if (index === 0) stream.push({ type: "start", partial: assistantMessage("stop", "") });
    const partial = assistantMessage("stop", pieces.slice(0, index + 1).join(""));
    stream.push({ type: "text_delta", contentIndex: 0, delta: pieces[index], partial });
    index += 1;
  }, 180);
  signal?.addEventListener("abort", abortNow);
  return stream;
}

async function main() {
  const { NativePiSessionService } = await import(pathToFileURL(FIXTURE.agentRuntimeEntry).href);
  const { acquireNativePiSessionLease } = await import(pathToFileURL(FIXTURE.leaseEntry).href);
  const piAi = await import(pathToFileURL(FIXTURE.piAiEntry).href);
  const { ModelRuntime } = await import(pathToFileURL(FIXTURE.piCodingAgentEntry).href);
  // Bounded synthetic provider: the service still initializes the real offline
  // ModelRuntime from the temporary agent directory; only the streaming call is
  // replaced with a chunked synthetic response.
  globalThis.fetch = () => Promise.reject(new Error("Network forbidden in native side-chat probe"));
  ModelRuntime.prototype.streamSimple = function streamSimple(_model, _context, options) {
    return chunkedStream(piAi, options?.signal);
  };
  let service = new NativePiSessionService({
    agentDir: FIXTURE.agentDir,
    sessionRoot: FIXTURE.sessionRoot,
  });
  let promptCount = 0;
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const channels = {
    "pi-desktop/session/list": async () => ({ sessions: await service.list() }),
    "pi-desktop/session/search": async (_event, input) =>
      service.search(String(input?.query ?? "")),
    "pi-desktop/session/get": async (_event, input) => ({
      session: service.detail(String(input.id), {
        messageBefore: input.messageBefore,
        messageAround: input.messageAround,
        messageLimit: input.messageLimit,
        contentLimit: input.contentLimit,
      }),
    }),
    "pi-desktop/session/fork": async (_event, input) => ({
      session: service.fork({
        id: String(input.sessionId),
        title: typeof input.title === "string" ? input.title : undefined,
        throughMessageId: typeof input.throughMessageId === "string" ? input.throughMessageId : undefined,
      }),
    }),
    "pi-desktop/agent/prompt": async (_event, request) => {
      const content = String(request.content ?? "");
      promptCount += 1;
      return service.prompt(
        String(request.sessionId),
        content,
        (envelope) => window.webContents.send("pi-desktop/agent/event/message", envelope),
        typeof request.messageId === "string" ? request.messageId : undefined,
      );
    },
    "pi-desktop/agent/abort": async (_event, input) => {
      await service.abort(String(input.sessionId));
      return { ok: true };
    },
  };
  const probes = {
    "probe.sessionCount": async () => ({ count: (await service.list()).length }),
    "probe.detail": async (_event, input) => ({ session: service.detail(String(input.id)) }),
    "probe.promptCount": async () => ({ count: promptCount }),
    "probe.restartService": async () => {
      // Production-equivalent restart: dispose live runtimes and construct a
      // fresh service that must rediscover everything from the JSONL files.
      service.disposeAll();
      service = new NativePiSessionService({
        agentDir: FIXTURE.agentDir,
        sessionRoot: FIXTURE.sessionRoot,
      });
      return { restarted: true };
    },
    "probe.parentBytes": async () => ({
      initial: initialHash,
      hash: sha256(fs.readFileSync(FIXTURE.parentFile)),
    }),
    "probe.forkBusy": async () => {
      // The long parent has no owned runtime, so a live foreign lease must
      // refuse the fork. (An owned idle runtime keeps its own lease by design.)
      const summaries = await service.list();
      const long = summaries.find((session) => session.messageCount === 520);
      const longFile = fs
        .readdirSync(path.join(FIXTURE.sessionRoot, "--fixture-project--"))
        .find((name) => name.startsWith("probe-long"));
      const lease = acquireNativePiSessionLease(
        path.join(FIXTURE.sessionRoot, "--fixture-project--", longFile),
      );
      try {
        service.fork({ id: long.id, title: "blocked" });
        return { code: "NONE" };
      } catch (error) {
        return { code: error?.errorCode ?? error?.code ?? "UNKNOWN" };
      } finally {
        lease.release();
      }
    },
    "probe.forkLong": async () => {
      const summaries = await service.list();
      const long = summaries.find((session) => session.messageCount === 520);
      const child = service.fork({ id: long.id, title: "Long child" });
      return {
        count: child.messages.length,
        hasMoreBefore: child.hasMoreBefore,
        messageStart: child.messageStart,
      };
    },
  };
  ipcMain.handle("probe.invoke", async (event, channel, args) => {
    try {
      const handler = channels[channel] ?? probes[channel];
      if (!handler) throw Object.assign(new Error("probe channel not implemented"), { errorCode: "PROBE_UNIMPLEMENTED" });
      const data = await handler(event, ...(args ?? []));
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.errorCode ?? error?.code ?? "PROBE_ERROR",
          message: error?.message ?? String(error),
        },
      };
    }
  });
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  await window.loadFile(path.join(__dirname, "index.html"));
  const phase1 = await window.webContents.executeJavaScript(
    "globalThis.nativeSideChatProbePhase1()",
  );
  let result = phase1;
  if (phase1?.ok && phase1.phase2) {
    await probes["probe.restartService"]();
    const loaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    window.webContents.reload();
    await loaded;
    const phase2 = await window.webContents.executeJavaScript(
      "globalThis.nativeSideChatProbePhase2(" + JSON.stringify(phase1.phase2) + ")",
    );
    result = {
      ok: Boolean(phase2?.ok),
      error: phase2?.error,
      checks: [...(phase1.checks ?? []), ...(phase2?.checks ?? [])],
    };
  }
  console.log("NATIVE_SIDE_CHAT_PROBE " + JSON.stringify(result));
  service.disposeAll();
  app.exit(result?.ok ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.error("NATIVE_SIDE_CHAT_PROBE " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
  app.exit(1);
});
`,
  );

  // Standalone isolation: a temporary HOME/USERPROFILE so SDK default lookups
  // (getAgentDir, trust-manager skills) cannot read the real profile, plus a
  // scrub of inherited native session selectors for the probe process only.
  const env = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("NATIVE_SIDE_CHAT_PROBE "));
  assert(line, `probe returned no result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("NATIVE_SIDE_CHAT_PROBE ".length));
  if (result.checks) {
    for (const check of result.checks) {
      console.log(`${check.ok ? "ok" : "FAIL"} - ${check.name}${check.detail ? ` :: ${check.detail}` : ""}`);
    }
  }
  assert.equal(result.ok, true, output.slice(-6000));
  assert.equal(code, 0, output.slice(-6000));
  console.log("NATIVE_SIDE_CHAT_PROBE PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}
