/**
 * Unit tests for the batch skill / MCP importers.
 *
 * The IPC handlers themselves are thin wrappers around `runSkillImport` and
 * `runMcpImport`; the pure functions carry the bucketing logic, so the test
 * drives them with a stub host-call and checks the three-way partition. A
 * real sidecar never boots — no filesystem, no RPC transport, no host.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { runSkillImport, runMcpImport } = await import(
  "../main/ipc/agent-import-ipc.ts"
);

/** Build a host-call stub whose responses are queued per method. */
function stubHost(responsesByMethod) {
  const calls = [];
  const queues = new Map();
  for (const [method, list] of Object.entries(responsesByMethod)) {
    queues.set(method, Array.isArray(list) ? [...list] : [list]);
  }
  const call = async (method, params) => {
    calls.push({ method, params });
    const q = queues.get(method);
    if (!q || q.length === 0) {
      throw new Error(`no stubbed response for ${method}`);
    }
    const next = q.shift();
    if (typeof next === "function") return next(params);
    if (next && next.throw) throw next.throw;
    return next;
  };
  return { call, calls };
}

test("runSkillImport partitions success / exists / other-error into three buckets", async () => {
  const host = stubHost({
    "skills.import": [
      { skill: { id: "ok", name: "OK" } },
      { throw: new Error("SKILL_INVALID: a skill with this name already exists at this level") },
      { throw: new Error("SKILL_INVALID: document is empty") },
    ],
  });
  const items = [
    { source: "pi-user", sourcePath: "/a.md", shape: "file", id: "ok", name: "OK" },
    { source: "pi-user", sourcePath: "/b.md", shape: "file", id: "dup", name: "Dup" },
    { source: "pi-user", sourcePath: "/c.md", shape: "file", id: "bad", name: "Bad" },
  ];
  const result = await runSkillImport(host.call, { level: "global", items });
  assert.equal(result.imported.length, 1, "imported has one entry");
  assert.equal(result.imported[0].item.id, "ok");
  assert.deepEqual(result.imported[0].skill, { id: "ok", name: "OK" });
  assert.equal(result.skipped.length, 1, "skipped has the exists entry");
  assert.equal(result.skipped[0].reason, "exists");
  assert.equal(result.skipped[0].item.id, "dup");
  assert.equal(result.failed.length, 1, "failed has the other-error entry");
  assert.match(result.failed[0].error, /document is empty/);
  assert.equal(host.calls.length, 3, "one host call per item");
});

test("runSkillImport keeps going after a failure so later items still land", async () => {
  const host = stubHost({
    "skills.import": [
      { throw: new Error("boom") },
      { skill: { id: "after" } },
    ],
  });
  const items = [
    { source: "pi-user", sourcePath: "/one.md", shape: "file", id: "one", name: "One" },
    { source: "pi-user", sourcePath: "/two.md", shape: "file", id: "after", name: "After" },
  ];
  const result = await runSkillImport(host.call, { level: "global", items });
  assert.equal(result.failed.length, 1);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].item.id, "after");
});

test("runSkillImport for a dir shape sends rootDir as `path`, not sourcePath", async () => {
  const host = stubHost({
    "skills.import": [{ skill: { id: "d" } }],
  });
  const items = [
    {
      source: "claude-user",
      sourcePath: "/root/SKILL.md",
      rootDir: "/root",
      shape: "dir",
      id: "d",
      name: "Dir",
    },
  ];
  await runSkillImport(host.call, {
    level: "project",
    projectPath: "/proj",
    mode: "link",
    items,
  });
  assert.equal(host.calls.length, 1);
  const [{ method, params }] = host.calls;
  assert.equal(method, "skills.import");
  assert.equal(params.path, "/root", "dir shape forwards rootDir as path");
  assert.equal(params.shape, "dir");
  assert.equal(params.mode, "link");
  assert.equal(params.level, "project");
  assert.equal(params.projectPath, "/proj");
});

test("runMcpImport disables a server after upsert when the item asks for it", async () => {
  const host = stubHost({
    "mcp.upsert": [{ server: { id: "off" } }],
    "mcp.setEnabled": [{ ok: true }],
  });
  const items = [
    {
      source: "claude-desktop",
      sourcePath: "/cfg.json",
      id: "off",
      rawKey: "off",
      transport: "stdio",
      command: "npx",
      disabled: true,
    },
  ];
  const result = await runMcpImport(host.call, { items });
  assert.equal(result.imported.length, 1);
  assert.equal(host.calls.length, 2, "one upsert plus one setEnabled");
  assert.equal(host.calls[0].method, "mcp.upsert");
  const server = host.calls[0].params.server;
  assert.equal(server.id, "off");
  assert.equal(server.command, "npx");
  assert.equal(server.disabled, undefined, "disabled is stripped from the payload");
  assert.equal(host.calls[1].method, "mcp.setEnabled");
  assert.deepEqual(host.calls[1].params, { id: "off", enabled: false });
});

test("runMcpImport reports an `already exists` upsert as skipped, not failed", async () => {
  const host = stubHost({
    "mcp.upsert": [
      { throw: new Error("MCP_INVALID: a server with this name already exists at this level") },
      { server: { id: "fresh" } },
    ],
  });
  const items = [
    {
      source: "cursor-global",
      sourcePath: "/a.json",
      id: "dup",
      rawKey: "dup",
      transport: "http",
      url: "https://example.test",
    },
    {
      source: "cursor-global",
      sourcePath: "/b.json",
      id: "fresh",
      rawKey: "fresh",
      transport: "http",
      url: "https://ok.test",
    },
  ];
  const result = await runMcpImport(host.call, { items });
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "exists");
  assert.equal(result.imported.length, 1);
  assert.equal(result.failed.length, 0);
});
