#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const protocolVersion = 11;
const binary = resolveHostBinary();
const scenarioRoot = await mkdtemp(join(tmpdir(), "pi-index-e2e-"));
const dataDir = join(scenarioRoot, "data");
const workspace = join(scenarioRoot, "workspace");
const outside = join(scenarioRoot, "outside");
await mkdir(dataDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(join(workspace, "README.md"), "workspace index fixture\n", "utf8");

let child;
let lines;
const pending = new Map();
let stderr = "";

try {
  child = spawn(binary, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined || message.id === null) return;
    const entry = pending.get(String(message.id));
    if (!entry) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message);
      error.errorCode = message.error.data?.errorCode;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  });

  await call("app.handshake", { protocolVersion });
  await call("workspace.set", { path: workspace });

  const before = await call("index.status");
  assert(Array.isArray(before.roots) && before.roots.length === 0, "new index must be empty");

  const rebuilt = await call("index.rebuild");
  assert(rebuilt.root.status === "fresh", `expected fresh, got ${rebuilt.root.status}`);
  assert(rebuilt.root.fileCount === 1, `expected one file, got ${rebuilt.root.fileCount}`);

  const status = await call("index.status", { rootPath: workspace });
  assert(status.roots.length === 1, "rebuilt root must be visible");
  assert(status.roots[0].indexedBytes > 0, "indexed byte count must be positive");

  let outsideRejected = false;
  try {
    await call("index.rebuild", { rootPath: outside });
  } catch (error) {
    outsideRejected = error.errorCode === "INDEX_ROOT_OUTSIDE_WORKSPACE";
  }
  assert(outsideRejected, "index RPC must reject a root outside the active workspace");

  const cleared = await call("index.clear", { rootPath: workspace });
  assert(cleared.ok && cleared.cleared === 1, "clear must remove exactly one root");
  const after = await call("index.status");
  assert(after.roots.length === 0, "cleared index must be empty");

  console.log("PASS E2E-INDEX-status-rebuild-clear - isolated index lifecycle RPCs");
} catch (error) {
  console.error(`FAIL E2E-INDEX-status-rebuild-clear - ${error.stack || error}`);
  if (stderr.trim()) console.error(stderr.trim().slice(-2000));
  process.exitCode = 1;
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("host stopped"));
  }
  pending.clear();
  lines?.close();
  if (child && child.exitCode === null) child.kill();
  await rm(scenarioRoot, { recursive: true, force: true });
}

function call(method, params = {}, timeoutMs = 30_000) {
  const id = randomUUID();
  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectResult(new Error(`timeout ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function resolveHostBinary() {
  const name = process.platform === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core";
  const candidates = [
    process.env.PI_DESKTOP_HOST_BIN && resolve(process.env.PI_DESKTOP_HOST_BIN),
    join(root, "target", "debug", name),
    join(root, "..", "..", "..", "target", "debug", name),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`host binary missing; tried ${candidates.join(", ")}`);
  return found;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
