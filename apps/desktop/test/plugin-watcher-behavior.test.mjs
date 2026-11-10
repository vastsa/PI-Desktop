import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevPluginWatcher } from "../electron/main/plugin-watcher.ts";

const originalTime = new Date("2026-01-01T00:00:00.000Z");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-watch-"));
  const source = join(dir, "main.js");
  writeFileSync(source, "module.exports = 1;\n");
  utimesSync(source, originalTime, originalTime);
  mkdirSync(join(dir, "inject"));
  writeFileSync(join(dir, "inject/register.mjs"), "export default 1;\n");
  utimesSync(join(dir, "inject/register.mjs"), originalTime, originalTime);
  const events = [];
  const reloads = [];
  const problems = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watcher = new DevPluginWatcher({
    watch: (_root, emit) => {
      const row = { emit, closed: false };
      events.push(row);
      return { close: () => { row.closed = true; } };
    },
    reload: async (id) => { reloads.push(id); },
    onProblem: (id, message) => { problems.push({ id, message }); },
    debounceMs: 300,
  });
  watcher.add("fixture", dir);
  t.after(() => {
    watcher.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, source, watcher, events, reloads, problems,
    emit: (name) => events.at(-1).emit(name),
    flush: () => t.mock.timers.tick(300),
  };
}

test("access-time notifications preserve a running plugin without a reload", (t) => {
  const f = fixture(t);
  const before = statSync(f.source, { bigint: true });
  utimesSync(f.source, new Date("2026-01-02T00:00:00Z"), originalTime);
  assert.equal(readFileSync(f.source, "utf8"), "module.exports = 1;\n");
  const after = statSync(f.source, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);
  f.emit("main.js");
  f.emit("inject\\register.mjs");
  f.flush();
  assert.deepEqual(f.reloads, [], "a read/atime event must not unload the plugin");
  assert.deepEqual(f.problems, []);
});

test("same-size source edits reload once per save burst", (t) => {
  const f = fixture(t);
  writeFileSync(f.source, "module.exports = 2;\n");
  utimesSync(f.source, originalTime, new Date("2026-01-02T00:00:00Z"));
  f.emit("main.js");
  t.mock.timers.tick(100);
  writeFileSync(join(f.dir, "inject/register.mjs"), "export default 2;\n");
  utimesSync(join(f.dir, "inject/register.mjs"), originalTime, new Date("2026-01-02T00:00:00Z"));
  f.emit("inject/register.mjs");
  t.mock.timers.tick(299);
  assert.deepEqual(f.reloads, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.reloads, ["fixture"]);
  f.emit("main.js");
  f.emit("inject\\register.mjs");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture"], "load-time reads must not trigger another reload");
});

test("atomic replacement is detected even with the same timestamp and size", (t) => {
  const f = fixture(t);
  const replacement = join(f.dir, "replacement.tmp");
  writeFileSync(replacement, "module.exports = 2;\n");
  utimesSync(replacement, originalTime, originalTime);
  renameSync(replacement, f.source);
  f.emit("main.js");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture"]);
});

test("new and deleted nested sources reload, and newly loaded reads do not", (t) => {
  const f = fixture(t);
  const nested = join(f.dir, "new-folder");
  mkdirSync(nested);
  writeFileSync(join(nested, "module.js"), "module.exports = 1;\n");
  f.emit("new-folder");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture"]);
  f.emit("new-folder/module.js");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture"]);
  rmSync(nested, { recursive: true });
  f.emit("new-folder");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture", "fixture"]);
});

test("ignored outputs and events outside the watched root cannot reload a plugin", (t) => {
  const f = fixture(t);
  for (const name of ["dist/main.js", "node_modules/module.js", ".git/index", "target/main.js", "main.js~", "../outside.js"]) {
    f.emit(name);
  }
  f.flush();
  assert.deepEqual(f.reloads, []);
});

test("removal cancels pending reloads and discards callbacks from an old watch", (t) => {
  const f = fixture(t);
  writeFileSync(f.source, "module.exports = 2;\n");
  f.emit("main.js");
  const old = f.events[0];
  f.watcher.remove("fixture");
  f.flush();
  assert.equal(old.closed, true);
  assert.deepEqual(f.reloads, []);
  old.emit("main.js");
  f.flush();
  assert.deepEqual(f.reloads, []);
  f.watcher.add("fixture", f.dir);
  writeFileSync(f.source, "module.exports = 3;\n");
  old.emit("main.js");
  f.flush();
  assert.deepEqual(f.reloads, [], "a previous watch must not act on its replacement");
  f.emit("main.js");
  f.flush();
  assert.deepEqual(f.reloads, ["fixture"]);
});
