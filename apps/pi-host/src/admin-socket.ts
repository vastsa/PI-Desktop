import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { PROVIDER_SYNC_MAX_PROVIDERS, type ProviderCreateInput, type ProviderImportEntry, type ProviderImportPayload, type ProviderImportSummary } from "@pi-desktop/shared";

import { writeJsonAtomic } from "./credentials.js";
import type { HostLogger } from "./logger.js";

/**
 * Local admin channel: a Unix socket under `<dataDir>/pi-host/`, owner-only,
 * one JSON request per connection. It lets `pi-host provider-import` hand
 * provider configs (with keys) to the running host-core without ever
 * spawning a second one. Payloads are never logged or echoed.
 */

export const ADMIN_MAX_BYTES = 1024 * 1024;
export const ADMIN_MAX_PROVIDERS = PROVIDER_SYNC_MAX_PROVIDERS;

export type HostCaller = { call<T = unknown>(method: string, params?: unknown): Promise<T> };

export type AdminRequest = { op: "providers.import"; payload: ProviderImportPayload };
export type AdminResponse = { ok: true; summary: ProviderImportSummary } | { ok: false; code: string; message: string };

export class AdminError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function adminSocketPath(dataDir: string): string {
  return join(dataDir, "pi-host", "admin.sock");
}

export function providerSyncPath(dataDir: string): string {
  return join(dataDir, "pi-host", "provider-sync.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): AdminError {
  return new AdminError("INVALID_REQUEST", message);
}

const STRING_FIELDS = ["vendorKey", "protocol", "baseUrl", "authKind", "defaultModelId", "secretValue", "apiStyle", "oauthAccountLabel"] as const;
const NUMBER_FIELDS = ["contextWindow", "maxOutputTokens", "temperature"] as const;
const INPUT_FIELDS = new Set<string>([
  "name",
  "type",
  "models",
  "headers",
  "supportsReasoning",
  "supportedThinkingLevels",
  ...STRING_FIELDS,
  ...NUMBER_FIELDS,
]);
const PROVIDER_TYPES = new Set(["native", "openai_compatible", "custom"]);

function validateInput(value: unknown, index: number): ProviderCreateInput {
  const at = `providers[${index}].input`;
  if (!isRecord(value)) throw invalid(`${at} must be an object`);
  for (const key of Object.keys(value)) if (!INPUT_FIELDS.has(key)) throw invalid(`${at} has unknown field ${key}`);
  if (typeof value.name !== "string" || !value.name.trim()) throw invalid(`${at}.name must be a non-empty string`);
  for (const key of STRING_FIELDS) if (value[key] !== undefined && typeof value[key] !== "string") throw invalid(`${at}.${key} must be a string`);
  for (const key of NUMBER_FIELDS) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw invalid(`${at}.${key} must be a number`);
  if (value.type !== undefined && (typeof value.type !== "string" || !PROVIDER_TYPES.has(value.type))) throw invalid(`${at}.type is invalid`);
  if (value.supportsReasoning !== undefined && typeof value.supportsReasoning !== "boolean") throw invalid(`${at}.supportsReasoning must be a boolean`);
  if (value.supportedThinkingLevels !== undefined && (!Array.isArray(value.supportedThinkingLevels) || value.supportedThinkingLevels.some((level) => typeof level !== "string"))) {
    throw invalid(`${at}.supportedThinkingLevels must be a string array`);
  }
  if (value.headers !== undefined && (!isRecord(value.headers) || Object.values(value.headers).some((header) => typeof header !== "string"))) {
    throw invalid(`${at}.headers must map strings to strings`);
  }
  if (value.models !== undefined) {
    // Model bindings are validated in depth by host-core; here only the shape.
    if (!Array.isArray(value.models) || value.models.length > 512) throw invalid(`${at}.models must be an array`);
    for (const model of value.models) if (!isRecord(model) || typeof model.id !== "string" || !model.id) throw invalid(`${at}.models entries need a string id`);
  }
  return value as ProviderCreateInput;
}

/** Strict validation of one admin request; never echoes field values. */
export function parseAdminRequest(value: unknown): AdminRequest {
  if (!isRecord(value)) throw invalid("request must be an object");
  for (const key of Object.keys(value)) if (key !== "op" && key !== "payload") throw invalid(`unknown request field ${key}`);
  if (value.op !== "providers.import") throw new AdminError("UNKNOWN_OP", "unknown op");
  const payload = value.payload;
  if (!isRecord(payload)) throw invalid("payload must be an object");
  for (const key of Object.keys(payload)) if (!["version", "providers", "defaultModel"].includes(key)) throw invalid(`unknown payload field ${key}`);
  if (payload.version !== 1) throw invalid("unsupported payload version");
  if (!Array.isArray(payload.providers)) throw invalid("providers must be an array");
  if (payload.providers.length > ADMIN_MAX_PROVIDERS) throw invalid(`at most ${ADMIN_MAX_PROVIDERS} providers`);
  const seen = new Set<string>();
  const providers: ProviderImportEntry[] = payload.providers.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) throw invalid(`providers[${index}] must be an object`);
    for (const key of Object.keys(entry)) if (key !== "sourceId" && key !== "input") throw invalid(`providers[${index}] has unknown field ${key}`);
    if (typeof entry.sourceId !== "string" || !entry.sourceId || entry.sourceId.length > 256) throw invalid(`providers[${index}].sourceId must be a string`);
    if (seen.has(entry.sourceId)) throw invalid(`duplicate sourceId at providers[${index}]`);
    seen.add(entry.sourceId);
    return { sourceId: entry.sourceId, input: validateInput(entry.input, index) };
  });
  let defaultModel: ProviderImportPayload["defaultModel"];
  if (payload.defaultModel !== undefined) {
    const candidate = payload.defaultModel;
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => key !== "sourceId" && key !== "modelId")) throw invalid("defaultModel is invalid");
    if (typeof candidate.sourceId !== "string" || typeof candidate.modelId !== "string" || !candidate.modelId) throw invalid("defaultModel fields must be strings");
    defaultModel = { sourceId: candidate.sourceId, modelId: candidate.modelId };
  }
  return { op: "providers.import", payload: { version: 1, providers, ...(defaultModel ? { defaultModel } : {}) } };
}

