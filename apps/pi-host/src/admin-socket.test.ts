import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { AdminError, adminSocketPath, parseAdminRequest, providerSyncPath, sendAdminRequest, startAdminSocket, type AdminSocket, type HostCaller } from "./admin-socket.js";
import type { HostLogger } from "./logger.js";
import { runProviderImport } from "./provider-import.js";

const KEY = "sk-test-SECRET-123456";
const dirs: string[] = [];
const sockets: AdminSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  // Short base keeps the socket path under the sun_path limit on macOS.
  const dir = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pih-"));
  dirs.push(dir);
  return dir;
}

function recordingLog(lines: string[]): HostLogger {
  const log = ((level: string, message: string, data?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ level, message, data }));
  }) as HostLogger;
  log.child = () => (text: string) => lines.push(text);
  return log;
}

type Row = { id: string; name: string; secretValue?: string; ownerPluginId?: string };
function fakeHost(rows: Map<string, Row>, calls: Array<{ method: string; params: Record<string, unknown> }>): HostCaller {
  let next = 1;
  return {
    async call<T>(method: string, params: unknown = {}): Promise<T> {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      switch (method) {
        case "providers.list":
          return { providers: [...rows.values()].map(({ secretValue: _s, ...row }) => row) } as T;
        case "providers.create": {
          const row = { ...(p as Row), id: `p${next++}` };
          rows.set(row.id, row);
          return { provider: { id: row.id, name: row.name } } as T;
        }
        case "providers.update": {
          const row = rows.get(String(p.id));
          if (!row) throw Object.assign(new Error("gone"), { errorCode: "NOT_FOUND" });
          rows.set(row.id, { ...row, ...(p as Row) });
          return { provider: { id: row.id } } as T;
        }
        case "settings.set":
          return {} as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  providers: [{ sourceId: "src-a", input: { name: "A", secretValue: KEY, models: [{ id: "m1" }] } }],
  ...extra,
});

async function start(dataDir: string, host: HostCaller | null, lines: string[] = []) {
  const socket = await startAdminSocket({ dataDir, getHost: () => host, log: recordingLog(lines) });
  if (socket) sockets.push(socket);
  return socket;
}

describe("parseAdminRequest", () => {
  it("rejects unknown ops, bad versions, and bad types", () => {
    expect(() => parseAdminRequest({ op: "providers.delete", payload: payload() })).toThrow(AdminError);
    expect(() => parseAdminRequest({ op: "providers.import", payload: payload({ version: 2 }) })).toThrow(/version/);
    expect(() => parseAdminRequest({ op: "providers.import", payload: { version: 1, providers: [{ sourceId: 5, input: { name: "A" } }] } })).toThrow(/sourceId/);
    expect(() => parseAdminRequest({ op: "providers.import", payload: { version: 1, providers: [{ sourceId: "a", input: { name: "A", secretValue: 1 } }] } })).toThrow(/secretValue/);
    expect(() => parseAdminRequest({ op: "providers.import", payload: { version: 1, providers: [{ sourceId: "a", input: { name: "A", evil: true } }] } })).toThrow(/unknown/);
    const many = Array.from({ length: 65 }, (_, i) => ({ sourceId: `s${i}`, input: { name: "x" } }));
    expect(() => parseAdminRequest({ op: "providers.import", payload: { version: 1, providers: many } })).toThrow(/at most/);
  });
});

describe("admin socket", () => {
  it("creates an owner-only socket in an owner-only directory and removes it on stop", async () => {
    if (process.platform === "win32") return;
    const dataDir = await tempDir();
    const socket = await start(dataDir, null);
    expect(socket).not.toBeNull();
    expect((await stat(join(dataDir, "pi-host"))).mode & 0o777).toBe(0o700);
    expect((await stat(adminSocketPath(dataDir))).mode & 0o777).toBe(0o600);
    await socket!.close();
    sockets.length = 0;
    await expect(stat(adminSocketPath(dataDir))).rejects.toThrow();
  });

  it("imports then updates on a second run, persisting the mapping, and never leaks the key", async () => {
    const dataDir = await tempDir();
    const rows = new Map<string, Row>();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const lines: string[] = [];
    await start(dataDir, fakeHost(rows, calls), lines);
    const body = JSON.stringify({ op: "providers.import", payload: payload({ defaultModel: { sourceId: "src-a", modelId: "m1" } }) });
    const first = await sendAdminRequest(adminSocketPath(dataDir), body);
    expect(first).toEqual({ ok: true, summary: { imported: [{ sourceId: "src-a", providerId: "p1", action: "created" }], skipped: [], defaultSet: true } });
    expect(calls.find((c) => c.method === "settings.set")?.params).toEqual({ defaultProviderId: "p1", defaultModelId: "m1" });
    const mapping = JSON.parse(await readFile(providerSyncPath(dataDir), "utf8"));
    expect(mapping).toEqual({ version: 1, providers: { "src-a": "p1" } });
    const second = await sendAdminRequest(adminSocketPath(dataDir), body);
    expect(second.ok && second.summary.imported[0]).toEqual({ sourceId: "src-a", providerId: "p1", action: "updated" });
    expect(calls.find((c) => c.method === "providers.update")?.params).toMatchObject({ id: "p1", secretValue: KEY });
    expect(rows.size).toBe(1);
    expect(JSON.stringify([first, second, lines])).not.toContain(KEY);
  });

  it("recreates a mapped row that is gone and skips a plugin-owned row", async () => {
    const dataDir = await tempDir();
    const rows = new Map<string, Row>([["plug", { id: "plug", name: "P", ownerPluginId: "some.plugin" }]]);
    await start(dataDir, fakeHost(rows, []));
    await writeFile(providerSyncPath(dataDir), JSON.stringify({ version: 1, providers: { "src-a": "plug", "src-b": "gone" } }));
    const body = JSON.stringify({
      op: "providers.import",
      payload: { version: 1, providers: [{ sourceId: "src-a", input: { name: "A" } }, { sourceId: "src-b", input: { name: "B" } }], defaultModel: { sourceId: "src-a", modelId: "m" } },
    });
    const response = await sendAdminRequest(adminSocketPath(dataDir), body);
    expect(response).toEqual({
      ok: true,
      summary: { imported: [{ sourceId: "src-b", providerId: "p1", action: "created" }], skipped: [{ sourceId: "src-a", reason: "plugin_owned" }], defaultSet: false },
    });
  });

  it("rejects oversize and invalid requests without echoing them", async () => {
    const dataDir = await tempDir();
    await start(dataDir, fakeHost(new Map(), []));
    const big = await sendAdminRequest(adminSocketPath(dataDir), "x".repeat(1024 * 1024 + 10));
    expect(big).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });
    const bad = await sendAdminRequest(adminSocketPath(dataDir), JSON.stringify({ op: "providers.import", payload: { version: 1, providers: [{ sourceId: "a", input: { name: "A", secretValue: 42, headers: KEY } }] } }));
    expect(bad).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(JSON.stringify(bad)).not.toContain(KEY);
  });

  it("replaces a stale socket file and refuses to steal a live one", async () => {
    if (process.platform === "win32") return;
    const dataDir = await tempDir();
    const first = await start(dataDir, null);
    // Simulate a crash: stop listening but leave the file behind.
    const path = adminSocketPath(dataDir);
    await first!.close();
    sockets.length = 0;
    await writeFile(path, "");
    const replaced = await start(dataDir, null);
    expect(replaced).not.toBeNull();
    const lines: string[] = [];
    expect(await start(dataDir, null, lines)).toBeNull();
    expect(lines.join("\n")).toContain("another pi-host");
  });
});

