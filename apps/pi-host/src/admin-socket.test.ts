import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ProviderImportPayload, ProviderPublic } from "@pi-desktop/shared";
import { ADMIN_MAX_BYTES, adminSocketPath, prepareAdminDirectory, sendAdminRequest, startAdminSocket, type AdminSocket } from "./admin-socket.js";
import { readCapped, runProviderImport, type HostCaller } from "./provider-import.js";

const initialCwd = process.cwd();
const directories: string[] = [];
const servers: AdminSocket[] = [];
beforeAll(() => { process.chdir(process.env.PI_SCRATCH_DIR ?? tmpdir()); });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(() => { process.chdir(initialCwd); });
async function directory() {
  const dir = await mkdtemp(join(process.cwd(), "provider-admin-"));
  directories.push(dir);
  return dir;
}
function payload(): ProviderImportPayload {
  return { version: 1, providers: [{ sourceId: "source-1", input: {
    name: "Models", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: "https://models.example/v1", authKind: "api_key", secretValue: "fixture-private-key",
    headers: { "x-client": "desktop" }, temperature: 0, models: [
      { id: "first", contextWindow: 10000, maxTokens: 1000, thinkingLevels: ["off"], defaultThinkingLevel: null },
      { id: "chosen", contextWindow: 20000, contextWindowSource: "user", maxTokens: 2000, maxTokensSource: "catalog", thinkingLevels: ["off", "high"], defaultThinkingLevel: "high", thinkingProtocol: "adaptive", supportsImages: false, supportsDocuments: null, nativeWebSearch: true },
    ],
  } }], defaultModel: { sourceId: "source-1", modelId: "chosen" } };
}
class HostFixture implements HostCaller {
  rows = new Map<string, ProviderPublic>();
  secrets = new Map<string, string>();
  settings: Record<string, unknown> = { untouched: true };
  methods: string[] = [];
  failCreate = false;
  beforeCreate?: () => Promise<void>;
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.methods.push(method);
    if (method === "providers.create") {
      await this.beforeCreate?.();
      if (this.failCreate) throw new Error("fixture-private-key");
      const { secretValue, ...publicInput } = params;
      const row = { ...publicInput, id: randomUUID(), enabled: true, hasSecret: Boolean(secretValue), supportsReasoning: false, supportedThinkingLevels: ["off"], createdAt: "1", updatedAt: "1" } as ProviderPublic;
      this.rows.set(row.id, row);
      if (typeof secretValue === "string") this.secrets.set(row.id, secretValue);
      return { provider: structuredClone(row) } as T;
    }
    if (method === "providers.get") return { provider: structuredClone(this.rows.get(String(params.id)) ?? null) } as T;
    if (method === "providers.getSecret") return { value: this.secrets.get(String(params.id)) ?? null } as T;
    if (method === "settings.set") { Object.assign(this.settings, params); return { ok: true } as T; }
    throw new Error("unexpected RPC");
  }
}
async function fixture(options: { timeoutMs?: number; host?: HostFixture } = {}) {
  const dataDir = await directory();
  const host = options.host ?? new HostFixture();
  const logs: unknown[] = [];
  const server = await startAdminSocket({ dataDir, getHost: () => host, timeoutMs: options.timeoutMs, log: (...args) => logs.push(args) });
  servers.push(server);
  return { dataDir, host, server, logs };
}
async function rawRequest(path: string, body: string) {
  const socket = createConnection(path);
  socket.on("error", () => undefined);
  const response = readCapped(socket, ADMIN_MAX_BYTES, 2000);
  socket.once("connect", () => socket.end(body));
  try { return JSON.parse(await response); } finally { socket.destroy(); }
}
async function cli(dataDir: string, input: string) {
  let stdout = "";
  const code = await runProviderImport(["--data-dir", dataDir], {
    stdin: Readable.from([input]), stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
  });
  return { code, stdout };
}