type SyncFile = { version: 1; providers: Record<string, string> };

async function readSyncFile(path: string): Promise<SyncFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) throw new AdminError("INTERNAL", "provider-sync.json is malformed");
  const providers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.providers)) if (typeof value === "string") providers[key] = value;
  return { version: 1, providers };
}

/**
 * Upsert providers through the running host-core. Mapped rows are updated,
 * plugin-owned rows are skipped, missing rows are recreated; nothing is deleted.
 */
export async function importProviders(host: HostCaller, syncPath: string, payload: ProviderImportPayload): Promise<ProviderImportSummary> {
  const sync = await readSyncFile(syncPath);
  const listed = await host.call<{ providers?: Array<{ id: string; ownerPluginId?: string }> }>("providers.list", { includeDisabled: true });
  const rows = new Map((listed.providers ?? []).map((row) => [row.id, row]));
  const summary: ProviderImportSummary = { imported: [], skipped: [], defaultSet: false };
  try {
    for (const entry of payload.providers) {
      const mappedId = sync.providers[entry.sourceId];
      const row = mappedId ? rows.get(mappedId) : undefined;
      if (row?.ownerPluginId) {
        summary.skipped.push({ sourceId: entry.sourceId, reason: "plugin_owned" });
        continue;
      }
      if (row) {
        await host.call("providers.update", { ...entry.input, id: row.id });
        summary.imported.push({ sourceId: entry.sourceId, providerId: row.id, action: "updated" });
        continue;
      }
      const created = await host.call<{ provider?: { id?: unknown } }>("providers.create", entry.input);
      const id = created.provider?.id;
      if (typeof id !== "string") throw new AdminError("INTERNAL", "host-core returned no provider id");
      sync.providers[entry.sourceId] = id;
      summary.imported.push({ sourceId: entry.sourceId, providerId: id, action: "created" });
    }
  } finally {
    // Persist whatever was created, even when a later entry failed.
    await writeJsonAtomic(syncPath, sync);
  }
  const wanted = payload.defaultModel;
  const target = wanted ? summary.imported.find((item) => item.sourceId === wanted.sourceId) : undefined;
  if (wanted && target) {
    await host.call("settings.set", { defaultProviderId: target.providerId, defaultModelId: wanted.modelId });
    summary.defaultSet = true;
  }
  return summary;
}

