import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profile = path.join(root, "Temp", "boot-launch-fixture");
const appDir = path.join(root, "apps", "desktop");
const electron = path.join(profile, "electron.exe");
const source = await readFile(path.join(root, "scripts/e2e-electron-boot.mjs"), "utf8");
const result = await build({
  stdin: { contents: source.replace(/^#!.*\r?\n/, ""), resolveDir: path.join(root, "scripts"), sourcefile: "e2e-electron-boot.mjs" },
  bundle: true, write: false, platform: "node", format: "cjs",
  plugins: [{ name: "boot-environment", setup(builder) {
    builder.onResolve({ filter: /^\.\/e2e\/boot\.mjs$/ }, () => ({ path: "boot", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export function repositoryRoot() { return ${JSON.stringify(root)}; }
      export function desktopPaths() { return { appDir: ${JSON.stringify(appDir)} }; }
      export function createTempDataDir() { return ${JSON.stringify(profile)}; }
      export function resolveElectronBinary() { return { electronBinary: ${JSON.stringify(electron)} }; }
    ` }));
  } }],
});

for (const packaged of [false, true]) {
  test(`boot launch preserves ${packaged ? "packaged" : "development"} entry and isolates the profile`, () => {
    const installed = path.join(profile, "installed", "PI Desktop.exe");
    const stop = new Error("Captured external process boundary");
    const originalEnv = { ELECTRON_RUN_AS_NODE: "1", TEST_ENV: "retained" };
    let captured;
    const require = (name) => {
      if (name === "node:path") return path;
      if (name === "node:fs") return {
        existsSync: () => true, readFileSync: () => "preload bridge", mkdirSync() {}, rmSync() {}, writeFileSync() {},
      };
      if (name === "node:child_process") return { spawn: (executable, args, options) => {
        captured = { executable, args, options };
        throw stop;
      } };
      throw new Error(`Unexpected fixture import: ${name}`);
    };
    const process = { argv: ["node", "e2e-electron-boot.mjs", ...(packaged ? [installed] : [])], env: originalEnv, platform: "win32",
      exit: () => { throw new Error("Boot validation unexpectedly exited before spawn"); } };
    assert.throws(() => new Function("require", "process", result.outputFiles[0].text)(require, process), error => error === stop);
    assert.equal(captured.executable, packaged ? path.resolve(installed) : electron);
    assert.deepEqual(captured.args, [...(packaged ? [] : ["."]), `--user-data-dir=${path.join(profile, "chromium")}`]);
    assert.equal(captured.options.cwd, appDir);
    assert.equal(captured.options.env.PI_DESKTOP_DATA_DIR, profile);
    assert.equal(captured.options.env.PI_DESKTOP_AGENTS_DIR, path.join(profile, "isolated-home", "agents"));
    assert.equal(captured.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(captured.options.env.TEST_ENV, "retained");
    assert.equal(originalEnv.ELECTRON_RUN_AS_NODE, "1");
  });
}