describe("provider import over the real owner-only admin socket", () => {
  it("CLI imports selected models, stores keys through host RPC and is idempotent across restart", async () => {
    const { dataDir, host, server, logs } = await fixture();
    const existing = randomUUID();
    host.rows.set(existing, { id: existing, name: "unrelated" } as ProviderPublic);
    const first = await cli(dataDir, JSON.stringify(payload()));
    expect(first.code).toBe(0);
    const summary = JSON.parse(first.stdout.slice("PI_HOST_PROVIDERS ".length));
    const id = summary.imported[0].providerId as string;
    expect(summary.defaultSet).toBe(true);
    expect(host.rows.get(id)?.models).toEqual(payload().providers[0]!.input.models);
    expect(host.rows.get(id)?.temperature).toBe(0);
    expect(host.secrets.get(id)).toBe("fixture-private-key");
    expect(host.settings).toEqual({ untouched: true, defaultProviderId: id, defaultModelId: "chosen" });
    expect((await lstat(server.path)).mode & 0o777).toBe(0o600);
    await server.close();
    const restarted = await startAdminSocket({ dataDir, getHost: () => host });
    servers.push(restarted);
    expect(await cli(dataDir, JSON.stringify(payload()))).toEqual(first);
    expect(host.rows.size).toBe(2);
    expect(host.rows.get(existing)?.name).toBe("unrelated");
    expect(host.methods).not.toContain("providers.update");
    const journal = await readFile(join(dataDir, "pi-host/provider-sync.json"), "utf8");
    expect(journal).not.toContain("fixture-private-key");
    expect(JSON.stringify(logs) + first.stdout).not.toContain("fixture-private-key");
  });
  it("never overwrites a remotely changed provider or its default", async () => {
    const { dataDir, host } = await fixture();
    const first = await sendAdminRequest(dataDir, payload());
    if (!first.ok) throw new Error("fixture failed");
    const id = first.summary.imported[0]!.providerId;
    host.rows.get(id)!.ownerPluginId = "plugin";
    host.settings.defaultModelId = "remote-choice";
    const next = await sendAdminRequest(dataDir, payload());
    expect(next).toEqual({ ok: true, summary: { imported: [], skipped: [{ sourceId: "source-1", reason: "remote_changed" }], defaultSet: false } });
    expect(host.rows.size).toBe(1);
    expect(host.settings.defaultModelId).toBe("remote-choice");
  });
  it("rejects malformed batches and all non-import operations before host effects", async () => {
    const { server, host } = await fixture();
    const base = payload();
    for (const raw of ["{fixture-private-key", JSON.stringify({ op: "secrets.get", payload: base }),
      JSON.stringify({ op: "providers.import", payload: { ...base, defaultModel: { sourceId: "source-1", modelId: "missing" } } }),
      JSON.stringify({ op: "providers.import", payload: { ...base, providers: [...base.providers, { sourceId: "bad", input: { secretValue: "fixture-private-key" } }] } }),
      JSON.stringify({ op: "providers.import", payload: base }) + "\n{}",
    ]) expect(await rawRequest(server.path, raw)).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(host.methods).toEqual([]);
  });
  it("bounds request bytes and idle connections and cleans up on close", async () => {
    const { server, host } = await fixture({ timeoutMs: 100 });
    expect(await rawRequest(server.path, "x".repeat(ADMIN_MAX_BYTES + 1))).toEqual({ ok: false, code: "PAYLOAD_TOO_LARGE" });
    const idle = createConnection(server.path);
    idle.on("error", () => undefined);
    await once(idle, "close");
    const connected = createConnection(server.path);
    connected.on("error", () => undefined);
    await once(connected, "connect");
    const closed = once(connected, "close");
    await server.close();
    await closed;
    await expect(lstat(server.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(host.methods).toEqual([]);
  });
  it("rejects concurrent imports and fences ambiguous failed creates", async () => {
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { dataDir, host, logs } = await fixture();
    host.beforeCreate = () => { entered(); return waiting; };
    host.failCreate = true;
    const first = sendAdminRequest(dataDir, payload());
    await entering;
    expect(await sendAdminRequest(dataDir, payload())).toEqual({ ok: false, code: "ADMIN_BUSY" });
    release();
    expect(await first).toEqual({ ok: false, code: "IMPORT_FAILED" });
    expect(JSON.stringify(logs)).not.toContain("fixture-private-key");
    expect(await sendAdminRequest(dataDir, payload())).toEqual({ ok: true, summary: { imported: [], skipped: [{ sourceId: "source-1", reason: "import_incomplete" }], defaultSet: false } });
    expect(host.methods.filter((method) => method === "providers.create")).toHaveLength(1);
  });
  it("does not remove another live socket or accept symlinks/world-accessible directories", async () => {
    const { dataDir, server } = await fixture();
    const identity = await lstat(server.path);
    await expect(startAdminSocket({ dataDir, getHost: () => null })).rejects.toMatchObject({ code: "ADMIN_BUSY" });
    expect((await lstat(server.path)).ino).toBe(identity.ino);
    const unsafe = await directory();
    await chmod(unsafe, 0o755);
    await expect(startAdminSocket({ dataDir: unsafe, getHost: () => null })).rejects.toMatchObject({ code: "ADMIN_UNAVAILABLE" });
    const linked = await directory();
    await symlink(join(dataDir, "pi-host"), join(linked, "pi-host"));
    await expect(startAdminSocket({ dataDir: linked, getHost: () => null })).rejects.toMatchObject({ code: "ADMIN_UNAVAILABLE" });
    await expect(sendAdminRequest(linked, payload())).rejects.toMatchObject({ code: "ADMIN_UNAVAILABLE" });
  });
  it("refuses an independently owned live socket even without an admin lock", async () => {
    const dataDir = await directory();
    await prepareAdminDirectory(dataDir);
    const path = adminSocketPath(dataDir);
    const other = createServer((socket) => socket.end());
    other.listen(path);
    await once(other, "listening");
    await chmod(path, 0o600);
    try {
      await expect(startAdminSocket({ dataDir, getHost: () => null })).rejects.toMatchObject({ code: "ADMIN_BUSY" });
      expect((await lstat(path)).isSocket()).toBe(true);
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });
  it("recovers a dead owner's stale socket and lock without a second host process", async () => {
    const dataDir = await directory();
    await prepareAdminDirectory(dataDir);
    const path = adminSocketPath(dataDir);
    const child = spawn(process.execPath, ["-e", "const net=require('node:net');const fs=require('node:fs');net.createServer().listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write('ready');});", path], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout, "data");
      await writeFile(join(dataDir, "pi-host/admin.lock"), String(child.pid), { mode: 0o600 });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const server = await startAdminSocket({ dataDir, getHost: () => null });
      servers.push(server);
      expect(await sendAdminRequest(dataDir, payload())).toEqual({ ok: false, code: "ADMIN_UNAVAILABLE" });
      await server.close();
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { child.kill("SIGKILL"); }
  });
  it("shutdown cancels the rest of an admitted batch and drains the active RPC before releasing ownership", async () => {
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { dataDir, host, server } = await fixture();
    host.beforeCreate = () => { entered(); return waiting; };
    const two = payload();
    two.providers.push({ ...two.providers[0]!, sourceId: "source-2" });
    const request = sendAdminRequest(dataDir, two).catch(() => null);
    await entering;
    const closing = server.close();
    await expect(startAdminSocket({ dataDir, getHost: () => host })).rejects.toMatchObject({ code: "ADMIN_BUSY" });
    release();
    await closing;
    await request;
    expect(host.rows.size).toBe(1);
    expect(host.methods).not.toContain("settings.set");
    await expect(lstat(join(dataDir, "pi-host/admin.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsafe socket and malformed responses without returning their content", async () => {
    const dataDir = await directory();
    await prepareAdminDirectory(dataDir);
    const path = adminSocketPath(dataDir);
    await writeFile(path, "fixture-private-key", { mode: 0o600 });
    expect((await cli(dataDir, JSON.stringify(payload()))).stdout).not.toContain("fixture-private-key");
    await rm(path);
    const other = createServer({ allowHalfOpen: true }, (socket) => { socket.resume(); socket.on("end", () => socket.end('{"ok":true,"summary":"fixture-private-key"}')); });
    other.listen(path);
    await once(other, "listening");
    await chmod(path, 0o600);
    try { await expect(sendAdminRequest(dataDir, payload())).rejects.toMatchObject({ code: "ADMIN_UNAVAILABLE" }); }
    finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });
  it("caps stdin and has a bounded read timeout", async () => {
    await expect(readCapped(Readable.from(["a".repeat(33)]), 32)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const idle = new PassThrough();
    await expect(readCapped(idle, 32, 10)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(idle.listenerCount("data")).toBe(0);
    idle.destroy();
    const { dataDir, host } = await fixture();
    expect(await cli(dataDir, '{"fixture-private-key":')).toEqual({ code: 1, stdout: 'PI_HOST_FAILED {"code":"INVALID_REQUEST"}\n' });
    expect(host.methods).toEqual([]);
  });
});
