// E2E for the renderer crash-loop fallback (#2595): a renderer that dies on
// every load must not reload forever. Three isolated launches share one
// profile: (1) a crash loop relaunches once without GPU acceleration, (2) a
// loop that survives the fallback reaches the terminal dialog, (3) a stable
// fallback boot clears the marker. Relaunch and the dialog are intercepted in
// Main so no detached process or modal is left behind.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { _electron } = require(process.env.PI_TEST_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".artifacts", `renderer-crash-loop-${Date.now()}`);
const dataDir = join(output, "data");
const profile = join(output, "profile");
const marker = join(profile, "renderer-crash-loop.json");
await mkdir(dataDir, { recursive: true });

const check = (name, value = true) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function until(probe, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

/** `evaluate` can race Main startup; retry until Main answers. */
async function evaluate(app, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await app.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  throw lastError;
}

async function shell(app) {
  const page = await until(async () => {
    for (const candidate of app.windows()) if (await candidate.locator(".app-shell").count()) return candidate;
  }, "desktop shell");
  await page.locator(".app-shell:not(.app-shell-boot)").waitFor();
  return page;
}

async function launch() {
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: "",
    PI_DESKTOP_HOST_BIN: process.env.PI_DESKTOP_HOST_BIN ?? join(root, "target/release/pi-desktop-host-core") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [join(root, "apps/desktop"), `--user-data-dir=${profile}`],
    env,
    timeout: 60_000,
  });
  const exited = new Promise((done) => app.process().once("exit", (code) => done(code)));
  // Intercept the two process-level escapes before any crash is induced.
  await evaluate(app, ({ app: electronApp, dialog }) => {
    globalThis.__crashLoopE2E = { relaunches: [], dialogs: [] };
    electronApp.relaunch = (options) => globalThis.__crashLoopE2E.relaunches.push(options?.args ?? []);
    dialog.showMessageBox = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === "object" && "buttons" in arg);
      globalThis.__crashLoopE2E.dialogs.push({ title: options?.title, buttons: options?.buttons });
      return { response: 1, checkboxChecked: false };
    };
  });
  return { app, exited };
}

/** Make every renderer load of the main window crash before it finishes. */
async function crashEveryLoad(app) {
  const url = (await shell(app)).url();
  await evaluate(app, ({ BrowserWindow }, mainUrl) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === mainUrl);
    const crash = () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.forcefullyCrashRenderer();
    };
    window.webContents.on("did-start-loading", () => setTimeout(crash, 50));
    crash();
  }, url);
}

async function appLog(name) {
  const file = join(dataDir, "logs", "app", `${name}.log`);
  return existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean) : [];
}

let current;
try {
  // 1. First crash loop: one guarded relaunch through the confirmed quit.
  current = await launch();
  await crashEveryLoad(current.app);
  const firstExit = await current.exited;
  current = undefined;
  check("first crash loop exits the process", firstExit === 0);
  check("fallback marker persisted before relaunch", existsSync(marker));
  check("relaunch logged", (await appLog("diagnostics")).some((line) =>
    line.includes("renderer.crash.loop") && line.includes("relaunch-disable-gpu")));
  check("relaunch went through the ordered shutdown", (await appLog("lifecycle")).some((line) =>
    line.includes("app.shutdown")));

  // 2. The loop survives the fallback: no second relaunch, the dialog shows.
  current = await launch();
  const gpuDisabled = await evaluate(current.app, ({ app: electronApp }) =>
    electronApp.isHardwareAccelerationEnabled() === false);
  check("marker boot runs without hardware acceleration", gpuDisabled);
  await crashEveryLoad(current.app);
  const state = await until(
    () => current.app.evaluate(() => (globalThis.__crashLoopE2E.dialogs.length ? globalThis.__crashLoopE2E : null)),
    "terminal dialog",
  );
  check("no second relaunch", state.relaunches.length === 0);
  check("terminal dialog shown once", state.dialogs.length === 1 && state.dialogs[0].buttons.length === 2);
  const secondExit = await current.exited;
  current = undefined;
  check("quit from the dialog exits the process", secondExit === 0);
  check("marker survives a failing fallback launch", existsSync(marker));

  // 3. A stable fallback boot clears the marker after continuous uptime.
  current = await launch();
  const mainUrl = (await shell(current.app)).url();
  check("fallback boot loads the shell", existsSync(marker));
  // Shorten only the 10-minute healthy-uptime timer, then reload so the
  // current renderer arms it; every other timer keeps its real duration.
  await evaluate(current.app, ({ BrowserWindow }, url) => {
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...rest) => original(callback, ms === 600_000 ? 2_000 : ms, ...rest);
    BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url).webContents.reload();
  }, mainUrl);
  await until(() => !existsSync(marker), "marker cleared after stable uptime", 30_000);
  check("stable fallback boot clears the marker");
  await current.app.evaluate(() => { process.env.PI_DESKTOP_BOOT_PROBE = "1"; });
  await current.app.close();
  current = undefined;
  console.log(`renderer crash-loop E2E passed; artifacts: ${output}`);
} finally {
  if (current) await current.app.close().catch(() => undefined);
}
