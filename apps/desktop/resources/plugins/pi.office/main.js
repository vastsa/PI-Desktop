"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// DOCX is a ZIP container, so the plugin keeps the byte limit explicit rather
// than letting an accidental path open turn into an unbounded memory read.
const MAX_DOCX_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024;

const DENY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "_netrc",
]);
const DENY_EXACT_NAMES = new Set([".env"]);
const DENY_NAME_PREFIXES = [".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

let dataPath = null;

function failure(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "OFFICE_ERROR",
    message: String(error?.message ?? error),
  };
}

function isAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function denyReason(value) {
  const normalized = String(value).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower) || DENY_EXACT_NAMES.has(lower)) return "credential path";
    if (DENY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "credential path";
    if (DENY_EXTENSIONS.has(path.posix.extname(lower))) return "credential path";
  }
  return null;
}

function assertDocxPath(abs) {
  if (path.extname(abs).toLowerCase() !== ".docx") {
    throw failure("UNSUPPORTED_TYPE", "pi.office only opens .docx files");
  }
  const reason = denyReason(abs);
  if (reason) throw failure("DENIED_PATH", `refused path: ${reason}`);
}

async function workspaceRoot() {
  const workspace = await pi.workspace.get().catch(() => null);
  if (!workspace?.path || typeof workspace.path !== "string") {
    throw failure("NO_WORKSPACE", "no project is open for a relative DOCX path");
  }
  return path.resolve(workspace.path);
}

async function assertContainedPath(root, abs) {
  const realRoot = await fs.realpath(root).catch(() => root);
  const targetProbe = await fs.realpath(abs).catch(async () => fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs)));
  if (!isInside(realRoot, targetProbe)) {
    throw failure("SYMLINK_ESCAPE", "path escapes the project root");
  }
}

async function resolveTarget(payload) {
  const raw = typeof payload?.path === "string" ? payload.path.trim() : "";
  if (!raw) throw failure("INVALID_PATH", "path is required");

  const external = payload?.external === true;
  const absolute = isAbsolutePath(raw);
  if (absolute && external) {
    const abs = path.resolve(raw);
    assertDocxPath(abs);
    const real = await fs.realpath(abs).catch(() => null);
    if (real) assertDocxPath(real);
    return { abs, relative: null, external: true };
  }

  const root = await workspaceRoot();
  const abs = absolute ? path.resolve(raw) : path.resolve(root, raw);
  if (!isInside(root, abs)) throw failure("ESCAPE", "path escapes the project root");
  await assertContainedPath(root, abs);
  assertDocxPath(abs);
  return {
    abs,
    relative: path.relative(root, abs).split(path.sep).join("/"),
    external: false,
  };
}

async function readBytes(abs) {
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw failure("NOT_FOUND", "DOCX file not found");
  if (!stat.isFile()) throw failure("INVALID_PATH", "path is not a file");
  if (stat.size > MAX_DOCX_BYTES) throw failure("TOO_LARGE", "DOCX exceeds the 64 MiB limit");
  const data = await fs.readFile(abs);
  return { stat, data };
}

function hashBytes(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileResult(target, stat, data) {
  return {
    ok: true,
    path: target.abs,
    name: path.basename(target.abs),
    dataBase64: data.toString("base64"),
    hash: hashBytes(data),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    external: target.external,
  };
}

async function handleRead(payload) {
  const target = await resolveTarget(payload);
  const { stat, data } = await readBytes(target.abs);
  return fileResult(target, stat, data);
}

async function atomicWrite(abs, data, mode) {
  const temp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(temp, "w");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    if (mode != null) await fs.chmod(temp, mode).catch(() => {});
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temp, abs);
        return;
      } catch (error) {
        const transient = ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function handleSave(payload) {
  const target = await resolveTarget(payload);
  const encoded = typeof payload?.dataBase64 === "string" ? payload.dataBase64 : "";
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > MAX_DOCX_BYTES) {
    throw failure("TOO_LARGE", "DOCX data is empty or exceeds the 64 MiB limit");
  }

  const current = await readBytes(target.abs);
  const currentHash = hashBytes(current.data);
  const mtimeChanged =
    typeof payload?.expectedMtimeMs === "number" &&
    Math.abs(current.stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
  const sizeChanged =
    typeof payload?.expectedSize === "number" && current.stat.size !== payload.expectedSize;
  const hashChanged =
    typeof payload?.expectedHash === "string" && currentHash !== payload.expectedHash;
  if ((mtimeChanged || sizeChanged || hashChanged) && payload?.force !== true) {
    return {
      ok: false,
      reason: "external-modified",
      code: "CONFLICT",
      message: "the DOCX changed on disk since it was opened",
      mtimeMs: current.stat.mtimeMs,
      size: current.stat.size,
      hash: currentHash,
    };
  }

  await atomicWrite(target.abs, data, current.stat.mode);
  const next = await readBytes(target.abs);
  return {
    ok: true,
    path: target.abs,
    hash: hashBytes(next.data),
    size: next.stat.size,
    mtimeMs: next.stat.mtimeMs,
  };
}

async function handleConflict(payload) {
  const target = await resolveTarget(payload);
  if (payload?.metadataOnly === true) {
    const stat = await fs.stat(target.abs).catch(() => null);
    if (!stat) throw failure("NOT_FOUND", "DOCX file not found");
    if (!stat.isFile()) throw failure("INVALID_PATH", "path is not a file");
    if (stat.size > MAX_DOCX_BYTES) throw failure("TOO_LARGE", "DOCX exceeds the 64 MiB limit");
    const mtimeChanged =
      typeof payload?.expectedMtimeMs === "number" &&
      Math.abs(stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
    const sizeChanged =
      typeof payload?.expectedSize === "number" && stat.size !== payload.expectedSize;
    return {
      ok: true,
      conflict: mtimeChanged || sizeChanged,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  }
  const current = await readBytes(target.abs);
  const hash = hashBytes(current.data);
  return {
    ok: true,
    conflict:
      (typeof payload?.expectedMtimeMs === "number" && Math.abs(current.stat.mtimeMs - payload.expectedMtimeMs) > 0.5) ||
      (typeof payload?.expectedSize === "number" && current.stat.size !== payload.expectedSize) ||
      (typeof payload?.expectedHash === "string" && hash !== payload.expectedHash),
    mtimeMs: current.stat.mtimeMs,
    size: current.stat.size,
    hash,
  };
}

async function handleRecovery(payload) {
  const encoded = typeof payload?.dataBase64 === "string" ? payload.dataBase64 : "";
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length > MAX_RECOVERY_BYTES) {
    throw failure("TOO_LARGE", "recovery DOCX is empty or too large");
  }
  if (!dataPath) return { ok: false, error: "plugin data path unavailable" };
  const recoveryDir = path.join(dataPath, "recovery");
  await fs.mkdir(recoveryDir, { recursive: true });
  const source = typeof payload?.path === "string" ? payload.path : "untitled.docx";
  const key = crypto.createHash("sha256").update(source).digest("hex");
  const target = path.join(recoveryDir, `${key}.docx`);
  await atomicWrite(target, data, null);
  return { ok: true };
}

const CHANNELS = {
  "office.read": handleRead,
  "office.save": handleSave,
  "office.checkConflict": handleConflict,
  "office.recovery": handleRecovery,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
}

module.exports = { onLoad, onPanelInvoke };
