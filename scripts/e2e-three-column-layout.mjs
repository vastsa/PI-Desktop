#!/usr/bin/env node
/**
 * E2E-LAYOUT-three-column-width-priority.
 *
 * Launches the built desktop app with a throwaway profile and drives the
 * renderer over CDP: opens the work panel through the capture rig, drags the
 * inner divider with synthetic pointer events, toggles the sidebar, and asserts
 * the fixed-window three-column contract:
 *
 *   - the native window width never changes (opening, dragging, closing);
 *   - MainChat never measures below its 450px floor, including mid-drag and
 *     while `sidebar-out` still occupies flex space;
 *   - the expanded sidebar yields at the threshold and returns when the panel
 *     closes;
 *   - a manual reopen spends work-panel width first, otherwise targeting 460px.
 *
 * Prereqs: `pnpm --filter @pi-desktop/desktop build` (or `pnpm build:js`) and a
 * host-core binary (target/debug, target/release, or PI_DESKTOP_HOST_BIN).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { Host } from "./e2e/host.mjs";
import { checkSidebarRowStates } from "./e2e/sidebar-row-states.mjs";
import { checkSidebarSettings } from "./e2e/sidebar-settings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const appDir = join(root, "apps", "desktop");
const electronBin =
  process.platform === "win32"
    ? join(appDir, "node_modules/electron/dist/electron.exe")
    : join(appDir, "node_modules/.bin/electron");
const cdpPort = Number(process.env.PI_DESKTOP_LAYOUT_CDP_PORT || 9336);
const MAIN_PANE_MIN_WIDTH = 450;
const MAIN_PANE_REOPEN_TARGET_WIDTH = 460;

function resolveHostBinary() {
  const candidates = [
    process.env.PI_DESKTOP_HOST_BIN?.trim(),
    join(root, "target", "debug", "pi-desktop-host-core"),
    join(root, "target", "debug", "pi-desktop-host-core.exe"),
    join(root, "target", "release", "pi-desktop-host-core"),
    join(root, "target", "release", "pi-desktop-host-core.exe"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `host-core binary not found; run cargo build -p host-core or set PI_DESKTOP_HOST_BIN\nchecked: ${candidates.join(", ")}`,
    );
  }
  return found;
}

/**
 * Seed four retained project groups into the same throwaway data directory the
 * app will open, using only the host protocol:
 *
 *   alpha   five sessions across four date buckets, so the group draws date
 *           labels as well as rows
 *   beta    one session, the smallest non-empty group
 *   gamma   no sessions, the empty group
 *   delta   ten sessions that the renderer pins, so the Pinned section has more
 *           rows than its eight-row budget
 *
 * `session.import` is the only protocol entry point that accepts a session's own
 * timestamps, which is what puts rows in the yesterday / this-week / older
 * buckets. The retained-tab list, the pin set, and the project ordering are
 * renderer-local, so they are handed to the app through its own persisted
 * sidebar preferences.
 *
 * `tempDirs` receives the project root as soon as it exists, so a failure here
 * still leaves the caller's clean-up able to remove it.
 */
async function seedSidebarProjects(hostBinary, dataDir, tempDirs) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-layout-projects-")));
  tempDirs.push(projectRoot);
  const alpha = join(projectRoot, "alpha");
  const beta = join(projectRoot, "beta");
  const gamma = join(projectRoot, "gamma");
  const delta = join(projectRoot, "delta");
  for (const dir of [alpha, beta, gamma, delta]) mkdirSync(dir, { recursive: true });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayStart = startOfToday.getTime();
  const stamp = (ms) => new Date(ms).toISOString();
  // `getTimeGroup` buckets on the calendar day, so these offsets are anchored to
  // local midnight rather than to the current clock time.
  const alphaRows = [
    ["alpha today b", Date.now() - 120_000],
    ["alpha today a", Date.now() - 60_000],
    ["alpha yesterday", dayStart - 60_000],
    ["alpha this week", dayStart - 3 * 86400_000],
    ["alpha older", dayStart - 20 * 86400_000],
  ];
  const betaRows = [["beta today", Date.now() - 60_000]];
  // Ten rows, so the Pinned section's eight-row budget has to scroll.
  const deltaRows = Array.from({ length: 10 }, (_, index) => [
    `delta pinned ${index}`,
    Date.now() - 60_000 - index * 1_000,
  ]);
  const alphaSessionIds = [];

  const host = new Host(hostBinary, dataDir);
  try {
    await host.start();
    await host.call("workspace.set", { path: alpha });
    const importRow = async (id, title, projectPath, updatedMs) => {
      const result = await host.call("session.import", {
        session: {
          id,
          title,
          messageCount: 0,
          projectPath,
          modelId: null,
          providerId: null,
          mode: "agent",
          thinkingLevel: "medium",
          permissionMode: "inherit",
          createdAt: stamp(updatedMs - 3_600_000),
          updatedAt: stamp(updatedMs),
        },
        messages: [],
      });
      if (!result?.imported) {
        throw new Error(`session.import skipped ${id}: ${JSON.stringify(result)}`);
      }
    };
    for (const [index, [title, updatedMs]] of alphaRows.entries()) {
      const id = `e2e-fold-alpha-${index}`;
      await importRow(id, title, alpha, updatedMs);
      alphaSessionIds.push(id);
    }
    await importRow("e2e-fold-beta-0", betaRows[0][0], beta, betaRows[0][1]);
    await importRow("e2e-state-standalone", "standalone state probe", null, Date.now());
    const pinnedSessionIds = [];
    for (const [index, [title, updatedMs]] of deltaRows.entries()) {
      const id = `e2e-fold-delta-${index}`;
      await importRow(id, title, delta, updatedMs);
      pinnedSessionIds.push(id);
    }

    // The host canonicalizes every project path; read the stored values back so
    // the renderer's retained-tab list matches exactly.
    const listed = await host.call("session.list");
    const rows = listed?.sessions ?? [];
    const canonical = (sessionId) =>
      rows.find((session) => session.id === sessionId)?.projectPath ?? null;
    const paths = {
      alpha: canonical("e2e-fold-alpha-0"),
      beta: canonical("e2e-fold-beta-0"),
      gamma,
      delta: canonical("e2e-fold-delta-0"),
    };
    if (!paths.alpha || !paths.beta || !paths.delta) {
      throw new Error(`seeded sessions carry no project path: ${JSON.stringify(paths)}`);
    }
    return {
      paths,
      alphaSessionIds,
      pinnedSessionIds,
      keys: [paths.alpha, paths.beta, paths.gamma, paths.delta],
    };
  } finally {
    await host.stop();
  }
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    this.seq = 0;
    this.pending = new Map();
    this.console = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (
        message.method === "Runtime.consoleAPICalled" ||
        message.method === "Runtime.exceptionThrown"
      ) {
        this.console.push(
          `[${message.method}] ${JSON.stringify(message.params).slice(0, 400)}`,
        );
        if (this.console.length > 40) this.console.shift();
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    };
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
      ws.onopen = () => resolve(new CdpClient(ws));
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP websocket closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result.value;
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  return response.json();
}

