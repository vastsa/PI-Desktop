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
 *   - MainChat never measures below its 360px floor, including mid-drag and
 *     while `sidebar-out` still occupies flex space;
 *   - the expanded sidebar yields at the threshold and returns when the panel
 *     closes;
 *   - a manual reopen spends work-panel width first, otherwise targeting 370px.
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
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
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
      child.kill("SIGKILL");
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
    await cdp.send("Runtime.enable");

    const measure = () => cdp.evaluate(MEASURE);
    const rig = async (expression) => {
      await cdp.evaluate(`window.__PI_CAPTURE__ = 1; ${expression}`);
      await delay(420);
    };
    const clickSidebarToggle = async () => {
      await cdp.evaluate(
        `document.querySelector(".ct-lead .ct-icon-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
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
      "MainChat never drops below 360px during the drag preview",
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

    // 3. Reopen spends panel width first, otherwise targeting 370px.
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
      "the constrained reopen lands on the 370px MainChat target",
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
    // The sidebar toggle lives in MainChat's topbar, which preview mode does not
    // render, so the keyboard shortcut is the path that stays available.
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: 2,
      key: "b",
      code: "KeyB",
      windowsVirtualKeyCode: 66,
      nativeVirtualKeyCode: 66,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
      key: "b",
      code: "KeyB",
      windowsVirtualKeyCode: 66,
      nativeVirtualKeyCode: 66,
    });
    await delay(700);
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
    // Reopening the sidebar while previewing is the documented reopen path: it
    // spends panel width first, so the preferred width follows that gesture.
    check(
      storedAfterReopen ===
        JSON.stringify({
          width:
            previewWithSidebar.windowWidth -
            (previewWithSidebar.sidebar ?? 0) -
            MAIN_PANE_REOPEN_TARGET_WIDTH,
        }),
      "reopening the sidebar from preview mode records the reopen width",
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
