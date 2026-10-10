import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  PROVIDER_SYNC_MAX_BYTES, isSyncableProvider, parseProviderImportPayload, parseProviderImportSummary,
  type ProviderImportPayload, type ProviderImportSummary, type ProviderPublic,
} from "@pi-desktop/shared";

export type HostCaller = { call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> };
export const IMPORT_DEADLINE_MS = 30_000;
export type ImportFailureCode = "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "ADMIN_UNAVAILABLE" | "ADMIN_BUSY" | "TIMEOUT" | "IMPORT_FAILED";
export class ImportFailure extends Error {
  readonly code: ImportFailureCode;
  constructor(code: ImportFailureCode) {
    super(code);
    this.code = code;
  }
}
export function importFailureCode(error: unknown): ImportFailureCode {
  return error instanceof ImportFailure ? error.code : "IMPORT_FAILED";
}

/** Bounded stdin reader, also used by the socket client. Never exposes raw JSON errors. */
export function readCapped(stream: NodeJS.ReadableStream, maxBytes = PROVIDER_SYNC_MAX_BYTES, timeoutMs = IMPORT_DEADLINE_MS): Promise<string> {
  return new Promise((resolveRead, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: ImportFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", failed);
      stream.off("close", closed);
      stream.pause();
      if (error) reject(error);
      else resolveRead(Buffer.concat(chunks).toString("utf8"));
      chunks.length = 0;
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) finish(new ImportFailure("PAYLOAD_TOO_LARGE"));
      else chunks.push(buffer);
    };
    const end = () => finish();
    const failed = () => finish(new ImportFailure("IMPORT_FAILED"));
    const closed = () => finish(new ImportFailure("INVALID_REQUEST"));
    const timer = setTimeout(() => finish(new ImportFailure("TIMEOUT")), timeoutMs);
    stream.on("data", data);
    stream.once("end", end);
    stream.once("error", failed);
    stream.once("close", closed);
  });
}

/** The CLI never resolves binaries or starts host-core: only the running host writes. */
export async function runProviderImport(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process,
): Promise<number> {
  try {
    if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--data-dir" && argv[1])) throw new ImportFailure("INVALID_REQUEST");
    const dataDir = resolve(argv[1] ?? process.env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop"));
    const raw = await readCapped(io.stdin);
    let payload: ProviderImportPayload;
    try { payload = parseProviderImportPayload(JSON.parse(raw)); } catch { throw new ImportFailure("INVALID_REQUEST"); }
    const { sendAdminRequest } = await import("./admin-socket.js");
    const response = await sendAdminRequest(dataDir, payload);
    if (!response.ok) throw new ImportFailure(response.code);
    io.stdout.write(`PI_HOST_PROVIDERS ${JSON.stringify(response.summary)}\n`);
    return 0;
  } catch (error) {
    io.stdout.write(`PI_HOST_FAILED ${JSON.stringify({ code: importFailureCode(error) })}\n`);
    return 1;
  }
}

// A bounded private receipt journal, not a second provider store. HMACs cannot
// disclose an API key, and contain neither provider configuration nor credentials.
// Pending receipts fence the ambiguous crash window between create and its reply.
// Changed imports create new rows; no import ever updates/deletes a remote row.
type Receipt = { providerId?: string; snapshot?: string };
type Journal = { version: 1; salt: string; receipts: Record<string, Receipt> };
const JOURNAL_MAX_ENTRIES = 2048;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
function snapshot(row: ProviderPublic): string {
  return createHash("sha256").update(canonical(row)).digest("hex");
}
async function loadJournal(path: string): Promise<Journal> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, salt: randomBytes(32).toString("hex"), receipts: {} };
    throw new ImportFailure("IMPORT_FAILED");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > PROVIDER_SYNC_MAX_BYTES) throw new ImportFailure("IMPORT_FAILED");
    const raw: unknown = JSON.parse(await file.readFile("utf8"));
    if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("salt" in raw) || typeof raw.salt !== "string" || !/^[a-f0-9]{64}$/.test(raw.salt)
      || !("receipts" in raw) || !raw.receipts || typeof raw.receipts !== "object" || Array.isArray(raw.receipts)) throw new ImportFailure("IMPORT_FAILED");
    const entries = Object.entries(raw.receipts);
    if (entries.length > JOURNAL_MAX_ENTRIES) throw new ImportFailure("IMPORT_FAILED");
    for (const [key, value] of entries) {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !["providerId", "snapshot"].includes(field))) throw new ImportFailure("IMPORT_FAILED");
      const receipt = value as Receipt;
      if ((receipt.providerId !== undefined || receipt.snapshot !== undefined)
        && (typeof receipt.providerId !== "string" || !/^[a-f0-9-]{36}$/i.test(receipt.providerId) || typeof receipt.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(receipt.snapshot))) throw new ImportFailure("IMPORT_FAILED");
    }
    return raw as Journal;
  } finally { await file.close(); }
}
async function saveJournal(path: string, journal: Journal): Promise<void> {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(journal));
    await file.sync();
    await file.close();
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file.close();
    await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Called only under the admin socket's single-import admission fence. */
