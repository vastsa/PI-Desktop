import { readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const mainSource = await readMainSource();
const installationSource = await readFile(new URL("../electron/main/installation.ts", import.meta.url), "utf8");
const entrySource = await readFile(new URL("../electron/main/entry.ts", import.meta.url), "utf8");
const activationSource = await readFile(
  new URL("../electron/main/bootstrap/app-activation.ts", import.meta.url),
  "utf8",
);
const require = createRequire(import.meta.url);
const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const bundledEntry = await build({
  stdin: { contents: 'export * from "./installation"; import "./entry";', resolveDir: fileURLToPath(new URL("../electron/main/", import.meta.url)), loader: "ts" },
  // A CJS build also rejects an accidentally reintroduced top-level await.
  bundle: true, platform: "node", format: "cjs", write: false,
  plugins: [{ name: "installation-external-boundaries", setup(builder) {
    builder.onResolve({ filter: /^@pi-desktop\/shared$/ }, () => ({ path: fileURLToPath(new URL("../../../packages/shared/src/protocol.ts", import.meta.url)) }));
    builder.onResolve({ filter: /^electron$|^\.\/(logger|main-process-errors|index|storage\/bootstrap)$/ }, (args) => ({ path: args.path, namespace: "installation-test-boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "installation-test-boundary" }, (args) => {
      if (args.path === "electron") return { contents: "export const app = globalThis.__installationHarness.app; export class BrowserWindow { static getAllWindows() { return []; } }" };
      if (args.path === "./logger") return { contents: "export function ignoreBrokenStdio() {}" };
      if (args.path === "./main-process-errors") return { contents: "export function installMainProcessErrorHandlers() {}" };
      if (args.path === "./storage/bootstrap") return { contents: "export function prepareStorage(root, override) { return globalThis.__installationHarness.prepareStorage(root, override); }" };
      return { contents: "globalThis.__installationHarness.bootCount++;" };
    });
  } }],
});

async function launchInstallation(t, { override, development = false, managed = false, ownsLock = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-installation-test-"));
  const originalArgv = process.argv;
  const originalEnvironment = { data: process.env.PI_DESKTOP_DATA_DIR, development: process.env.PI_DESKTOP_DEV };
  t.after(async () => {
    process.argv = originalArgv;
    for (const [key, value] of [["PI_DESKTOP_DATA_DIR", originalEnvironment.data], ["PI_DESKTOP_DEV", originalEnvironment.development]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete globalThis.__installationHarness;
    await rm(root, { recursive: true, force: true });
  });
  if (override === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
  else process.env.PI_DESKTOP_DATA_DIR = override;
  delete process.env.PI_DESKTOP_DEV;
  process.argv = [originalArgv[0], "installation-test", ...(managed ? ["--pi-managed-storage"] : [])];
  const calls = []; const storageCalls = [];
  let finishStorage;
  const storageReady = new Promise((resolve) => { finishStorage = resolve; });
  const harness = {
    bootCount: 0,
    app: {
      isPackaged: !development,
      setName: (name) => calls.push(["name", name]),
      getPath: () => join(root, "appData"),
      setPath: (...args) => calls.push(["path", ...args]),
      setAppUserModelId: () => {},
      requestSingleInstanceLock: () => { calls.push(["lock"]); return ownsLock; },
      quit: () => calls.push(["quit"]),
      exit: (code) => calls.push(["exit", code]),
      on: () => {},
      commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
    },
    prepareStorage: (...args) => { storageCalls.push(args); return storageReady; },
  };
  globalThis.__installationHarness = harness;
  const entry = join(root, "entry.cjs");
  await writeFile(entry, bundledEntry.outputFiles[0].text);
  const installation = require(entry);
  return { installation, calls, storageCalls, harness, finishStorage };
}

test("the single-instance lock is taken before anything touches the data directory", () => {
  // Electron keeps the lock under `userData`, which is derived from the app
  // name, so the name has to be set first. Everything after it in this module
  // writes into the data directory of whichever instance is already running:
  // the logger creates the log tree, the outbox loads and rewrites the queued
  // appends. A duplicate launch must be gone before either happens.
  const lock = installationSource.indexOf("app.requestSingleInstanceLock()");
  assert.ok(lock > 0, "main must request the single-instance lock");
  assert.ok(installationSource.indexOf("app.setName(APP_NAME)") < lock);
  assert.doesNotMatch(installationSource, /new Logger\(|new PersistenceOutbox\(|prepareStorage\(/);
  assert.match(entrySource, /from ["']\.\/installation["']/);
  assert.match(entrySource, /if \(hasSingleInstanceLock\)/);
  assert.match(entrySource, /prepareStorage\([\s\S]*?\.then\([\s\S]*?import\(["']\.\/index["']\)/);
});

test("a launch that loses the lock quits and boots nothing", () => {
  assert.match(installationSource, /if \(!hasSingleInstanceLock\) app\.quit\(\);/);
  assert.match(entrySource, /if \(hasSingleInstanceLock\)/);

  // `app.quit()` before readiness is not guaranteed to preempt `ready`, so the
  // boot path refuses to run a second window, tray, host, or sidecar on top of
  // the running app.
  const ready = mainSource.slice(mainSource.indexOf("app.whenReady().then("));
  const readyPrologue = ready.slice(0, ready.indexOf("createTray()"));
  assert.match(readyPrologue, /if \(!hasSingleInstanceLock\) return;/);

  // The duplicate owns no host, sidecar, panel, or outbox, and the shutdown
  // sequence logs into the shared data directory. It must exit straight away.
  const beforeQuit = mainSource.slice(
    mainSource.indexOf('app.on("before-quit"'),
  );
  const beforeQuitPrologue = beforeQuit.slice(
    0,
    beforeQuit.indexOf("shutdownPromise = "),
  );
  assert.match(beforeQuitPrologue, /if \(!hasSingleInstanceLock\) return;/);
});

test("a second launch surfaces the running window instead of a new one", () => {
  const handler = activationSource.slice(
    activationSource.indexOf('app.on("second-instance"'),
  );
  const body = handler.slice(0, handler.indexOf("});") + 3);
  assert.match(body, /restoreMainWindow\(\)/);
  assert.doesNotMatch(body, /new BrowserWindow|createWindow\(\)/);
});

test("a run with its own data directory keeps the current start behavior", () => {
  // The lock is scoped to the installation, not to `PI_DESKTOP_DATA_DIR`. E2E
  // harnesses, the capture rig, and side-by-side profiles point at their own
  // data directory, share no database, outbox, or logs with the default
  // installation, and have to stay launchable while one is running.
  assert.match(
    installationSource,
    /const singleInstanceRequired = !process\.env\.PI_DESKTOP_DATA_DIR;/,
  );
  assert.match(
    installationSource,
    /const hasSingleInstanceLock = singleInstanceRequired\s*\n?\s*\? app\.requestSingleInstanceLock\(\)\s*\n?\s*: true;/,
  );
});

test("managed relaunch clears the published root before locking and scheduling storage", { timeout: 60_000 }, async (t) => {
  const value = await launchInstallation(t, { override: join(tmpdir(), "previous-published-root"), managed: true });
  assert.equal(process.env.PI_DESKTOP_DATA_DIR, undefined);
  assert.equal(value.installation.singleInstanceRequired, true);
  assert.equal(value.installation.hasSingleInstanceLock, true);
  assert.equal(value.calls.filter(([kind]) => kind === "lock").length, 1);
  assert.deepEqual(value.storageCalls, [[value.installation.defaultDataDir, false]]);
  assert.equal(value.harness.bootCount, 0, "runtime must wait for storage preparation");
  value.finishStorage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.harness.bootCount, 1);
});

test("explicit profile overrides still skip installation locking", { timeout: 60_000 }, async (t) => {
  const override = join(tmpdir(), "explicit-installation-profile");
  const value = await launchInstallation(t, { override, ownsLock: false });
  assert.equal(process.env.PI_DESKTOP_DATA_DIR, override);
  assert.equal(value.installation.singleInstanceRequired, false);
  assert.equal(value.installation.hasSingleInstanceLock, true);
  assert.equal(value.installation.defaultDataDir, override);
  assert.equal(value.calls.some(([kind]) => kind === "lock" || kind === "quit"), false);
  assert.deepEqual(value.storageCalls, [[override, true]]);
});

test("a duplicate launch never initializes storage or imports the full runtime", { timeout: 60_000 }, async (t) => {
  const value = await launchInstallation(t, { ownsLock: false });
  assert.equal(value.installation.hasSingleInstanceLock, false);
  assert.equal(value.calls.some(([kind]) => kind === "quit"), true);
  assert.deepEqual(value.storageCalls, []);
  assert.equal(value.harness.bootCount, 0);
});

test("development installation applies its separate profile before requesting the lock", { timeout: 60_000 }, async (t) => {
  const value = await launchInstallation(t, { development: true });
  assert.equal(value.installation.isDevelopmentBuild, true);
  const pathIndex = value.calls.findIndex(([kind, path]) => kind === "path" && path === "userData");
  const lockIndex = value.calls.findIndex(([kind]) => kind === "lock");
  assert.ok(pathIndex > 0 && pathIndex < lockIndex);
  assert.equal(value.calls[pathIndex][2].endsWith("PI-Desktop Dev"), true);
  assert.equal(value.installation.defaultDataDir.endsWith(".pi-desktop-dev"), true);
});
