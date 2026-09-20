import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { scanExternalMcp, parseCodexMcpToml } = await import(
  "../main/importers/agent-mcp-scan.ts"
);

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-scan-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

test("claude-desktop config on darwin is read and mapped to a candidate", async () => {
  const { root, home } = await makeHome();
  try {
    const cfg = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(
      cfg,
      JSON.stringify({
        mcpServers: {
          "context 7": { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { A: "1" } },
        },
      }),
    );
    const result = await scanExternalMcp({ homeDir: home, platform: "darwin", env: {} });
    const found = result.candidates.find((c) => c.source === "claude-desktop");
    assert.ok(found, "candidate missing");
    assert.equal(found.transport, "stdio");
    assert.equal(found.command, "npx");
    assert.deepEqual(found.args, ["-y", "@upstash/context7-mcp"]);
    assert.deepEqual(found.env, { A: "1" });
    assert.equal(found.rawKey, "context 7");
    assert.equal(found.id, "context-7");
    const src = result.sources.find((s) => s.kind === "claude-desktop");
    assert.equal(src.exists, true);
    assert.equal(src.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude-desktop config on win32 honours APPDATA and falls back to HOME", async () => {
  const { root, home } = await makeHome();
  try {
    const cfg = join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ mcpServers: { s: { command: "c" } } }));
    const result = await scanExternalMcp({ homeDir: home, platform: "win32", env: {} });
    const src = result.sources.find((s) => s.kind === "claude-desktop");
    assert.equal(src.exists, true);
    assert.equal(src.path.endsWith("Roaming/Claude/claude_desktop_config.json") ||
      src.path.endsWith("Roaming\\Claude\\claude_desktop_config.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claude-code merges .claude.json legacy with settings.json overrides", async () => {
  const { root, home } = await makeHome();
  try {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "old" }, beta: { command: "b" } } }),
    );
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "new" }, gamma: { command: "g" } } }),
    );
    const result = await scanExternalMcp({ homeDir: home, platform: "linux", env: {} });
    const found = result.candidates.filter((c) => c.source === "claude-code");
    const ids = found.map((c) => c.id).sort();
    assert.deepEqual(ids, ["alpha", "beta", "gamma"]);
    const alpha = found.find((c) => c.id === "alpha");
    assert.equal(alpha.command, "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor global and project trees each report their own candidates", async () => {
  const { root, home } = await makeHome();
  const project = join(root, "project");
  try {
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" }, type: "sse" },
        },
      }),
    );
    await mkdir(join(project, ".cursor"), { recursive: true });
    await writeFile(
      join(project, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "./bin/mcp" } } }),
    );
    const result = await scanExternalMcp({
      homeDir: home,
      projectPath: project,
      platform: "linux",
      env: {},
    });
    const global = result.candidates.find((c) => c.source === "cursor-global");
    assert.equal(global.transport, "http");
    assert.equal(global.url, "https://mcp.example.com/sse");
    assert.deepEqual(global.headers, { Authorization: "Bearer x" });
    assert.ok(global.warnings.includes("declared sse mapped to http"));
    const proj = result.candidates.find((c) => c.source === "cursor-project");
    assert.equal(proj.transport, "stdio");
    assert.equal(proj.command, "./bin/mcp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex config.toml is parsed with the mini TOML reader", async () => {
  const { root, home } = await makeHome();
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      [
        "# top comment",
        "[mcp_servers.playwright]",
        'command = "npx"',
        'args = ["-y", "@playwright/mcp"]',
        'env = { HEADLESS = "1" }',
        "",
        "[mcp_servers.remote]",
        'url = "https://mcp.example.com/rpc"',
        'transport = "http"',
      ].join("\n"),
    );
    const result = await scanExternalMcp({ homeDir: home, platform: "linux", env: {} });
    const cands = result.candidates.filter((c) => c.source === "codex");
    assert.equal(cands.length, 2);
    const pw = cands.find((c) => c.id === "playwright");
    assert.equal(pw.transport, "stdio");
    assert.equal(pw.command, "npx");
    assert.deepEqual(pw.args, ["-y", "@playwright/mcp"]);
    assert.deepEqual(pw.env, { HEADLESS: "1" });
    const remote = cands.find((c) => c.id === "remote");
    assert.equal(remote.transport, "http");
    assert.equal(remote.url, "https://mcp.example.com/rpc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opencode maps command-array and remote-url shapes", async () => {
  const { root, home } = await makeHome();
  try {
    const xdg = join(home, ".config", "opencode");
    await mkdir(xdg, { recursive: true });
    await writeFile(
      join(xdg, "opencode.json"),
      JSON.stringify({
        mcp: {
          local: { type: "local", command: ["node", "server.js", "--port", "8080"] },
          net: { type: "remote", url: "http://192.168.1.5:9000/mcp" },
        },
      }),
    );
    const result = await scanExternalMcp({ homeDir: home, platform: "linux", env: {} });
    const cands = result.candidates.filter((c) => c.source === "opencode");
    const local = cands.find((c) => c.id === "local");
    assert.equal(local.transport, "stdio");
    assert.equal(local.command, "node");
    assert.deepEqual(local.args, ["server.js", "--port", "8080"]);
    const net = cands.find((c) => c.id === "net");
    assert.equal(net.transport, "http");
    assert.equal(net.url, "http://192.168.1.5:9000/mcp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid json is reported through sources[].error, never as a candidate", async () => {
  const { root, home } = await makeHome();
  try {
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), "{ not json");
    const result = await scanExternalMcp({ homeDir: home, platform: "linux", env: {} });
    const src = result.sources.find((s) => s.kind === "cursor-global");
    assert.equal(src.exists, true);
    assert.match(src.error, /invalid json/);
    assert.equal(result.candidates.filter((c) => c.source === "cursor-global").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chatgpt-desktop always reports as not detected until a stable path exists", async () => {
  const { root, home } = await makeHome();
  try {
    const result = await scanExternalMcp({ homeDir: home, platform: "darwin", env: {} });
    const src = result.sources.find((s) => s.kind === "chatgpt-desktop");
    assert.ok(src);
    assert.equal(src.exists, false);
    assert.equal(src.count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseCodexMcpToml ignores unrelated sections and comments", () => {
  const parsed = parseCodexMcpToml(
    [
      "[other]",
      'x = "1"',
      "[mcp_servers.only]",
      'command = "run" # inline comment',
      "disabled = true",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(parsed), ["only"]);
  assert.equal(parsed.only.command, "run");
  assert.equal(parsed.only.disabled, true);
});