describe("pi-host provider-import", () => {
  it("prints the summary line on success and a code on failure", async () => {
    const dataDir = await tempDir();
    await start(dataDir, fakeHost(new Map(), []));
    const run = async (input: string, dir = dataDir) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = "";
      stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      stdin.end(input);
      const code = await runProviderImport(["--data-dir", dir], { stdin, stdout });
      return { code, out };
    };
    const ok = await run(JSON.stringify(payload()));
    expect(ok.code).toBe(0);
    expect(ok.out).toBe(`PI_HOST_PROVIDERS ${JSON.stringify({ imported: [{ sourceId: "src-a", providerId: "p1", action: "created" }], skipped: [], defaultSet: false })}\n`);
    expect(await run("not json")).toEqual({ code: 1, out: 'PI_HOST_FAILED {"code":"INVALID_REQUEST"}\n' });
    expect(await run(JSON.stringify(payload({ version: 3 })))).toEqual({ code: 1, out: 'PI_HOST_FAILED {"code":"INVALID_REQUEST"}\n' });
    const empty = await tempDir();
    expect(await run(JSON.stringify(payload()), empty)).toEqual({ code: 1, out: 'PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n' });
    expect(await run("x".repeat(1024 * 1024 + 1))).toEqual({ code: 1, out: 'PI_HOST_FAILED {"code":"PAYLOAD_TOO_LARGE"}\n' });
  });
});