function errorCode(error: unknown): string {
  if (error instanceof AdminError) return error.code;
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "INTERNAL";
}

/** Message safe to return: validation text is ours; host errors collapse to the code. */
function errorMessage(error: unknown): string {
  return error instanceof AdminError ? error.message : "host-core rejected the import";
}

export type AdminHandlerDeps = { getHost: () => HostCaller | null; syncPath: string; log: HostLogger };

export async function handleAdminRaw(raw: string, deps: AdminHandlerDeps): Promise<AdminResponse> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid("request is not valid JSON");
    }
    const request = parseAdminRequest(parsed);
    const host = deps.getHost();
    if (!host) throw new AdminError("HOST_UNAVAILABLE", "host-core is not running");
    const summary = await importProviders(host, deps.syncPath, request.payload);
    deps.log("info", "providers imported", { imported: summary.imported.length, skipped: summary.skipped.length, defaultSet: summary.defaultSet });
    return { ok: true, summary };
  } catch (error) {
    const code = errorCode(error);
    deps.log("warn", "admin request failed", { code });
    return { ok: false, code, message: errorMessage(error) };
  }
}

function serve(socket: Socket, deps: AdminHandlerDeps): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  let started = false;
  const respond = (response: AdminResponse) => {
    if (done) return;
    done = true;
    socket.end(`${JSON.stringify(response)}\n`);
  };
  const finish = () => {
    if (done || started) return;
    started = true;
    const text = Buffer.concat(chunks).toString("utf8");
    const newline = text.indexOf("\n");
    void handleAdminRaw(newline >= 0 ? text.slice(0, newline) : text, deps).then(respond);
  };
  socket.on("data", (chunk: Buffer) => {
    if (done) return;
    size += chunk.length;
    if (size > ADMIN_MAX_BYTES) {
      chunks.length = 0;
      respond({ ok: false, code: "PAYLOAD_TOO_LARGE", message: "request exceeds 1 MiB" });
      socket.destroySoon();
      return;
    }
    chunks.push(chunk);
    if (chunk.includes(0x0a)) finish();
  });
  socket.on("end", finish);
  socket.on("error", (error) => deps.log("warn", "admin connection error", { error: error.message }));
}

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export type AdminSocket = { path: string; close(): Promise<void> };

/** Start the admin channel; returns null when it cannot be (or must not be) served. */
export async function startAdminSocket(options: { dataDir: string; getHost: () => HostCaller | null; log: HostLogger; syncPath?: string }): Promise<AdminSocket | null> {
  const { log } = options;
  if (process.platform === "win32") {
    log("info", "admin socket is not supported on Windows; provider import disabled");
    return null;
  }
  const dir = join(options.dataDir, "pi-host");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = adminSocketPath(options.dataDir);
  if (await probe(path)) {
    log("warn", "another pi-host owns the admin socket; running without the admin channel", { path });
    return null;
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const deps: AdminHandlerDeps = { getHost: options.getHost, syncPath: options.syncPath ?? providerSyncPath(options.dataDir), log };
  // Half-open: the client ends its write side, then waits for the reply.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => serve(socket, deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  server.on("error", (error) => log("warn", "admin socket error", { error: error.message }));
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") log("warn", "admin socket unlink failed", { error: error.message });
      });
    },
  };
}

/** Client side used by `pi-host provider-import`. */
export function sendAdminRequest(path: string, body: string): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(`${body}\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error: NodeJS.ErrnoException) => reject(new AdminError("ADMIN_UNAVAILABLE", error.code ?? "connect failed")));
    socket.once("close", () => {
      const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && typeof parsed.ok === "boolean") return resolve(parsed as AdminResponse);
      } catch {
        // fall through to the protocol error below
      }
      reject(new AdminError("ADMIN_UNAVAILABLE", "no response from pi-host"));
    });
  });
}