export async function importProviders(host: HostCaller, dataDir: string, input: ProviderImportPayload, signal: AbortSignal): Promise<ProviderImportSummary> {
  const payload = parseProviderImportPayload(input);
  const path = join(dataDir, "pi-host", "provider-sync.json");
  const journal = await loadJournal(path);
  const summary: ProviderImportSummary = { imported: [], skipped: [], defaultSet: false };
  const check = () => { if (signal.aborted) throw new ImportFailure("TIMEOUT"); };
  for (const entry of payload.providers) {
    check();
    const key = createHmac("sha256", journal.salt).update(canonical(entry)).digest("hex");
    const receipt = journal.receipts[key];
    let row: ProviderPublic;
    if (receipt) {
      if (!receipt.providerId) { summary.skipped.push({ sourceId: entry.sourceId, reason: "import_incomplete" }); continue; }
      const result = await host.call<{ provider: ProviderPublic | null }>("providers.get", { id: receipt.providerId });
      check();
      if (!result.provider) { summary.skipped.push({ sourceId: entry.sourceId, reason: "remote_missing" }); continue; }
      row = result.provider;
      const unchanged = isSyncableProvider(row) && snapshot(row) === receipt.snapshot;
      const secret = !unchanged || row.authKind === "none" ? undefined : (await host.call<{ value: string | null }>("providers.getSecret", { id: row.id })).value;
      check();
      if (!unchanged || (secret ?? undefined) !== entry.input.secretValue) {
        summary.skipped.push({ sourceId: entry.sourceId, reason: "remote_changed" }); continue;
      }
    } else {
      if (Object.keys(journal.receipts).length >= JOURNAL_MAX_ENTRIES) throw new ImportFailure("IMPORT_FAILED");
      journal.receipts[key] = {};
      await saveJournal(path, journal);
      check();
      const created = await host.call<{ provider: ProviderPublic }>("providers.create", { ...entry.input });
      row = created.provider;
      // Validate the public result before persisting its identity or returning it.
      parseProviderImportSummary({ imported: [{ sourceId: entry.sourceId, providerId: row.id }], skipped: [], defaultSet: false });
      journal.receipts[key] = { providerId: row.id, snapshot: snapshot(row) };
      await saveJournal(path, journal);
      check();
    }
    summary.imported.push({ sourceId: entry.sourceId, providerId: row.id });
  }
  const wanted = payload.defaultModel;
  const target = summary.imported.find((entry) => entry.sourceId === wanted?.sourceId);
  if (wanted && target) {
    check();
    const { provider } = await host.call<{ provider: ProviderPublic | null }>("providers.get", { id: target.providerId });
    if (!provider || !isSyncableProvider(provider) || !provider.models.some((model) => model.id === wanted.modelId)) throw new ImportFailure("IMPORT_FAILED");
    check();
    await host.call("settings.set", { defaultProviderId: target.providerId, defaultModelId: wanted.modelId });
    summary.defaultSet = true;
  }
  return summary;
}
