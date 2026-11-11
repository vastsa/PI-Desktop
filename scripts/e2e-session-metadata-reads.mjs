#!/usr/bin/env node
/**
 * E2E-SESSION-metadata-reads-skip-transcript — main-process lookups that only
 * need a session's metadata (Browser file roots, composer paste/import) must
 * not read the whole transcript through host-core `session.get`.
 *
 * 1. Seeds a real host-core with a session whose transcript is ~40 MB and
 *    measures an unbounded `session.get` against a `messageLimit: 1` read,
 *    asserting the bounded read carries the same metadata.
 * 2. Launches the built desktop app on that data with a throwaway profile and
 *    drives the real preload IPC from the renderer over CDP: composer paste
 *    and Browser navigate on the long session must succeed and stay well under
 *    the unbounded read time.
 *
 * Requires a desktop build (`pnpm --filter @pi-desktop/desktop build`) and a
 * host-core binary (target/{debug,release} or PI_DESKTOP_HOST_BIN).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

const MESSAGE_COUNT = 320;
const MESSAGE_BYTES = 128 * 1024;
const METADATA_KEYS = ["id", "projectPath", "worktree", "mode", "modelId", "providerId", "thinkingLevel", "remoteWorkspace"];

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const { electronBinary } = resolveElectronBinary(root);
const hostBinary = resolveHostBinary();
// host-core canonicalizes project paths (macOS /var -> /private/var).
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-session-metadata-reads-")));
const dataDir = join(scratch, "data");
const workspace = join(scratch, "workspace");
await mkdir(workspace, { recursive: true });

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timed = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};

let app = null;
let server = null;
try {
  // --- 1. host-core contract on a long transcript ---------------------------
  const host = new Host(hostBinary, dataDir, { quiet: true });
  await host.start();
  const session = await createSession(host, workspace, "Long transcript");
  const control = await createSession(host, workspace, "Short transcript");
  // Quotes and newlines make the transcript cost JSON escaping, like real tool output.
  const filler = 'line "quoted" \\ text\n'.repeat(MESSAGE_BYTES / 24);
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    await host.call("session.appendMessage", {
      sessionId: session.id,
      message: {
        id: `m${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index} ${filler}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        status: "complete",
      },
    });
  }
  const fullRuns = [];
  const boundedRuns = [];
  let full;
  let bounded;
  for (let run = 0; run < 3; run += 1) {
    const a = await timed(() => host.call("session.get", { id: session.id }));
    const b = await timed(() => host.call("session.get", { id: session.id, messageLimit: 1 }));
    fullRuns.push(a.ms);
    boundedRuns.push(b.ms);
    full = a.value.session;
    bounded = b.value.session;
  }
  assert.equal(full.messages.length, MESSAGE_COUNT);
  assert.ok(bounded.messages.length <= 1, "bounded read returned the transcript");
  for (const key of METADATA_KEYS) {
    assert.deepEqual(bounded[key], full[key], `bounded session.get changed ${key}`);
  }
  assert.equal(bounded.projectPath, workspace);
  const fullMs = median(fullRuns);
  console.log(`host session.get: full ${fullMs.toFixed(1)}ms, messageLimit:1 ${median(boundedRuns).toFixed(1)}ms`);
  await host.stop();

  // --- 2. real desktop IPC on the same data ---------------------------------
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>metadata-reads</title><p>ok</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBinary, ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = spawn(
    electronBinary,
    [".", `--user-data-dir=${join(scratch, "profile")}`, "--remote-debugging-port=0"],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const debuggerUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no DevTools endpoint\n${output.slice(-2000)}`)), 60_000);
    const onData = (chunk) => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    app.stdout.on("data", onData);
    app.stderr.on("data", onData);
    app.once("exit", (code) => reject(new Error(`app exited ${code}\n${output.slice(-2000)}`)));
  });
  const { port } = new URL(debuggerUrl);

  let page = null;
  for (let attempt = 0; attempt < 120 && !page; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    // The main window loads index.html without a `surface` query (launcher,
    // overlays and voice widgets add one).
    page = targets.find((target) => target.type === "page" && /renderer\/index\.html$/.test(target.url));
    if (!page) await delay(250);
  }
  assert.ok(page, "desktop renderer page not found");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const evaluate = async (expression) => {
    const id = (nextId += 1);
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return reply.result.result.value;
  };
  // Runs one preload IPC call in the renderer (main replies with an
  // `{ ok, data | error }` envelope) and reports its round-trip time.
  const invoke = (channel, payload) =>
    evaluate(`(async () => {
      const start = performance.now();
      try {
        const reply = await window.piDesktop.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)});
        const ms = performance.now() - start;
        return reply.ok ? { ok: true, value: reply.data, ms } : { ok: false, error: reply.error?.message, ms };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), ms: performance.now() - start };
      }
    })()`);
  const retry = async (channel, payload) => {
    let last;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      last = await invoke(channel, payload);
      if (last.ok) return last;
      await delay(250);
    }
    throw new Error(`${channel} kept failing: ${last?.error}`);
  };

  const pastePayload = (sessionId, index) => ({
    sessionId,
    files: [{ name: `note-${index}.txt`, mimeType: "text/plain", data: `paste ${index}` }],
  });
  // ArrayBuffer data is built in the renderer; JSON cannot carry it.
  const paste = (sessionId, index) =>
    evaluate(`(async () => {
      const payload = ${JSON.stringify(pastePayload(sessionId, index))};
      payload.files = payload.files.map((file) => ({ ...file, data: new TextEncoder().encode(file.data).buffer }));
      const start = performance.now();
      try {
        const reply = await window.piDesktop.invoke("pi-desktop/composer/pasteFiles", payload);
        const ms = performance.now() - start;
        return reply.ok ? { ok: true, value: reply.data, ms } : { ok: false, error: reply.error?.message, ms };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), ms: performance.now() - start };
      }
    })()`);

  let warm;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    warm = await paste(session.id, "warm");
    if (warm.ok) break;
    await delay(250);
  }
  assert.ok(warm?.ok, `composer paste failed: ${warm?.error}`);
  await retry("pi-desktop/browser/navigate", { url: pageUrl, sessionId: session.id });

  // Each operation runs on the long and the short session; only the
  // transcript size differs, so the gap is what the session lookup costs.
  const measure = async (sessionId) => {
    const pasteRuns = [];
    const navigateRuns = [];
    for (let index = 0; index < 5; index += 1) {
      const pasted = await paste(sessionId, index);
      assert.ok(pasted.ok, `composer paste failed: ${pasted.error}`);
      const [file] = pasted.value.files;
      assert.equal(await readFile(file.path, "utf8"), `paste ${index}`);
      pasteRuns.push(pasted.ms);
      const navigated = await retry("pi-desktop/browser/navigate", { url: `${pageUrl}?s=${sessionId}&n=${index}`, sessionId });
      assert.ok(String(navigated.value?.url ?? "").startsWith(pageUrl), `navigate returned ${JSON.stringify(navigated.value)}`);
      navigateRuns.push(navigated.ms);
    }
    return { paste: median(pasteRuns), navigate: median(navigateRuns) };
  };
  const shortRun = await measure(control.id);
  const longRun = await measure(session.id);
  console.log(
    `desktop IPC median — paste: short ${shortRun.paste.toFixed(1)}ms / long ${longRun.paste.toFixed(1)}ms; ` +
      `browser navigate: short ${shortRun.navigate.toFixed(1)}ms / long ${longRun.navigate.toFixed(1)}ms`,
  );
  // An unbounded transcript read would add at least `fullMs` to each long-session call.
  for (const [name, gap] of [["paste", longRun.paste - shortRun.paste], ["navigate", longRun.navigate - shortRun.navigate]]) {
    assert.ok(gap < fullMs / 2, `${name} on the long session costs ${gap.toFixed(1)}ms more; full read is ${fullMs.toFixed(1)}ms`);
  }
  socket.close();
  console.log("PASS session metadata reads skip the transcript");
} finally {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => app.once("exit", resolve)), delay(10_000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  server?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
