import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

// Set before the runtime is imported so the write ledger and per-plugin data
// land in a throwaway directory instead of the developer's real one.
process.env.PI_DESKTOP_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-fs-session-data-"));

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/**
 * One plugin that reaches the fs both ways: through an agent tool (which carries
 * a session) and through the panel bridge (which does not). The tool returns the
 * listing it saw as well as writing, so a read's root can be asserted on too.
 */
const PLUGIN_MAIN = `
  module.exports = {
    async onLoad() {
      await pi.agent.registerTool({
        name: "note",
        description: "Write a note and report the tree as this session sees it",
        risk: "low",
        schema: { type: "object" },
        execute: async (args) => {
          if (args.read) return { text: await pi.fs.readText(args.read) };
          if (args.list) return { glob: await pi.fs.glob("**/*.md"), list: await pi.fs.list("") };
          await pi.fs.writeText(args.path, args.content);
          return { ok: true };
        },
      });
    },
    async onPanelInvoke(channel, payload) {
      if (channel === "write") {
        await pi.fs.writeText(payload.path, payload.content ?? "panel");
        return "panel";
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

function writePlugin({ id, permissions, fs: fsPolicy }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fs-session-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      ...(fsPolicy ? { fs: fsPolicy } : {}),
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  return dir;
}

/** A project directory holding one marker file, so "which root" is observable. */
function makeProject(marker, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fs-session-project-"));
  for (const [rel, content] of Object.entries({ "marker.txt": marker, ...extra })) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}
const SCOPED = {
  read: { root: "workspace", scope: ["**"] },
  write: { root: "workspace", scope: ["notes/**"] },
};

const GRANTED = ["agent.tool.register", "fs.read", "fs.write"];

/**
 * @param options.visible the workspace the window is showing, which is all a
 *   panel call and an unknown session may reach.
 * @param options.sessions project path per session id the host tracks.
 */
async function harness(t, { id, permissions = GRANTED, fs: fsPolicy = SCOPED, visible, sessions = {} }) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => visible,
    getWorkspacePathForSession: (sessionId) => sessions[sessionId] ?? null,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({ id, permissions, fs: fsPolicy });
  await runtime.loadFromPath(dir, permissions);
  const tool = runtime.getTools().find((entry) => entry.name === "note");
  return { runtime, tool };
}

test("a tool call writes into the project of the session that invoked it", async (t) => {
  const visible = makeProject("visible");
  const other = makeProject("other");
  const { tool } = await harness(t, {
    id: "fs.session.write",
    visible,
    sessions: { "session-b": other },
  });
  assert.ok(tool);

  await tool.execute({ path: "notes/from-tool.md", content: "session-b" }, { sessionId: "session-b" });

  assert.equal(readFileSync(join(other, "notes/from-tool.md"), "utf8"), "session-b");
  // The window is showing a different project, and it must stay untouched.
  assert.equal(existsSync(join(visible, "notes/from-tool.md")), false);
});

test("a tool call reads from the project of the session that invoked it", async (t) => {
  const visible = makeProject("visible", { "notes/visible.md": "in the visible project" });
  const other = makeProject("other", { "notes/other.md": "in the other project" });
  const { tool } = await harness(t, {
    id: "fs.session.read",
    visible,
    sessions: { "session-b": other },
  });

  assert.deepEqual(
    await tool.execute({ read: "marker.txt" }, { sessionId: "session-b" }),
    { text: "other" },
  );
  const seen = await tool.execute({ list: true }, { sessionId: "session-b" });
  assert.deepEqual(seen.glob, ["notes/other.md"]);
  assert.deepEqual(
    seen.list.map((entry) => entry.name).sort(),
    ["marker.txt", "notes"],
  );
});

test("a panel call keeps resolving the visible workspace", async (t) => {
  const visible = makeProject("visible");
  const other = makeProject("other");
  const { runtime } = await harness(t, {
    id: "fs.session.panel",
    visible,
    sessions: { "session-b": other },
  });

  assert.equal(
    await runtime.invokePanelBridge("fs.session.panel", "write", { path: "notes/from-panel.md" }),
    "panel",
  );
  assert.equal(readFileSync(join(visible, "notes/from-panel.md"), "utf8"), "panel");
  assert.equal(existsSync(join(other, "notes/from-panel.md")), false);
});

test("a session the host does not track falls back to the visible workspace", async (t) => {
  const visible = makeProject("visible");
  const other = makeProject("other");
  const { tool } = await harness(t, {
    id: "fs.session.unknown",
    visible,
    sessions: { "session-b": other },
  });

  await tool.execute({ path: "notes/unknown.md", content: "fallback" }, { sessionId: "session-c" });

  assert.equal(readFileSync(join(visible, "notes/unknown.md"), "utf8"), "fallback");
  assert.equal(existsSync(join(other, "notes/unknown.md")), false);
});

test("a userSelected mode still uses the directory the user picked", async (t) => {
  const visible = makeProject("visible");
  const other = makeProject("other");
  const { tool } = await harness(t, {
    id: "fs.session.userSelected",
    visible,
    sessions: { "session-b": other },
    fs: { write: { root: "userSelected", scope: [] } },
  });

  // Nothing was picked, so a session root must not stand in for the grant.
  await assert.rejects(
    tool.execute({ path: "notes/x.md", content: "x" }, { sessionId: "session-b" }),
    (error) => error.code === "NOT_FOUND" && /no directory has been chosen/.test(error.message),
  );
  assert.equal(existsSync(join(other, "notes/x.md")), false);
});

test("a session root stands in when the window shows no project", async (t) => {
  const other = makeProject("other");
  const { runtime, tool } = await harness(t, {
    id: "fs.session.closed",
    visible: null,
    sessions: { "session-b": other },
  });
  assert.ok(tool);

  // A temporary chat leaves the visible workspace empty for every session at
  // once; the tool session's own project still resolves, so the plugin keeps
  // working instead of failing everywhere.
  await tool.execute({ path: "notes/from-tool.md", content: "b" }, { sessionId: "session-b" });
  assert.equal(readFileSync(join(other, "notes/from-tool.md"), "utf8"), "b");

  // A panel call has no session behind it and no visible workspace to fall back
  // on, so it still fails closed.
  await assert.rejects(
    () => runtime.invokePanelBridge("fs.session.closed", "write", { path: "notes/panel.md" }),
    (error) => error.code === "NOT_FOUND" && /No workspace is open/.test(error.message),
  );
  assert.equal(existsSync(join(other, "notes/panel.md")), false);
});
