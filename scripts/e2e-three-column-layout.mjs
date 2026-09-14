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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

class CdpClient {
  constructor(ws) {
    this.ws = ws;
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
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
      ws.onopen = () => resolve(new CdpClient(ws));
    });
  }

  send(method, params = {}) {
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
  const handle = document.querySelector(".work-panel-resize");
  return {
    windowWidth: window.innerWidth,
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
    for (const dir of [dataDir, profileDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };

  const timeout = setTimeout(() => {
    console.error("FAIL three-column layout — timeout after 180s");
    console.error(output.slice(-2_000));
    cleanup();
    process.exit(1);
  }, 180_000);

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
      const bar = document.querySelector(".composer-toolbar");
      const left = document.querySelector(".composer-left");
      const right = document.querySelector(".composer-right");
      if (!bar || !left || !right) return null;
      return {
        width: Math.round(bar.getBoundingClientRect().width),
        clipped: bar.scrollWidth > bar.clientWidth + 1,
        sameRow:
          Math.round(left.getBoundingClientRect().top) ===
          Math.round(right.getBoundingClientRect().top),
      };
    })()`);
    check(
      composer !== null && composer.clipped === false && composer.sameRow === true,
      "the composer toolbar stays on one unfolded row at the MainChat floor",
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

    const openedTabPreview = await cdp.evaluate(`(() => {
      const actionGroup = document.querySelector(
        ".window-chrome-row .titlebar-nav",
      );
      const firstTab = document.querySelector(".work-panel-tab");
      const header = document.querySelector(".work-panel-header");
      const actionGroupBox = actionGroup?.getBoundingClientRect();
      const firstTabBox = firstTab?.getBoundingClientRect();
      return {
        platform: window.piDesktop?.platform ?? "unknown",
        fullscreen: document.documentElement.dataset.fullscreen === "true",
        actionGroupRight: actionGroupBox
          ? Math.round(actionGroupBox.right)
          : null,
        firstTabLeft: firstTabBox ? Math.round(firstTabBox.left) : null,
        headerPaddingLeft: header
          ? Math.round(parseFloat(getComputedStyle(header).paddingLeft))
          : null,
      };
    })()`);
    check(
      openedTabPreview.firstTabLeft !== null &&
        (openedTabPreview.platform !== "darwin" ||
          openedTabPreview.actionGroupRight === null ||
          openedTabPreview.firstTabLeft >=
            openedTabPreview.actionGroupRight + 8),
      "opened work-panel tabs clear the preview action group",
      JSON.stringify(openedTabPreview),
    );
    const previewActions = await cdp.evaluate(`(() => {
      const firstAction =
        document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ??
        document.querySelector('.window-chrome-row [data-nav="new-task"]');
      const firstActionBox = firstAction?.getBoundingClientRect();
      return {
        platform: window.piDesktop?.platform ?? "unknown",
        fullscreen: document.documentElement.dataset.fullscreen === "true",
        firstActionLeft: firstActionBox ? Math.round(firstActionBox.left) : null,
        newTask: !!document.querySelector('.window-chrome-row [data-nav="new-task"]'),
        sidebarToggle:
          !!document.querySelector('.window-chrome-row [data-nav="toggle-sidebar"]') ||
          !!document.querySelector('.sidebar [data-nav="toggle-sidebar"]'),
        controls: !!document.querySelector(".window-chrome-row .window-controls"),
      };
    })()`);
    check(
      previewActions.newTask &&
        previewActions.sidebarToggle &&
        (previewActions.controls || previewActions.platform === "darwin") &&
        (previewActions.platform !== "darwin" ||
          previewActions.fullscreen ||
          (previewActions.firstActionLeft !== null &&
            previewActions.firstActionLeft >= 76)),
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
      const controls = document.querySelector(".window-chrome-row .window-controls");
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
      "sidebar stays at its fixed width",
      JSON.stringify(e2eChromeSidebar),
    );
    check(
      e2eChromeSidebar.handleVisible === false,
      "the sidebar edge is no longer a resize affordance",
      JSON.stringify(e2eChromeSidebar),
    );
    check(
      e2eChromeSidebar.storedWidth === null,
      "sidebar width is no longer persisted",
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
        (e2eChromePreview.firstActionLeft !== null &&
          e2eChromePreview.firstActionLeft >= 76),
      "preview actions clear the macOS traffic-light hit area",
      JSON.stringify(e2eChromePreview),
    );
    check(
      e2eChromePreview.platform !== "darwin" ||
        e2eChromePreview.sidebarWidth !== null ||
        (e2eChromePreview.panelHeaderPaddingLeft !== null &&
          e2eChromePreview.previewActionGroupRight !== null &&
          e2eChromePreview.panelHeaderPaddingLeft >=
            e2eChromePreview.previewActionGroupRight + 8 &&
          e2eChromePreview.panelTabStripLeft !== null &&
          e2eChromePreview.panelTabStripLeft >=
            e2eChromePreview.previewActionGroupRight + 8),
      "maximized panel header clears the macOS preview action lane",
      JSON.stringify(e2eChromePreview),
    );
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