async function waitFor(predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(
    `timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

const MEASURE = `(() => {
  const round = (element) =>
    element ? Math.round(element.getBoundingClientRect().width) : null;
  const main = document.querySelector(".main-pane");
  const panel = document.querySelector('[data-testid="work-panel"]');
  const sidebar = document.querySelector(".sidebar, .sidebar-rail");
  const chatShell = document.querySelector(".app-chat-shell");
  const handle = document.querySelector(".work-panel-resize");
  return {
    windowWidth: window.innerWidth,
    chatHidden: chatShell?.hidden ?? null,
    settings: Boolean(document.querySelector(".settings-shell")),
    sidebar: round(sidebar),
    sidebarKind: sidebar ? String(sidebar.className).split(" ")[0] : null,
    main: round(main),
    panel: round(panel),
    handle: handle
      ? {
          x: Math.round(handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2),
          y: Math.round(handle.getBoundingClientRect().top + handle.getBoundingClientRect().height / 2),
        }
      : null,
  };
})()`;

const results = [];
let activeCdp = null;
function check(ok, label, detail = "") {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  if (!existsSync(join(appDir, "out/main/index.js"))) {
    console.error("desktop app not built. Run: pnpm --filter @pi-desktop/desktop build");
    process.exit(1);
  }
  if (!existsSync(electronBin)) {
    console.error("Electron binary missing:", electronBin);
    process.exit(1);
  }

  const hostBinary = resolveHostBinary();
  const dataDir = mkdtempSync(join(tmpdir(), "pi-layout-data-"));
  const profileDir = mkdtempSync(join(tmpdir(), "pi-layout-profile-"));
  // Every throwaway directory, created before the child exists so a seeding
  // failure cannot leak one.
  const tempDirs = [dataDir, profileDir];
  const removeTempDirs = () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
  let sidebarSeed = null;
  try {
    sidebarSeed = await seedSidebarProjects(hostBinary, dataDir, tempDirs);
  } catch (error) {
    removeTempDirs();
    throw error;
  }
  const child = spawn(
    electronBin,
    [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, "."],
    {
      cwd: appDir,
      env: {
        ...process.env,
        PI_DESKTOP_DATA_DIR: dataDir,
        PI_DESKTOP_HOST_BIN: hostBinary,
        PI_DESKTOP_START_MAXIMIZED: "0",
        ELECTRON_RENDERER_URL: "",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const cleanup = () => {
    try {
      if (process.platform === "win32" || !child.pid) child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
    removeTempDirs();
  };

  const timeout = setTimeout(() => {
    console.error("FAIL three-column layout — timeout after 420s");
    console.error(output.slice(-2_000));
    cleanup();
    process.exit(1);
  }, 420_000);

  try {
    const target = await waitFor(async () => {
      const targets = await listTargets(cdpPort).catch(() => []);
      return targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.webSocketDebuggerUrl &&
          candidate.url.includes("out/renderer/index.html") &&
          !candidate.url.includes("surface="),
      );
    }, "main window CDP target");

    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    activeCdp = cdp;
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    const measure = () => cdp.evaluate(MEASURE);
    const rig = async (expression) => {
      await cdp.evaluate(`window.__PI_CAPTURE__ = 1; ${expression}`);
      await delay(420);
    };
    const clickSidebarToggle = async () => {
      await cdp.evaluate(
        `(() => {
          const toggle =
            document.querySelector(".ct-lead .ct-icon-btn") ??
            document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ??
            document.querySelector('.sidebar [data-nav="toggle-sidebar"]');
          toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        })()`,
      );
      await delay(500);
    };
    const dragDivider = async (steps) => {
      const start = await measure();
      if (!start.handle) throw new Error("divider not found");
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.handle.x,
        y: start.handle.y,
        button: "left",
        clickCount: 1,
        buttons: 1,
      });
      let minMain = Infinity;
      for (let index = 1; index <= steps; index += 1) {
        const x = Math.max(40, start.handle.x - index * 30);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y: start.handle.y,
          button: "left",
          buttons: 1,
        });
        await delay(50);
        const sample = await measure();
        if (typeof sample.main === "number") minMain = Math.min(minMain, sample.main);
        if (sample.windowWidth !== start.windowWidth) {
          return { start, after: sample, minMain, windowChanged: true };
        }
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 40,
        y: start.handle.y,
        button: "left",
        clickCount: 1,
        buttons: 0,
      });
      await delay(600);
      return { start, after: await measure(), minMain, windowChanged: false };
    };

    await waitFor(
      () => cdp.evaluate(`!!document.querySelector(".main-pane")`),
      "app shell",
    );
    await waitFor(
      () => cdp.evaluate(`!document.querySelector(".startup-splash")`),
      "startup splash cleared",
    );
    await rig(`window.__PI_DESKTOP__.ensureVisualFixtures()`);
    // The seeded workspace already holds more sessions than the capture fixture
    // is willing to add, so activate a seeded one: the shell needs an active
    // session before the work panel can open.
    await rig(
      `window.__PI_DESKTOP__.selectSession(${JSON.stringify(sidebarSeed.alphaSessionIds[0])})`,
    );
    await waitFor(
      () =>
        cdp.evaluate(
          `document.querySelector(".app-work-panel-toggle")?.disabled === false`,
        ),
      "work-panel toggle enabled",
    );

    const baseline = await measure();
    check(
      baseline.sidebarKind === "sidebar" && baseline.main >= MAIN_PANE_MIN_WIDTH,
      "shell starts with an expanded sidebar and a valid MainChat width",
      JSON.stringify(baseline),
    );

    // Icon-only controls must render as squares in the live chrome, not only in
    // the stylesheet: `.icon-btn` takes its width from its label, so an
    // icon-only use states `.icon-btn-square`, and this is what proves the
    // geometry actually stuck once flex layout and the cascade have run.
    const iconControls = await cdp.evaluate(`(() => {
      const expected = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--ds-control-size"),
      );
      const offenders = [];
      let measured = 0;
      for (const control of document.querySelectorAll(".icon-btn")) {
        if (control.textContent.trim() !== "") continue;
        const box = control.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        measured += 1;
        if (
          Math.round(box.width) !== Math.round(box.height) ||
          Math.abs(box.width - expected) > 1
        ) {
          offenders.push({
            classes: control.className,
            width: Math.round(box.width),
            height: Math.round(box.height),
          });
        }
      }
      return { expected, measured, offenders };
    })()`);
    check(
      Number.isFinite(iconControls.expected) &&
        iconControls.expected > 0 &&
        iconControls.measured > 0 &&
        iconControls.offenders.length === 0,
      "every rendered icon-only control is a square hit target",
      JSON.stringify(iconControls),
    );

    // 1. Opening the panel may not touch the native window.
    await rig(`window.__PI_DESKTOP__.openWorkPanel()`);
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(720)`);
    const opened = await measure();
    check(
      opened.windowWidth === baseline.windowWidth,
      "opening the panel never changes the native window width",
      `window ${baseline.windowWidth} -> ${opened.windowWidth}`,
    );
    check(
      opened.main >= MAIN_PANE_MIN_WIDTH,
      "opening the panel respects the MainChat floor",
      JSON.stringify(opened),
    );
    check(
      opened.sidebarKind !== "sidebar",
      "the expanded sidebar yields when the panel would breach the floor",
      `sidebar=${opened.sidebar} kind=${opened.sidebarKind}`,
    );

    // 2. Divider drag with the sidebar expanded: floor holds mid-drag.
    await rig(`window.__PI_DESKTOP__.collapseWorkPanel()`);
    await delay(700);
    if ((await measure()).sidebarKind !== "sidebar") {
      await clickSidebarToggle();
    }
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(244)`);
    await rig(`window.__PI_DESKTOP__.openWorkPanel()`);
    const dragStart = await measure();
    const drag = await dragDivider(26);
    check(
      dragStart.sidebarKind === "sidebar" && dragStart.main >= MAIN_PANE_MIN_WIDTH,
      "drag starts from an expanded sidebar",
      JSON.stringify(dragStart),
    );
    check(
      drag.minMain >= MAIN_PANE_MIN_WIDTH,
      "MainChat never drops below 450px during the drag preview",
      `min=${drag.minMain}`,
    );
    check(
      !drag.windowChanged &&
        drag.after.windowWidth === dragStart.windowWidth,
      "the drag never resizes the native window",
      `window ${dragStart.windowWidth} -> ${drag.after.windowWidth}`,
    );
    check(
      drag.after.sidebarKind !== "sidebar",
      "the expanded sidebar auto-collapses at the threshold",
      JSON.stringify(drag.after),
    );
    check(
      drag.after.panel <= Math.max(0, drag.after.windowWidth - MAIN_PANE_MIN_WIDTH),
      "the committed panel width stays inside the live budget",
      `panel=${drag.after.panel} budget=${Math.max(0, drag.after.windowWidth - MAIN_PANE_MIN_WIDTH)}`,
    );

    // 3. Reopen spends panel width first, otherwise targeting 460px.
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(720)`);
    if ((await measure()).sidebarKind === "sidebar") {
      await clickSidebarToggle();
    }
    const collapsed = await measure();
    await clickSidebarToggle();
    const reopened = await measure();
    const expectedPanel = Math.max(
      1,
      Math.min(
        collapsed.panel,
        collapsed.windowWidth - reopened.sidebar - MAIN_PANE_REOPEN_TARGET_WIDTH,
      ),
    );
    check(
      reopened.sidebarKind === "sidebar" &&
        reopened.main >= MAIN_PANE_MIN_WIDTH &&
        (reopened.panel === collapsed.panel || reopened.panel === expectedPanel),
      "manual reopen spends panel width first, otherwise landing on the 460px target",
      `collapsed=${JSON.stringify(collapsed)} reopened=${JSON.stringify(reopened)}`,
    );
    check(
      reopened.main === MAIN_PANE_REOPEN_TARGET_WIDTH &&
        reopened.panel === expectedPanel,
      "the constrained reopen lands on the 460px MainChat target",
      `main=${reopened.main} panel=${reopened.panel}`,
    );

    // 4. Closing the panel restores a layout-collapsed sidebar only.
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(720)`);
    const pressed = await measure();
    await rig(`window.__PI_DESKTOP__.collapseWorkPanel()`);
    await delay(700);
    const restored = await measure();
    check(
      pressed.sidebarKind !== "sidebar" &&
        restored.sidebarKind === "sidebar" &&
        restored.main >= MAIN_PANE_MIN_WIDTH,
      "closing the panel restores the sidebar the layout collapsed",
      `pressed=${JSON.stringify(pressed)} restored=${JSON.stringify(restored)}`,
    );
    check(
      restored.windowWidth === baseline.windowWidth,
      "the whole flow keeps the native window width constant",
      `window ${baseline.windowWidth} -> ${restored.windowWidth}`,
    );

    const composer = await cdp.evaluate(`(() => {
      const stack = document.querySelector(".composer-stack");
      const bar = document.querySelector(".composer-toolbar");
      const left = document.querySelector(".composer-left");
      const right = document.querySelector(".composer-right");
      const modelChip = document.querySelector(".composer-model-thinking-chip");
      const modelLabel = document.querySelector(".composer-model-thinking-model");
      if (!stack || !bar || !left || !right || !modelChip || !modelLabel) return null;

      const originalWidth = stack.style.width;
      const originalTransition = stack.style.transition;
      stack.style.transition = "none";
      stack.style.width = "450px";
      const modelLabelStyles = getComputedStyle(modelLabel);
      const result = {
        width: Math.round(bar.getBoundingClientRect().width),
        clipped: bar.scrollWidth > bar.clientWidth + 1,
        sameRow:
          Math.round(left.getBoundingClientRect().top) ===
          Math.round(right.getBoundingClientRect().top),
        modelLabelHidden: modelLabelStyles.display === "none",
        modelChipWidth: Math.round(modelChip.getBoundingClientRect().width),
      };
      stack.style.width = originalWidth;
      stack.style.transition = originalTransition;
      return result;
    })()`);
    check(
      composer !== null &&
        composer.clipped === false &&
        composer.sameRow === true &&
        composer.modelLabelHidden === true &&
        composer.modelChipWidth <= 32,
      "the composer toolbar stays on one row and collapses the model to its icon at the 450px Composer floor",
      JSON.stringify(composer),
    );

    // 5. Preview (maximize) mode: MainChat yields its width to the panel.
    await rig(`window.__PI_DESKTOP__.openWorkPanel()`);
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector('[data-testid="work-panel"]')`),
      "work panel mounted for preview mode",
    );
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(500)`);
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector(".work-panel-new-tab")`),
      "work panel new-tab action",
    );
    await cdp.evaluate(
      `document.querySelector(".work-panel-new-tab")?.click?.()`,
    );
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector(".work-panel-tab")`),
      "work panel tab mounted before preview mode",
    );
    // The panel's `+`, maximize, and the viewport-fixed collapse toggle are one
    // button group. Only the rendered box proves it: a stylesheet contract
    // cannot catch a rule that re-states its own inset or divider.
    const panelActionGroup = await cdp.evaluate(`(() => {
      const actions = document.querySelector(".work-panel-actions");
      const maximize = document.querySelector(".work-panel-maximize");
      const toggle = document.querySelector(".app-work-panel-toggle");
      if (!actions || !maximize || !toggle) return null;
      const actionsStyle = getComputedStyle(actions);
      return {
        tokenGap: parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--ds-work-panel-control-gap",
          ),
        ),
        groupGap: parseFloat(actionsStyle.rowGap),
        gapToToggle: Math.round(
          toggle.getBoundingClientRect().left - maximize.getBoundingClientRect().right,
        ),
        borderRight: parseFloat(actionsStyle.borderRightWidth),
        paddingRight: parseFloat(actionsStyle.paddingRight),
        marginRight: parseFloat(actionsStyle.marginRight),
      };
    })()`);
    check(
      panelActionGroup !== null &&
        Number.isFinite(panelActionGroup.tokenGap) &&
        panelActionGroup.tokenGap > 0 &&
        panelActionGroup.groupGap === panelActionGroup.tokenGap &&
        Math.abs(panelActionGroup.gapToToggle - panelActionGroup.tokenGap) <= 1 &&
        panelActionGroup.borderRight === 0 &&
        panelActionGroup.paddingRight === 0 &&
        panelActionGroup.marginRight === 0,
      "the panel actions and the fixed collapse toggle share one control gap",
      JSON.stringify(panelActionGroup),
    );
    const beforeMaximize = await measure();
    await cdp.evaluate(
      `document.querySelector(".work-panel-maximize")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
    );
    await delay(700);
    const maximizing = await measure();
    const expectedMaximized =
      maximizing.windowWidth -
      (maximizing.sidebarKind === "sidebar" ? maximizing.sidebar ?? 0 : 0);
    check(
      maximizing.main === null && maximizing.panel === expectedMaximized,
      "preview mode hides MainChat and hands its width to the panel",
      JSON.stringify(maximizing),
    );
    check(
      maximizing.windowWidth === beforeMaximize.windowWidth,
      "preview mode never resizes the native window",
      `window ${beforeMaximize.windowWidth} -> ${maximizing.windowWidth}`,
    );

    // CSS geometry and DOM behavior are not proof of native titlebar hit testing.
    const checkPreviewHitRegions = async (label) => {
      const geometry = await cdp.evaluate(`(() => {
        const row = document.querySelector(".window-chrome-row");
        const spacer = document.querySelector(".window-chrome-drag");
        const header = document.querySelector(".work-panel-header");
        const actions = [...row.querySelectorAll("[data-nav]")];
        const headerBox = header.getBoundingClientRect();
        const firstTab = document.querySelector(".work-panel-tab");
        const controls = document.querySelector(".window-controls");
        const sidebar = document.querySelector(".sidebar");
        const platform = document.documentElement.dataset.platform;
        const inset = parseFloat(getComputedStyle(row).paddingLeft);
        const actionRight = Math.max(...actions.map(el => el.getBoundingClientRect().right));
        return {
          headerLeft: headerBox.left,
          headerRight: headerBox.right,
          actionRight,
          leftClear: actions.length > 0 && headerBox.left >= actionRight + 8,
          insetClear: actions[0].getBoundingClientRect().left >= (sidebar?.getBoundingClientRect().right ?? 0) + inset,
          rightClear: headerBox.right <= window.innerWidth -
            (platform === "win32" || platform === "linux" ? 120 : 0) &&
            (!controls || headerBox.right <= controls.getBoundingClientRect().left),
          tabClear: !firstTab || firstTab.getBoundingClientRect().left >= actionRight + 8,
          rowRegion: getComputedStyle(row).webkitAppRegion,
          spacerRegion: getComputedStyle(spacer).webkitAppRegion,
          headerRegion: getComputedStyle(header).webkitAppRegion,
          passThrough: getComputedStyle(row).pointerEvents === "none",
          actionsInteractive: actions.every(el => getComputedStyle(el).pointerEvents === "auto" && getComputedStyle(el).webkitAppRegion === "no-drag"),
        };
      })()`);
      check(
        geometry.leftClear && geometry.insetClear && geometry.rightClear && geometry.tabClear &&
          geometry.rowRegion === "none" && geometry.spacerRegion === "none" &&
          geometry.headerRegion === "drag" && geometry.passThrough && geometry.actionsInteractive,
        `preview header border box excludes shell controls (${label}; geometry only)`,
        JSON.stringify(geometry),
      );
    };
    const originalPlatform = await cdp.evaluate(`document.documentElement.dataset.platform`);
    const originalFullscreen = await cdp.evaluate(`document.documentElement.dataset.fullscreen`);
    for (const platform of ["darwin", "win32", "linux"]) {
      for (const fullscreen of [false, true]) {
        await cdp.evaluate(`document.documentElement.dataset.platform = ${JSON.stringify(platform)}; document.documentElement.dataset.fullscreen = "${fullscreen}"`);
        for (let state = 0; state < 2; state += 1) {
          await checkPreviewHitRegions(`${platform}, fullscreen=${fullscreen}, sidebar=${(await measure()).sidebarKind}`);
          await clickSidebarToggle();
        }
      }
    }
    await cdp.evaluate(`document.documentElement.dataset.platform = ${JSON.stringify(originalPlatform)}; ${originalFullscreen === undefined ? "delete document.documentElement.dataset.fullscreen" : `document.documentElement.dataset.fullscreen = ${JSON.stringify(originalFullscreen)}`}`);
    const previewActions = await cdp.evaluate(`(() => {
      const row = document.querySelector(".window-chrome-row");
      const firstAction =
        document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ??
        document.querySelector('.window-chrome-row [data-nav="new-task"]');
      const firstActionBox = firstAction?.getBoundingClientRect();
      return {
        platform: window.piDesktop?.platform ?? "unknown",
        fullscreen: document.documentElement.dataset.fullscreen === "true",
        firstActionLeft: firstActionBox ? Math.round(firstActionBox.left) : null,
        // Read the reserve as the layout resolved it instead of restating the
        // number: preview mode runs with the sidebar collapsed, so this row owns
        // the macOS traffic-light reserve.
        leadInset:
          row && !row.classList.contains("sidebar-expanded")
            ? Math.round(parseFloat(getComputedStyle(row).paddingLeft))
            : null,
        newTask: !!document.querySelector('.window-chrome-row [data-nav="new-task"]'),
        sidebarToggle:
          !!document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ||
          !!document.querySelector('.sidebar [data-nav="toggle-sidebar"]'),
        controls: !!document.querySelector(".window-controls"),
      };
    })()`);
    check(
      previewActions.newTask &&
        previewActions.sidebarToggle &&
        (previewActions.controls || previewActions.platform === "darwin") &&
        (previewActions.platform !== "darwin" ||
          previewActions.fullscreen ||
          // 88 = the native cluster's right edge (76) plus the shell's 12px gap.
          (previewActions.firstActionLeft !== null &&
            previewActions.leadInset !== null &&
            previewActions.leadInset >= 88 &&
            previewActions.firstActionLeft >= previewActions.leadInset)),
      "preview mode keeps new-task, sidebar, and window controls available",
      JSON.stringify(previewActions),
    );
    await cdp.evaluate(
      `document.querySelector(".work-panel-maximize")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
    );
    await delay(700);
    const restoredAfterMaximize = await measure();
    check(
      restoredAfterMaximize.panel === beforeMaximize.panel &&
        restoredAfterMaximize.main === beforeMaximize.main &&
        restoredAfterMaximize.sidebarKind === beforeMaximize.sidebarKind,
      "leaving preview mode restores the previous three-column widths",
      `before=${JSON.stringify(beforeMaximize)} after=${JSON.stringify(restoredAfterMaximize)}`,
    );

    // Preview chrome actions must remain usable while MainChat is absent.
    await cdp.evaluate(
      `document.querySelector(".work-panel-maximize")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
    );
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector('.window-chrome-row [data-nav="new-task"]')`),
      "preview new-task action",
    );
    await cdp.evaluate(
      `document.querySelector('.window-chrome-row [data-nav="new-task"]')?.click?.()`,
    );
    await waitFor(
      () =>
        cdp.evaluate(
          `!!document.querySelector(".main-pane") && !document.querySelector(".app-shell.work-panel-maximized")`,
        ),
      "new task exits preview mode",
    );
    check(
      (await cdp.evaluate(`!!document.querySelector(".composer-input")`)) === true,
      "new task leaves a usable composer after preview mode",
    );
    if ((await measure()).sidebarKind !== "sidebar") await clickSidebarToggle();
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector('[data-nav="plugins"]')`),
      "sidebar navigation after preview mode",
    );
    await cdp.evaluate(`document.querySelector('[data-nav="plugins"]')?.click?.()`);
    await waitFor(
      () =>
        cdp.evaluate(
          `!!document.querySelector(".plugins-page") && !!document.querySelector(".main-pane") && !document.querySelector(".app-shell.work-panel-maximized")`,
        ),
      "plugin route remains visible after preview mode",
    );
    // E2E: a plugin modal covers the window chrome. The 46px band is an opaque
    // absolute row, and the route surface must not hold a stacking context that
    // leaves the modal's veil underneath it — that is what put the band over
    // the install consent. The viewport-fixed work-panel toggle sits inside the
    // band and used to paint over the veil too; it must not any more.
    // Measure after the entrance: opacity animation still creates a stacking
    // context while it is in effect, even without a fill.
    await waitFor(
      () =>
        cdp.evaluate(`(() => {
          const surface = document.querySelector(".route-surface");
          if (!surface) return false;
          const animations = surface.getAnimations();
          return animations.length === 0
            || animations.every((animation) => animation.playState === "finished");
        })()`),
      "plugin route entrance finished",
    );
    await cdp.evaluate(`document.querySelector(".plugins-header-menu")?.click?.()`);
    await waitFor(
      () =>
        cdp.evaluate(
          `!!document.querySelector('[role="menuitem"][data-action="newFromTemplate"]')`,
        ),
      "plugins overflow newFromTemplate item",
    );
    await cdp.evaluate(
      `document.querySelector('[role="menuitem"][data-action="newFromTemplate"]')?.click?.()`,
    );
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector(".plugins-modal-backdrop")`),
      "plugin template modal",
    );
    const modalCoverage = await cdp.evaluate(`(() => {
      const veil = document.querySelector(".plugins-modal-backdrop");
      if (!veil) return { opened: false };
      const toggle = document.querySelector(".app-work-panel-toggle");
      const toggleBox = toggle?.getBoundingClientRect();
      const toggleStack = toggleBox
        ? document.elementsFromPoint(
            toggleBox.left + toggleBox.width / 2,
            toggleBox.top + toggleBox.height / 2,
          )
        : [];
      // The band opts out of pointer events, so it is made an explicit target
      // for this one measurement and put back afterwards.
      const band = document.querySelector(".main-titlebar");
      const previous = band?.style.pointerEvents ?? "";
      if (band) band.style.pointerEvents = "auto";
      const bandBox = band?.getBoundingClientRect();
      const bandStack = bandBox
        ? document.elementsFromPoint(
            bandBox.left + bandBox.width / 2,
            bandBox.top + bandBox.height / 2,
          )
        : [];
      if (band) band.style.pointerEvents = previous;
      return {
        opened: true,
        veilIsTopmostAtToggle: toggleStack[0] === veil,
        toggleTopmost: (toggleStack[0]?.className ?? toggleStack[0]?.tagName ?? "").toString().slice(0, 40),
        bandIsTopmost: bandStack[0] === band,
        bandTopmost: (bandStack[0]?.className ?? bandStack[0]?.tagName ?? "").toString().slice(0, 40),
      };
    })()`);
    check(
      modalCoverage.opened === true,
      "a plugin modal opens over the plugins route",
      JSON.stringify(modalCoverage),
    );
    check(
      modalCoverage.veilIsTopmostAtToggle === true,
      "the modal veil covers the work-panel toggle in the titlebar band",
      JSON.stringify(modalCoverage),
    );
    check(
      modalCoverage.bandIsTopmost === false,
      "the titlebar band does not paint over the modal veil",
      JSON.stringify(modalCoverage),
    );
    await cdp.evaluate(
      `document.querySelector('.plugins-modal-backdrop .plugins-modal-actions [data-action="cancel"]')?.click?.()`,
    );
    await waitFor(
      () => cdp.evaluate(`!document.querySelector(".plugins-modal-backdrop")`),
      "plugin modal closed",
    );
    check(true, "the plugin modal closes and leaves the route clean");
    // Once Extensions is active the footer Plugins button reuses the existing
    // Back action, so a second activation returns to the previous destination
    // (E2E-NAV-plugins-button-goes-back).
    await cdp.evaluate(`document.querySelector('[data-nav="plugins"]')?.click?.()`);
    await waitFor(
      () =>
        cdp.evaluate(
          `!document.querySelector(".plugins-page") && !!document.querySelector(".conversation-topbar")`,
        ),
      "second Plugins activation returns to the previous destination",
    );
    await cdp.evaluate(`document.querySelector('[data-nav="home"]')?.click?.()`);
    await waitFor(
      () =>
        cdp.evaluate(
          `!!document.querySelector(".conversation-topbar") && !!document.querySelector(".main-pane")`,
        ),
      "home route returns after preview navigation",
    );
    await rig(`window.__PI_DESKTOP__.openWorkPanel()`);
    await waitFor(
      () => cdp.evaluate(`!!document.querySelector('[data-testid="work-panel"]')`),
      "work panel remounted after preview navigation",
    );
    await rig(`window.__PI_DESKTOP__.setWorkPanelWidth(500)`);

    // 6. Preview-mode details: inert divider, sidebar interop, persistence.
    const storedBefore = await cdp.evaluate(
      `localStorage.getItem("pi.desktop.workPanel")`,
    );
    await cdp.evaluate(
      `document.querySelector(".work-panel-maximize")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
    );
    await delay(700);
    const previewState = await measure();
    const divider = await cdp.evaluate(`(() => {
      const el = document.querySelector(".work-panel-resize");
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        disabled: el.getAttribute("aria-disabled"),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`);
    check(
      divider?.disabled === "true",
      "the divider is inert while preview mode is on",
      JSON.stringify(divider),
    );
    if (divider) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: divider.x,
        y: divider.y,
        button: "left",
        clickCount: 1,
        buttons: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.max(20, divider.x - 300),
        y: divider.y,
        button: "left",
        buttons: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.max(20, divider.x - 300),
        y: divider.y,
        button: "left",
        clickCount: 1,
        buttons: 0,
      });
      await delay(500);
    }
    const afterDividerDrag = await measure();
    check(
      afterDividerDrag.main === null && afterDividerDrag.panel === previewState.panel,
      "dragging the divider in preview mode leaves the layout untouched",
      JSON.stringify(afterDividerDrag),
    );
    const storedAfterPreview = await cdp.evaluate(
      `localStorage.getItem("pi.desktop.workPanel")`,
    );
    check(
      storedBefore === storedAfterPreview,
      "entering preview mode never rewrites the persisted preferred width",
      `${storedBefore} -> ${storedAfterPreview}`,
    );
    // The preview shell keeps the sidebar action available either in its
    // window-level row (collapsed) or in the expanded sidebar header. Exercise
    // the visible control so persistence is checked across a real UI action.
    await clickSidebarToggle();
    const previewWithSidebar = await measure();
    check(
      previewWithSidebar.main === null &&
        previewWithSidebar.sidebarKind === "sidebar" &&
        previewWithSidebar.panel ===
          previewWithSidebar.windowWidth - (previewWithSidebar.sidebar ?? 0),
      "preview mode keeps the panel full-width when the sidebar is reopened",
      JSON.stringify(previewWithSidebar),
    );
    const storedAfterReopen = await cdp.evaluate(
      `localStorage.getItem("pi.desktop.workPanel")`,
    );
    // Preview is transient: reopening the sidebar changes only the current
    // rectangle and must not rewrite the user's preferred width.
    check(
      storedAfterReopen === storedAfterPreview,
      "reopening the sidebar from preview mode preserves the preferred width",
      `${storedAfterPreview} -> ${storedAfterReopen}`,
    );
    await rig(`window.__PI_DESKTOP__.collapseWorkPanel()`);
    await delay(900);
    const closedFromPreview = await measure();
    check(
      closedFromPreview.main !== null &&
        closedFromPreview.panel === null &&
        closedFromPreview.windowWidth === previewState.windowWidth,
      "closing the panel leaves preview mode and restores the shell",
      JSON.stringify(closedFromPreview),
    );

    const e2eChromeSettle = async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    };
    const e2eChromeProbe = `(() => {
      const band = document.querySelector(".window-chrome-row");
      const controls = document.querySelector(".window-controls");
      const sidebar = document.querySelector(".sidebar, .sidebar-rail");
      const handle = document.querySelector(".sidebar-resize-handle");
      const panel = document.querySelector('[data-testid="work-panel"]');
      const panelHeader = document.querySelector(".work-panel-header");
      const panelTabStrip = document.querySelector(".work-panel-tab-strip");
      const firstPanelTab = document.querySelector(".work-panel-tab");
      const controlsBox = controls ? controls.getBoundingClientRect() : null;
      const firstAction =
        document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ??
        document.querySelector('.window-chrome-row [data-nav="new-task"]');
      const firstActionBox = firstAction?.getBoundingClientRect();
      // Read the reserve as the layout resolved it instead of restating the
      // number: preview mode runs with the sidebar collapsed, so this row owns
      // the macOS traffic-light reserve.
      const bandInset =
        band && !band.classList.contains("sidebar-expanded")
          ? Math.round(parseFloat(getComputedStyle(band).paddingLeft))
          : null;
      const previewActionGroup = document.querySelector(
        ".window-chrome-row .titlebar-nav",
      );
      const previewActionGroupBox = previewActionGroup?.getBoundingClientRect();
      return {
        bandZ: band ? Number(getComputedStyle(band).zIndex) : null,
        bandHeight: band ? Math.round(band.getBoundingClientRect().height) : null,
        bandPointerEvents: band ? getComputedStyle(band).pointerEvents : null,
        platform: window.piDesktop?.platform ?? "unknown",
        fullscreen: document.documentElement.dataset.fullscreen === "true",
        firstActionLeft: firstActionBox ? Math.round(firstActionBox.left) : null,
        bandInset,
        controlsPosition: controls ? getComputedStyle(controls).position : null,
        controlsOnScreen: controlsBox
          ? controlsBox.width > 0 && controlsBox.right <= window.innerWidth + 1
          : null,
        newTask: !!document.querySelector('.window-chrome-row [data-nav="new-task"]'),
        sidebarToggle:
          !!document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ||
          !!document.querySelector('.sidebar [data-nav="toggle-sidebar"]'),
        panelToggle: !!document.querySelector(".app-work-panel-toggle"),
        sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
        handleVisible: handle ? getComputedStyle(handle).display !== "none" : false,
        storedWidth: window.localStorage.getItem("pi.desktop.sidebarWidth"),
        previewActionGroupRight: previewActionGroupBox
          ? Math.round(previewActionGroupBox.right)
          : null,
        panelHeaderPaddingLeft: panelHeader
          ? Math.round(parseFloat(getComputedStyle(panelHeader).paddingLeft))
          : null,
        panelTabStripLeft: panelTabStrip
          ? Math.round(panelTabStrip.getBoundingClientRect().left)
          : null,
        panelFirstTabLeft: firstPanelTab
          ? Math.round(firstPanelTab.getBoundingClientRect().left)
          : null,
        panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
        main: !!document.querySelector(".main-pane"),
      };
    })()`;

    const e2eChromeSidebar = await cdp.evaluate(e2eChromeProbe);
    check(
      e2eChromeSidebar.sidebarWidth === null || e2eChromeSidebar.sidebarWidth === 275,
      "sidebar defaults to 275px when no preference is stored",
      JSON.stringify(e2eChromeSidebar),
    );
    check(
      e2eChromeSidebar.sidebarWidth === null || e2eChromeSidebar.handleVisible === true,
      "the expanded sidebar edge is a resize affordance",
      JSON.stringify(e2eChromeSidebar),
    );
    check(
      e2eChromeSidebar.storedWidth === null,
      "no sidebar width preference is stored at launch",
      JSON.stringify(e2eChromeSidebar),
    );

    await cdp.evaluate(`document.querySelector(".app-work-panel-toggle")?.click?.()`);
    await e2eChromeSettle(900);
    await cdp.evaluate(`document.querySelector(".work-panel-maximize")?.click?.()`);
    await e2eChromeSettle(900);
    const e2eChromePreview = await cdp.evaluate(e2eChromeProbe);
    check(
      e2eChromePreview.main === false && e2eChromePreview.panelWidth !== null,
      "preview mode keeps the panel and drops the center column",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.bandZ !== null && e2eChromePreview.bandZ > 20,
      "the preview band outranks the work panel so its buttons stay visible",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.bandHeight === 46 && e2eChromePreview.bandPointerEvents === "none",
      "the preview band is a 46px pass-through strip",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.platform !== "darwin" ||
        e2eChromePreview.fullscreen ||
        // 88 = the native cluster's right edge (76) plus the shell's 12px gap.
        (e2eChromePreview.firstActionLeft !== null &&
          e2eChromePreview.bandInset !== null &&
          e2eChromePreview.bandInset >= 88 &&
          e2eChromePreview.firstActionLeft >= e2eChromePreview.bandInset),
      "preview actions clear the macOS traffic-light hit area",
      JSON.stringify(e2eChromePreview),
    );
    await checkPreviewHitRegions("reopened preview");
    check(
      e2eChromePreview.platform === "darwin" ||
        (e2eChromePreview.controlsPosition === "fixed" &&
          e2eChromePreview.controlsOnScreen === true),
      "system buttons keep their ordinary seat while previewing",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.panelToggle === true,
      "the panel toggle stays in the top row while previewing",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.newTask === true && e2eChromePreview.sidebarToggle === true,
      "preview mode keeps new-task and sidebar navigation controls",
      JSON.stringify(e2eChromePreview),
    );
    await cdp.evaluate(`document.querySelector(".work-panel-maximize")?.click?.()`);
    await e2eChromeSettle(900);

    await rig(`window.__PI_DESKTOP__.collapseWorkPanel()`);
    const originalTheme = await cdp.evaluate(`document.documentElement.dataset.theme`);
    const routeActionSelector = ".main-titlebar .title-nav-btn";
    const readChromeAction = (selector) => cdp.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!control) throw new Error("Chrome action missing");
      const box = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return {
        width: box.width, height: box.height,
        x: box.left + box.width / 2, y: box.top + box.height / 2,
        background: style.backgroundColor, color: style.color,
        radius: style.borderRadius, border: style.borderWidth,
        display: style.display, align: style.alignItems, justify: style.justifyContent,
        flex: style.flex, cursor: style.cursor,
        hovered: control.matches(":hover"),
      };
    })()`);
    const movePointer = async (x, y) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await delay(220);
    };
    for (const route of ["plugins", "pulls", "scheduled"]) {
      if ((await measure()).sidebarKind !== "sidebar") await clickSidebarToggle();
      await rig(`window.__PI_DESKTOP__.setPage(${JSON.stringify(route)})`);
      await waitFor(
        () => cdp.evaluate(`!!document.querySelector(".route-page .page-frame") && !!document.querySelector(".main-titlebar")`),
        `${route} route mounted`,
      );
      await clickSidebarToggle();
      await waitFor(
        () => cdp.evaluate(`!document.querySelector(".sidebar") && document.querySelectorAll(${JSON.stringify(routeActionSelector)}).length === 2`),
        `${route} collapsed-sidebar actions`,
      );
      check(
        await cdp.evaluate(`!document.querySelector(".window-chrome-row")`),
        `${route} exercises the ordinary titlebar, not preview chrome`,
      );
      for (const theme of ["light", "dark"]) {
        await cdp.evaluate(`window.__PI_DESKTOP__.setThemeAttr(${JSON.stringify(theme)})`);
        await movePointer(500, 300);
        const reference = await readChromeAction(".app-work-panel-toggle");
        await movePointer(reference.x, reference.y);
        const referenceHover = await readChromeAction(".app-work-panel-toggle");
        check(
          reference.background === "rgba(0, 0, 0, 0)" &&
            referenceHover.hovered && referenceHover.background !== reference.background,
          `${route}/${theme} shared chrome reference has transparent rest and hover wash`,
          JSON.stringify({ reference, referenceHover }),
        );
        for (const action of ["toggle-sidebar", "new-task"]) {
          const selector = `${routeActionSelector}[data-nav="${action}"]`;
          await movePointer(500, 300);
          const rest = await readChromeAction(selector);
          check(
            Math.abs(rest.width - 28) < 0.1 && Math.abs(rest.height - 28) < 0.1 &&
              ["background", "color", "radius", "border", "display", "align", "justify", "flex", "cursor"].every(
                (property) => rest[property] === reference[property],
              ),
            `${route}/${theme} ${action} shares the rendered 28px chrome target and rest style`,
            JSON.stringify(rest),
          );
          await movePointer(rest.x, rest.y);
          const hover = await readChromeAction(selector);
          check(
            hover.hovered && hover.background === referenceHover.background &&
              hover.color === referenceHover.color &&
              hover.width === rest.width && hover.height === rest.height,
            `${route}/${theme} ${action} shares the hover wash without changing geometry (CDP)`,
            JSON.stringify(hover),
          );
        }
      }
      await cdp.evaluate(`document.querySelector('${routeActionSelector}[data-nav="toggle-sidebar"]').click()`);
      await waitFor(
        () => cdp.evaluate(`!!document.querySelector(".sidebar:not(.is-exiting)") && !document.querySelector(${JSON.stringify(routeActionSelector)})`),
        `${route} sidebar reopens through its titlebar action`,
      );
      check(true, `${route} titlebar sidebar action reopens navigation (DOM)`);
      await clickSidebarToggle();
      await waitFor(
        () => cdp.evaluate(`!document.querySelector(".sidebar") && !!document.querySelector('${routeActionSelector}[data-nav="new-task"]')`),
        `${route} new-task action after recollapse`,
      );
      await cdp.evaluate(`document.querySelector('${routeActionSelector}[data-nav="new-task"]').click()`);
      await waitFor(
        () => cdp.evaluate(`!!document.querySelector(".conversation-topbar") && !!document.querySelector(".composer-input:not(:disabled)") && !document.querySelector(".route-page")`),
        `${route} new task returns to an editable chat composer`,
      );
      check(true, `${route} titlebar new-task action returns to chat (DOM)`);
    }
    await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}`);

    // 7. Sidebar project-group fold: one grid row, no fade, no snap.
    //
    // Measures the fold as it paints instead of restating the stylesheet.
    const groupSelector = (key) =>
      `[data-sidebar-project-group=${JSON.stringify(key)}]`;

    const FOLD_PROBE = (key) => `(() => {
      const section = document.querySelector(${JSON.stringify(groupSelector(key))});
      const body = section?.querySelector(".sidebar-session-group-body.project") ?? null;
      if (!body) return null;
      const clip = section.querySelector(".sidebar-session-group-clip");
      const list = section.querySelector(".sidebar-session-group-list");
      const next = section.nextElementSibling;
      const rows = body.querySelectorAll("[data-sidebar-session-row]");
      const lastRow = rows.length > 0
        ? rows[rows.length - 1]
        : body.querySelector(".sidebar-session-empty");
      const style = getComputedStyle(body);
      const box = body.getBoundingClientRect();
      return {
        now: performance.now(),
        key: section.getAttribute("data-sidebar-project-group"),
        nextKey: next?.getAttribute("data-sidebar-project-group") ?? null,
        collapsed: body.classList.contains("collapsed"),
        inert: body.hasAttribute("inert"),
        ariaHidden: body.getAttribute("aria-hidden"),
        display: style.display,
        gridRows: style.gridTemplateRows,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        height: box.height,
        bottom: box.bottom,
        opacity: Number(style.opacity),
        rows: rows.length,
        dateHeaders: body.querySelectorAll(".sidebar-time-group-header").length,
        emptyState: !!body.querySelector(".sidebar-session-empty"),
        clipMinHeight: clip ? getComputedStyle(clip).minHeight : null,
        clipOverflowY: clip ? getComputedStyle(clip).overflowY : null,
        listGap: list ? getComputedStyle(list).rowGap : null,
        listPadTop: list ? getComputedStyle(list).paddingTop : null,
        listPadBottom: list ? getComputedStyle(list).paddingBottom : null,
        // The scroller's own gap between two groups.
        gapToNext: next
          ? Math.round((next.getBoundingClientRect().top - box.bottom) * 100) / 100
          : null,
        // The 8px tail the rhythm promises: the last row (or the empty state) to
        // the next group's header, which is the group's own 7px inset plus that
        // 1px scroller gap.
        lastRowBottom: lastRow ? lastRow.getBoundingClientRect().bottom : null,
        contentTail:
          next && lastRow
            ? Math.round(
                (next.getBoundingClientRect().top -
                  lastRow.getBoundingClientRect().bottom) * 100) / 100
            : null,
      };
    })()`;

    // A trusted pointer click, so the app's own hit testing and the row's click
    // path both run. The button is scrolled into view and the point is confirmed
    // to hit it before the press.
    const toggleProjectGroup = async (key) => {
      const deadline = Date.now() + 3_000;
      let target = null;
      while (Date.now() < deadline) {
        target = await cdp.evaluate(`(() => {
          const control = document.querySelector(${JSON.stringify(groupSelector(key) + " .sidebar-session-group-title")});
          if (!control) return null;
          control.scrollIntoView({ block: "nearest" });
          const box = control.getBoundingClientRect();
          const x = Math.round(box.left + box.width / 2);
          const y = Math.round(box.top + box.height / 2);
          const hit = document.elementFromPoint(x, y);
          return { x, y, hit: !!hit && (hit === control || control.contains(hit)) };
        })()`);
        if (target?.hit) break;
        await delay(100);
      }
      if (!target) throw new Error(`sidebar group ${key} has no title control`);
      if (!target.hit) {
        throw new Error(`sidebar group ${key} title is not hittable at ${target.x},${target.y}`);
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
        buttons: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
        buttons: 0,
      });
    };

    // The fold's own transition events are the duration evidence; wall clock
    // sampled from this side measures the polling loop, not the animation.
    const startFoldTrace = (key) =>
      cdp.evaluate(`(() => {
        const section = document.querySelector(${JSON.stringify(groupSelector(key))});
        const body = section.querySelector(".sidebar-session-group-body.project");
        if (window.__piFoldTrace) {
          body.removeEventListener("transitionrun", window.__piFoldTrace.onRun);
          body.removeEventListener("transitionend", window.__piFoldTrace.onEnd);
        }
        const trace = { start: performance.now(), runs: [], ends: [] };
        const isFold = (event) => event.propertyName === "grid-template-rows";
        trace.onRun = (event) => {
          if (isFold(event)) trace.runs.push(Math.round(performance.now() - trace.start));
        };
        trace.onEnd = (event) => {
          if (!isFold(event)) return;
          trace.ends.push({
            // Transition events report seconds.
            ranMs: Math.round(event.elapsedTime * 1000),
            atMs: Math.round(performance.now() - trace.start),
          });
        };
        body.addEventListener("transitionrun", trace.onRun);
        body.addEventListener("transitionend", trace.onEnd);
        window.__piFoldTrace = trace;
        return true;
      })()`);

    // Projected to plain values: the trace holds listeners, which do not survive
    // the return-by-value boundary.
    const readFoldTrace = () =>
      cdp.evaluate(`({ runs: window.__piFoldTrace.runs, ends: window.__piFoldTrace.ends })`);

    // Read from the outside rather than from a page timer: an occluded Electron
    // window throttles requestAnimationFrame, while `Runtime.evaluate` keeps
    // resolving the interpolated value for as long as the transition runs.
    const sampleFold = async (key, steps, togglesAt) => {
      await startFoldTrace(key);
      const frames = [];
      for (let step = 0; step < steps; step += 1) {
        if (togglesAt.includes(step)) await toggleProjectGroup(key);
        const frame = await cdp.evaluate(FOLD_PROBE(key));
        if (!frame) throw new Error(`sidebar group ${key} is not rendered`);
        frames.push(frame);
        await delay(8);
      }
      return { frames, trace: await readFoldTrace() };
    };

    await cdp.send("Page.enable");
    const sidebarPreferences = {
      sessionMeta: Object.fromEntries(
        sidebarSeed.pinnedSessionIds.map((id) => [id, { pinned: true }]),
      ),
      projectMeta: {
        [sidebarSeed.paths.alpha]: { order: 0 },
        [sidebarSeed.paths.beta]: { order: 1 },
        [sidebarSeed.paths.gamma]: { order: 2 },
        [sidebarSeed.paths.delta]: { order: 3 },
      },
      projectSort: "manual",
      sessionView: { sort: "recent", archived: false },
      openProjectPaths: sidebarSeed.keys,
    };
    await cdp.evaluate(
      `window.localStorage.setItem("pi.desktop.sidebarPreferences", ${JSON.stringify(JSON.stringify(sidebarPreferences))})`,
    );
    await cdp.send("Page.reload", {});
    // The retained-tab list is renderer-local and only read at startup, so the
    // reload is what puts beta and gamma in the sidebar. Poll for the reloaded
    // document's own DOM and keep the last reading for the failure detail.
    const reloadDeadline = Date.now() + 90_000;
    let reloadState = null;
    while (Date.now() < reloadDeadline) {
      reloadState = await cdp
        .evaluate(`(() => ({
          splash: !!document.querySelector(".startup-splash"),
          sidebar: !!document.querySelector(".sidebar"),
          keys: [...document.querySelectorAll("[data-sidebar-project-group]")].map((el) => el.getAttribute("data-sidebar-project-group")),
        }))()`)
        .catch((error) => ({ error: String(error.message).slice(0, 160) }));
      const keys = reloadState.keys ?? [];
      if (
        sidebarSeed.keys.every((key) => keys.includes(key)) &&
        reloadState.splash === false
      ) {
        break;
      }
      await delay(200);
    }
    // The assertion is that the seeded groups are back, not that the sidebar
    // holds exactly those: the flow above this point can leave a project of its
    // own, and the fold checks address the seeded groups by key.
    const reloadedKeys = reloadState?.keys ?? [];
    check(
      reloadState?.splash === false &&
        sidebarSeed.keys.every((key) => reloadedKeys.includes(key)),
      "the seeded project groups are back after a renderer reload",
      JSON.stringify(reloadState),
    );
    if (reloadState?.sidebar === false) {
      await clickSidebarToggle();
    }

    const [alpha, beta, gamma] = await Promise.all(
      [sidebarSeed.paths.alpha, sidebarSeed.paths.beta, sidebarSeed.paths.gamma].map(
        (key) => cdp.evaluate(FOLD_PROBE(key)),
      ),
    );
    const betaKey = sidebarSeed.paths.beta;

    check(
      alpha?.display === "grid" &&
        alpha.gridRows !== "0px" &&
        alpha.clipMinHeight === "0px" &&
        alpha.clipOverflowY === "hidden" &&
        alpha.listGap === "1px" &&
        alpha.listPadTop === "2px" &&
        alpha.listPadBottom === "7px",
      "a project group folds as a three-layer grid, not a max-height box",
      JSON.stringify({ alpha, beta, gamma }),
    );
    check(
      alpha?.rows === 5 && alpha.dateHeaders === 3 && alpha.height > 0,
      "the seeded multi-row group draws its rows and every date label",
      JSON.stringify(alpha),
    );
    check(
      beta?.rows === 1 && beta.height > 0 && beta.dateHeaders === 0,
      "a one-row group folds the same way",
      JSON.stringify(beta),
    );
    check(
      gamma?.rows === 0 && gamma.emptyState === true && gamma.height > 0,
      "an empty group folds its empty state like any other content",
      JSON.stringify(gamma),
    );
    check(
      alpha?.opacity === 1 &&
        alpha.transitionProperty === "grid-template-rows" &&
        alpha.transitionDuration === "0.2s" &&
        alpha.inert === false &&
        alpha.ariaHidden === "false",
      "the grid transition is the only motion and opacity never animates",
      JSON.stringify(alpha),
    );
    // The 8px tail is measurable only against a following group. The last group
    // in the list has no neighbour, so it is proven from the group's own geometry
    // instead — either layout is valid, and neither assertion depends on how many
    // other projects the run happens to leave behind.
    const seededTails = [alpha, beta, gamma].map((group) =>
      group.nextKey
        ? Math.abs(group.contentTail - 8) < 0.6
        : group.contentTail === null &&
          group.listPadBottom === "7px" &&
          group.clipMinHeight === "0px" &&
          group.clipOverflowY === "hidden",
    );
    check(
      alpha.nextKey === betaKey &&
        beta.nextKey === sidebarSeed.paths.gamma &&
        seededTails.every(Boolean),
      "the group's 7px inset plus the 1px scroller gap read as an 8px tail, empty state included",
      JSON.stringify({
        next: [alpha.nextKey, beta.nextKey, gamma.nextKey],
        tails: [alpha.contentTail, beta.contentTail, gamma.contentTail],
        tailsOk: seededTails,
      }),
    );

    const listBudgets = await cdp.evaluate(`(() => {
      const measure = (body) => {
        if (!body) return null;
        const rows = [...body.querySelectorAll("[data-sidebar-session-row]")];
        const box = body.getBoundingClientRect();
        return {
          display: getComputedStyle(body).display,
          maxHeight: parseFloat(getComputedStyle(body).maxHeight),
          clientHeight: body.clientHeight,
          scrollHeight: body.scrollHeight,
          rows: rows.length,
          rowsInside:
            rows.filter((row) => row.getBoundingClientRect().bottom <= box.bottom + 0.5)
              .length,
        };
      };
      const pinned = measure(document.querySelector(".sidebar-session-group-body.pinned"));
      return {
        standalone: measure(document.querySelector(".sidebar-session-group-body.standalone")),
        pinned,
        // The renderer's budgets are min(233px, 30vh) and a flat 146px.
        pinnedBudget: Math.min(233, window.innerHeight * 0.3),
      };
    })()`);
    check(
      listBudgets.standalone?.display === "flex" &&
        listBudgets.standalone?.maxHeight === 146,
      "the standalone list keeps its flex column and 146px budget",
      JSON.stringify(listBudgets.standalone),
    );
    check(
      listBudgets.pinned?.display === "flex" &&
        listBudgets.pinned.rows === sidebarSeed.pinnedSessionIds.length &&
        Math.abs(listBudgets.pinned.clientHeight - listBudgets.pinnedBudget) <= 1 &&
        listBudgets.pinned.scrollHeight > listBudgets.pinned.clientHeight &&
        listBudgets.pinned.rowsInside === 8,
      "the seeded pinned list holds eight rows inside its 233px budget and scrolls the rest",
      JSON.stringify({ pinned: listBudgets.pinned, budget: listBudgets.pinnedBudget }),
    );
    const pinnedScrolled = await cdp.evaluate(`(() => {
      const body = document.querySelector(".sidebar-session-group-body.pinned");
      if (!body) return null;
      body.scrollTop = body.scrollHeight;
      const rows = [...body.querySelectorAll("[data-sidebar-session-row]")];
      const box = body.getBoundingClientRect();
      const last = rows[rows.length - 1];
      return {
        scrollTop: body.scrollTop,
        lastRowFullyInside:
          last.getBoundingClientRect().bottom <= box.bottom + 0.5 &&
          last.getBoundingClientRect().top >= box.top - 0.5,
      };
    })()`);
    check(
      pinnedScrolled !== null &&
        pinnedScrolled.scrollTop > 0 &&
        pinnedScrolled.lastRowFullyInside === true,
      "the pinned list scrolls to its last row inside the budget",
      JSON.stringify(pinnedScrolled),
    );

    const { frames: collapsedFrames, trace: collapseTrace } = await sampleFold(
      sidebarSeed.paths.alpha,
      40,
      [3],
    );
    const restHeight = collapsedFrames[2].height;
    const settled = collapsedFrames[collapsedFrames.length - 1];
    const midFrames = collapsedFrames.filter(
      (frame) => frame.height > 0.5 && frame.height < restHeight - 0.5,
    );
    let reversed = false;
    for (let index = 1; index < collapsedFrames.length; index += 1) {
      if (collapsedFrames[index].height > collapsedFrames[index - 1].height + 0.75) {
        reversed = true;
      }
    }
    check(
      midFrames.length >= 4 && !reversed,
      "the collapse paints a continuous multi-frame height ramp with no plateau",
      `mid-frames=${midFrames.length} heights=${collapsedFrames.map((f) => Math.round(f.height)).join(",")}`,
    );
    check(
      Math.abs(restHeight - alpha.height) < 0.6 &&
        settled.height <= 0.5 &&
        settled.gridRows === "0px",
      "the fold reaches its full height and closes completely",
      `rest=${restHeight} settled=${settled.height}`,
    );
    check(
      collapseTrace.runs.length === 1 &&
        collapseTrace.ends.length === 1 &&
        Math.abs(collapseTrace.ends[0].ranMs - 200) <= 10,
      "the fold is one transition that runs for the declared 200ms",
      JSON.stringify(collapseTrace),
    );
    check(
      collapsedFrames.every((frame) => frame.opacity === 1),
      "opacity stays 1 for every frame of the fold — the rows are clipped, not faded",
      JSON.stringify([...new Set(collapsedFrames.map((f) => f.opacity))]),
    );
    check(
      settled.gapToNext !== null &&
        Math.abs(settled.gapToNext - 1) < 0.6 &&
        settled.lastRowBottom !== null &&
        settled.lastRowBottom > settled.bottom,
      "the group's own tail leaves with its rows: the folded section is its header plus the 1px scroller gap, and the rows sit past the clipped edge",
      `gap=${settled.gapToNext} rows ${Math.round(settled.lastRowBottom - settled.bottom)}px past the section`,
    );
    check(
      settled.collapsed === true &&
        settled.inert === true &&
        settled.ariaHidden === "true",
      "the folded group leaves the tab order while its rows stay mounted",
      JSON.stringify(settled),
    );

    const { frames: reopenFrames, trace: reopenTrace } = await sampleFold(
      sidebarSeed.paths.alpha,
      40,
      [3],
    );
    const reopenedFold = reopenFrames[reopenFrames.length - 1];
    check(
      Math.abs(reopenedFold.height - restHeight) < 0.6 &&
        reopenedFold.collapsed === false &&
        reopenedFold.inert === false &&
        Math.abs(reopenedFold.contentTail - 8) < 0.6 &&
        reopenTrace.ends.length === 1 &&
        Math.abs(reopenTrace.ends[0].ranMs - 200) <= 10,
      "expanding restores the same height and the 8px tail in one 200ms transition",
      JSON.stringify({ reopenedFold, trace: reopenTrace }),
    );

    // A reversal mid-flight must continue from the frame it is on rather than
    // restarting or settling on a stale endpoint.
    const { frames: reversalFrames } = await sampleFold(sidebarSeed.paths.alpha, 46, [3, 9]);
    const reversalEnd = reversalFrames[reversalFrames.length - 1];
    const reversalDipped = Math.min(...reversalFrames.map((frame) => frame.height));
    check(
      Math.abs(reversalEnd.height - restHeight) < 0.6,
      "a collapse reversed mid-flight settles back on the open height",
      `end=${reversalEnd.height} rest=${restHeight} dip=${Math.round(reversalDipped)}`,
    );
    check(
      reversalDipped < restHeight - 0.5 &&
        !reversalFrames.some((frame) => frame.height > restHeight + 0.75),
      "the reversed fold turns on the frame it reached and never overshoots",
      `dip=${Math.round(reversalDipped)} max=${Math.round(Math.max(...reversalFrames.map((f) => f.height)))}`,
    );

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const { frames: reducedFrames, trace: reducedTrace } = await sampleFold(
      sidebarSeed.paths.alpha,
      24,
      [3],
    );
    const reducedSettled = reducedFrames[reducedFrames.length - 1];
    const reducedMids = reducedFrames.filter(
      (frame) => frame.height > 0.5 && frame.height < restHeight - 0.5,
    );
    check(
      reducedSettled.height <= 0.5 &&
        reducedSettled.collapsed === true &&
        reducedMids.length <= 1 &&
        reducedTrace.ends.length >= 1 &&
        reducedTrace.ends[0].ranMs <= 5,
      "reduced motion keeps the endpoints and drops the travel",
      JSON.stringify({ mids: reducedMids.length, settled: reducedSettled.height, trace: reducedTrace }),
    );
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await toggleProjectGroup(sidebarSeed.paths.alpha);
    await waitFor(
      () => cdp.evaluate(`${FOLD_PROBE(sidebarSeed.paths.alpha)}.collapsed === false`),
      "the folded group reopens after the reduced-motion probe",
    );
    await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}`);

    await checkSidebarSettings({
      cdp, check, waitFor, artifactDir: process.env.PI_DESKTOP_LAYOUT_ARTIFACT_DIR,
    });

    const crashSentinel = `renderer-crash-${Date.now()}`;
    await cdp.evaluate(
      `window.__PI_E2E_RENDERER_CRASH_SENTINEL = ${JSON.stringify(crashSentinel)}`,
    );
    void cdp.send("Page.crash").catch(() => undefined);
    let recoveryCdp = cdp;
    const recoveryState = await waitFor(async () => {
      if (recoveryCdp.closed) {
        const page = (await listTargets(cdpPort).catch(() => [])).find(
          (candidate) => candidate.type === "page" && candidate.id === target.id,
        );
        if (!page?.webSocketDebuggerUrl) return false;
        const connected = await CdpClient.connect(page.webSocketDebuggerUrl).catch(
          () => null,
        );
        if (!connected) return false;
        recoveryCdp = connected;
        activeCdp = recoveryCdp;
        await recoveryCdp.send("Runtime.enable").catch(() => undefined);
      }
      const state = await recoveryCdp
        .evaluate(`({
          sentinel: window.__PI_E2E_RENDERER_CRASH_SENTINEL,
          chatSurface: Boolean(document.querySelector('.chat-surface')),
          splash: Boolean(document.querySelector('.startup-splash')),
        })`)
        .catch(() => null);
      return state?.chatSurface && !state.splash && state.sentinel !== crashSentinel
        ? state
        : false;
    }, "the renderer automatically reloads after a crash", 90_000);
    const recoveredTarget = (await listTargets(cdpPort).catch(() => [])).find(
      (candidate) => candidate.type === "page" && candidate.id === target.id,
    );
    check(
      recoveryState.chatSurface && recoveredTarget?.id === target.id,
      "the existing app window restores the chat after a renderer crash",
      JSON.stringify({ recoveryState, targetId: recoveredTarget?.id }),
    );
    const diagnostics = await readFile(
      join(dataDir, "logs", "app", "diagnostics.log"),
      "utf8",
    ).catch(() => "");
    const rendererRecoveryLog = diagnostics
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find(
        (entry) =>
          entry?.event === "renderer.process.gone" && entry.data?.reloaded === true,
      );
    check(
      Boolean(rendererRecoveryLog?.data?.reason),
      "renderer crash recovery records the exit reason and reload decision",
      JSON.stringify(rendererRecoveryLog),
    );

    await checkSidebarRowStates({ cdp: recoveryCdp, check, waitFor, seed: sidebarSeed });

    const failed = results.filter((entry) => !entry.ok);
    console.log(
      `\nE2E-LAYOUT-three-column-width-priority: ${results.length - failed.length}/${results.length} checks passed`,
    );
    if (failed.length) {
      for (const entry of failed) {
        console.error(`FAILED ${entry.label} — ${entry.detail}`);
      }
      cleanup();
      clearTimeout(timeout);
      process.exit(1);
    }
    cleanup();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    console.error(`FAIL three-column layout — ${error.message}`);
    try {
      if (activeCdp) {
        console.error("--- renderer console tail ---");
        for (const line of activeCdp.console.slice(-12)) console.error(line);
        const dump = await activeCdp.evaluate(`({
          body: (document.body?.innerText || "").slice(0, 300),
          shell: !!document.querySelector(".app-shell"),
          splash: !!document.querySelector(".startup-splash"),
          main: !!document.querySelector(".main-pane"),
          panel: !!document.querySelector('[data-testid="work-panel"]'),
        })`);
        console.error("--- renderer state ---", JSON.stringify(dump));
      }
    } catch {}
    console.error(output.slice(-2_000));
    cleanup();
    clearTimeout(timeout);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
