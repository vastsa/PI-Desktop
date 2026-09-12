import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  PLUGIN_PANEL_TITLEBAR_HEIGHT,
  PLUGIN_PANEL_CHROME_META_NAME,
  PLUGIN_PANEL_CHROME_VERSION,
  PLUGIN_PANEL_CHROME_PAINT_THROUGH_VERSION,
  PLUGIN_PANEL_EMBEDDED_ARGUMENT,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
  PLUGIN_PANEL_WINDOW_STATE_CHANNEL,
  type PluginPanelWindowControlAction,
  type PluginPanelTheme,
} from "../shared/plugin-panel-chrome";

const bridge = {
  invoke: async (channel: string, payload?: Record<string, unknown>) => {
    return ipcRenderer.invoke("pi-plugin-panel-invoke", channel, payload ?? {});
  },
  // Compatibility with the sample panel's older shape.
  send: (channel: string, payload?: Record<string, unknown>) => {
    return ipcRenderer.sendSync("pi-plugin-panel-bridge", channel, payload ?? {});
  },
  on: (event: string, handler: (...args: unknown[]) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(`pi-plugin-panel-event:${event}`, wrapped);
    return () => ipcRenderer.removeListener(`pi-plugin-panel-event:${event}`, wrapped);
  },
  /** Resolve a real dropped File without exposing Node or Electron to the page. */
  getDroppedFilePath: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld("pluginBridge", bridge);

// Record the gesture before page code handles it. The host consumes one of
// these short-lived paths when the panel asks for fs.registerDropped.
window.addEventListener(
  "drop",
  (event) => {
    const paths = [...(event.dataTransfer?.files ?? [])]
      .map((file) => bridge.getDroppedFilePath(file))
      .filter((path): path is string => Boolean(path));
    if (paths.length) ipcRenderer.send("pi-plugin-panel-drop", paths);
  },
  true,
);

type ChromeLabels = {
  toolbar: string;
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
  safeArea: string;
};

function isDevelopmentPanel(): boolean {
  return process.argv.includes("--pi-plugin-panel-development=1");
}

/** True when this surface is docked in the host work panel, not its own window. */
function isEmbeddedPanel(): boolean {
  return process.argv.includes(PLUGIN_PANEL_EMBEDDED_ARGUMENT);
}

function panelTheme(): PluginPanelTheme {
  const prefix = "--pi-plugin-panel-theme=";
  const raw = process.argv.find((argument) => argument.startsWith(prefix));
  if (raw?.slice(prefix.length) === "light") return "light";
  if (raw?.slice(prefix.length) === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function panelLocale(): string {
  const raw = process.argv.find((argument) =>
    argument.startsWith(PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX),
  );
  if (!raw) return navigator.language;
  try {
    return decodeURIComponent(raw.slice(PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX.length));
  } catch {
    return navigator.language;
  }
}

function usableColor(value: string): boolean {
  return value !== "transparent" && value !== "rgba(0, 0, 0, 0)";
}

function pageColor(property: "backgroundColor" | "color", fallback: string): string {
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const value = window.getComputedStyle(element)[property];
    if (usableColor(value)) return value;
  }
  return fallback;
}

function pageSurface(theme: PluginPanelTheme): string {
  return pageColor("backgroundColor", theme === "light" ? "#ffffff" : "#181818");
}

function publishTitlebarHeight(): void {
  document.documentElement?.style.setProperty(
    "--pi-plugin-titlebar-height",
    `${isEmbeddedPanel() ? 0 : PLUGIN_PANEL_TITLEBAR_HEIGHT}px`,
  );
}

function pluginOwnsTitlebarSpacing(): boolean {
  return pluginChromeMode() !== "legacy";
}

/**
 * Keep plugin-owned panel documents aligned with the app renderer's compact
 * scrollbar contract. A docked view is a separate WebContentsView, so it
 * cannot inherit `styles/base.css`; without this host-owned rule Windows falls
 * back to its wide classic scrollbar. The external page inside Browser is a
 * different WebContentsView and intentionally keeps the page's own styling.
 */
function installPluginScrollbarStyle(): void {
  if (!document.documentElement || document.getElementById("pi-plugin-scrollbars")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "pi-plugin-scrollbars";
  style.textContent = `
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: transparent;
      border: 1px solid transparent;
      border-radius: 999px;
      background-clip: content-box;
    }
    :hover::-webkit-scrollbar-thumb,
    :focus-within::-webkit-scrollbar-thumb,
    [data-scrolling]::-webkit-scrollbar-thumb {
      background: color-mix(in oklab, currentColor 16%, transparent);
      background-clip: content-box;
    }
    ::-webkit-scrollbar-thumb:hover,
    ::-webkit-scrollbar-thumb:active {
      background: color-mix(in oklab, currentColor 28%, transparent);
      background-clip: content-box;
    }
  `;
  document.documentElement.append(style);

  const timers = new Map<HTMLElement, number>();
  const onScroll = (event: Event) => {
    const element =
      event.target instanceof HTMLElement ? event.target : document.documentElement;
    if (!element) return;
    element.setAttribute("data-scrolling", "");
    const pending = timers.get(element);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.set(
      element,
      window.setTimeout(() => {
        timers.delete(element);
        element.removeAttribute("data-scrolling");
      }, 300),
    );
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
}

type PluginPanelChromeMode = "legacy" | "safe-area" | "paint-through";

function pluginChromeMode(): PluginPanelChromeMode {
  const marker = document
    .querySelector(`meta[name="${PLUGIN_PANEL_CHROME_META_NAME}"]`)
    ?.getAttribute("content")
    ?.trim();
  if (marker === PLUGIN_PANEL_CHROME_PAINT_THROUGH_VERSION) return "paint-through";
  if (marker === PLUGIN_PANEL_CHROME_VERSION) return "safe-area";
  return "legacy";
}

/**
 * v3 keeps the page visible through the 46px band. Only these page-owned
 * elements need holes in the host drag map; ordinary empty space remains
 * draggable. Plugins can opt custom controls into the same contract with
 * `data-pi-plugin-no-drag`.
 */
const PAINT_THROUGH_NO_DRAG_SELECTOR = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "textarea",
  "[contenteditable=\"true\"]",
  "[contenteditable=\"plaintext-only\"]",
  "[draggable=\"true\"]",
  "[role=\"button\"]",
  "[role=\"checkbox\"]",
  "[role=\"link\"]",
  "[role=\"radio\"]",
  "[role=\"switch\"]",
  "[role=\"tab\"]",
  "[role=\"textbox\"]",
  "[tabindex]",
  "[data-pi-plugin-no-drag]",
].join(",");

type PaintThroughRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type PaintThroughDragSegment = PaintThroughRect;

function isPaintThroughElementVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.pointerEvents === "none"
  ) {
    return false;
  }
  const opacity = Number.parseFloat(style.opacity);
  return !Number.isFinite(opacity) || opacity > 0;
}

function paintThroughNoDragRects(): PaintThroughRect[] {
  const rects: PaintThroughRect[] = [];
  for (const element of document.querySelectorAll(
    PAINT_THROUGH_NO_DRAG_SELECTOR,
  )) {
    if (!isPaintThroughElementVisible(element)) continue;
    for (const rect of Array.from(element.getClientRects())) {
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.right) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.bottom) ||
        rect.right <= rect.left ||
        rect.bottom <= rect.top
      ) {
        continue;
      }
      rects.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    }
  }
  return rects;
}

function paintThroughDragSegments(
  width: number,
  height: number,
  noDragRects: PaintThroughRect[],
): PaintThroughDragSegment[] {
  const clippedRects = noDragRects
    .map((rect) => ({
      left: Math.max(0, Math.min(width, rect.left)),
      right: Math.max(0, Math.min(width, rect.right)),
      top: Math.max(0, Math.min(height, rect.top)),
      bottom: Math.max(0, Math.min(height, rect.bottom)),
    }))
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  const yEdges = [0, height];
  for (const rect of clippedRects) {
    yEdges.push(rect.top, rect.bottom);
  }
  const sortedYEdges = [...new Set(yEdges)].sort((a, b) => a - b);
  const segments: PaintThroughDragSegment[] = [];

  for (let index = 0; index < sortedYEdges.length - 1; index += 1) {
    const top = sortedYEdges[index];
    const bottom = sortedYEdges[index + 1];
    if (bottom <= top) continue;

    const covered = clippedRects
      .filter((rect) => rect.top < bottom && rect.bottom > top)
      .sort((a, b) => a.left - b.left || a.right - b.right);
    let cursor = 0;
    for (const rect of covered) {
      if (rect.left > cursor) {
        segments.push({ left: cursor, right: rect.left, top, bottom });
      }
      cursor = Math.max(cursor, rect.right);
    }
    if (cursor < width) {
      segments.push({ left: cursor, right: width, top, bottom });
    }
  }
  return segments;
}

function installPaintThroughDragMap(dragRegion: HTMLElement): void {
  const sync = () => {
    const width = Math.max(
      1,
      window.innerWidth,
      document.documentElement?.clientWidth ?? 0,
    );
    const segments = paintThroughDragSegments(
      width,
      PLUGIN_PANEL_TITLEBAR_HEIGHT,
      paintThroughNoDragRects(),
    );
    dragRegion.replaceChildren(
      ...segments.map((segment) => {
        const element = document.createElement("div");
        element.className = "drag-segment";
        element.setAttribute("aria-hidden", "true");
        element.style.left = `${segment.left}px`;
        element.style.top = `${segment.top}px`;
        element.style.width = `${segment.right - segment.left}px`;
        element.style.height = `${segment.bottom - segment.top}px`;
        return element;
      }),
    );
  };

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "aria-hidden",
      "class",
      "data-pi-plugin-no-drag",
      "hidden",
      "style",
    ],
  });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  sync();
}

function chromeLabels(input = panelLocale()): ChromeLabels {
  const locale = input.replaceAll("_", "-").toLowerCase();
  const traditionalChinese =
    locale === "zh-tw" ||
    locale.startsWith("zh-tw-") ||
    locale === "zh-hant" ||
    locale.startsWith("zh-hant-") ||
    locale === "zh-hk" ||
    locale.startsWith("zh-hk-") ||
    locale === "zh-mo" ||
    locale.startsWith("zh-mo-");
  if (traditionalChinese) {
    return {
      toolbar: "外掛面板視窗控制項",
      minimize: "最小化",
      maximize: "最大化",
      restore: "還原",
      close: "關閉",
      safeArea: "開發提示 · 頂部 46px 為拖曳區",
    };
  }
  if (locale.startsWith("ko")) {
    return {
      toolbar: "플러그인 패널 창 컨트롤",
      minimize: "최소화",
      maximize: "최대화",
      restore: "복원",
      close: "닫기",
      safeArea: "개발 안내 · 상단 46px는 드래그 전용",
    };
  }
  if (locale.startsWith("tr")) {
    return {
      toolbar: "Eklenti paneli pencere denetimleri",
      minimize: "Küçült",
      maximize: "Büyüt",
      restore: "Geri yükle",
      close: "Kapat",
      safeArea: "Geliştirici ipucu · üst 46 piksel yalnızca sürükleme alanıdır",
    };
  }
  if (locale.startsWith("de")) {
    return {
      toolbar: "Plugin-Panel-Fenstersteuerung",
      minimize: "Minimieren",
      maximize: "Maximieren",
      restore: "Wiederherstellen",
      close: "Schließen",
      safeArea: "Entwicklerhinweis · die oberen 46 px dienen nur zum Ziehen",
    };
  }
  if (locale.startsWith("es")) {
    return {
      toolbar: "Controles de ventana del panel del complemento",
      minimize: "Minimizar",
      maximize: "Maximizar",
      restore: "Restaurar",
      close: "Cerrar",
      safeArea: "Aviso de desarrollo · los 46 px superiores son solo para arrastrar",
    };
  }
  if (locale.startsWith("fr")) {
    return {
      toolbar: "Contrôles de fenêtre du panneau du plugin",
      minimize: "Réduire",
      maximize: "Agrandir",
      restore: "Restaurer",
      close: "Fermer",
      safeArea: "Indication de développement · les 46 px supérieurs servent uniquement au déplacement",
    };
  }
  if (locale.startsWith("zh")) {
    return {
      toolbar: "插件面板窗口控制",
      minimize: "最小化",
      maximize: "最大化",
      restore: "还原",
      close: "关闭",
      safeArea: "开发提示 · 顶部 46px 为拖拽区",
    };
  }
  return {
    toolbar: "Plugin panel window controls",
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
    safeArea: "Dev hint · top 46px is drag-only",
  };
}

function createControlButton(
  action: PluginPanelWindowControlAction,
  label: string,
  icon: "minimize" | "maximize" | "restore" | "close",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control control-${action === "close" ? "close" : "default"}`;
  button.title = label;
  button.setAttribute("aria-label", label);

  const glyph = document.createElement("span");
  glyph.className = `glyph glyph-${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph);
  return button;
}

function installPanelChrome(): void {
  const body = document.body;
  if (!body || document.querySelector("pi-plugin-panel-chrome")) return;

  installPluginScrollbarStyle();

  // Publish this before the page's DOMContentLoaded handlers run so modern
  // plugin CSS can resolve its variable without an extra reflow or a second
  // 46px offset.
  publishTitlebarHeight();

  // A docked view has no window controls and no drag band, so it gets the full
  // surface. The variable is still published — at 0 — so a plugin's fixed
  // toolbar offset resolves to the right value in both placements.
  if (isEmbeddedPanel()) {
    document.documentElement.style.setProperty("--pi-plugin-titlebar-height", "0px");
    return;
  }

  // v2 pages use `padding-top: var(--pi-plugin-titlebar-height, 0px)` (or
  // their own calc from it), so preserving the original body padding is what
  // keeps their content tight. Legacy pages do not know about the variable;
  // retain the additive fallback for those pages only.
  if (!pluginOwnsTitlebarSpacing()) {
    const originalPaddingTop = Number.parseFloat(
      window.getComputedStyle(body).paddingTop,
    );
    body.style.setProperty("box-sizing", "border-box", "important");
    body.style.setProperty(
      "padding-top",
      `${
        (Number.isFinite(originalPaddingTop) ? originalPaddingTop : 0) +
        PLUGIN_PANEL_TITLEBAR_HEIGHT
      }px`,
      "important",
    );
  }

  let labels = chromeLabels();
  const theme = panelTheme();
  const chromeMode = pluginChromeMode();
  const host = document.createElement("pi-plugin-panel-chrome");
  host.dataset.theme = theme;
  host.dataset.chromeMode = chromeMode;
  const syncPageColors = () => {
    host.style.setProperty(
      "--pi-plugin-panel-page-background",
      pageSurface(theme),
    );
    host.style.setProperty(
      "--pi-plugin-panel-page-foreground",
      pageColor("color", theme === "light" ? "#1a1c1f" : "#ffffff"),
    );
  };
  syncPageColors();
  host.setAttribute("role", "toolbar");
  host.setAttribute("aria-label", labels.toolbar);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      color-scheme: light dark;
      pointer-events: none;
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 2147483647;
      display: block;
      height: ${PLUGIN_PANEL_TITLEBAR_HEIGHT}px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .chrome {
      position: relative;
      width: 100%;
      height: ${PLUGIN_PANEL_TITLEBAR_HEIGHT}px;
    }
    .drag-region {
      -webkit-app-region: drag;
      app-region: drag;
      pointer-events: auto;
      position: absolute;
      inset: 0;
      z-index: 0;
      height: ${PLUGIN_PANEL_TITLEBAR_HEIGHT}px;
      user-select: none;
    }
    /* Paint-through pages replace the full drag rectangle with empty-space
       segments. The gaps expose page controls instead of relying on
       pointer-events alone, which does not override Electron's native
       -webkit-app-region hit testing. */
    :host([data-chrome-mode="paint-through"]) .drag-region {
      -webkit-app-region: no-drag;
      app-region: no-drag;
      pointer-events: none;
    }
    .drag-segment {
      -webkit-app-region: drag;
      app-region: drag;
      pointer-events: auto;
      position: absolute;
      z-index: 0;
      user-select: none;
    }
    .safe-area-hint {
      position: absolute;
      top: 50%;
      left: 10px;
      z-index: 1;
      max-width: calc(100% - 126px);
      overflow: hidden;
      color: color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 46%, transparent);
      font-size: 10px;
      line-height: 1;
      pointer-events: none;
      text-overflow: ellipsis;
      transform: translateY(-50%);
      user-select: none;
      white-space: nowrap;
    }
    .capsule {
      -webkit-app-region: no-drag;
      app-region: no-drag;
      pointer-events: auto;
      position: absolute;
      top: 9px;
      right: 8px;
      z-index: 2;
      box-sizing: border-box;
      display: flex;
      width: 96px;
      height: 28px;
      align-items: center;
      gap: 1px;
      overflow: hidden;
      border: 1px solid color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 16%, transparent);
      border-radius: 999px;
      padding: 1px;
      background: color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 6%, transparent);
      user-select: none;
    }
    .control {
      -webkit-app-region: no-drag;
      app-region: no-drag;
      pointer-events: auto;
      display: inline-flex;
      min-width: 0;
      height: 24px;
      flex: 1 1 0;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 7px;
      outline: none;
      background: transparent;
      color: color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 58%, transparent);
      cursor: pointer;
      font: inherit;
      transition: background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .control:hover {
      background: color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 8%, transparent);
      color: var(--pi-plugin-panel-page-foreground);
    }
    .control:focus-visible {
      box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--pi-plugin-panel-page-foreground) 50%, transparent);
    }
    .control-close:hover {
      background: rgba(210, 43, 51, 0.78);
      color: #ffffff;
    }
    .glyph {
      position: relative;
      display: block;
      box-sizing: border-box;
      width: 12px;
      height: 12px;
    }
    .glyph-minimize::before {
      position: absolute;
      top: 6px;
      left: 1px;
      width: 10px;
      border-top: 1px solid currentColor;
      content: "";
    }
    .glyph-maximize {
      width: 10px;
      height: 10px;
      border: 1px solid currentColor;
    }
    .glyph-restore::before,
    .glyph-restore::after {
      position: absolute;
      box-sizing: border-box;
      width: 8px;
      height: 8px;
      border: 1px solid currentColor;
      content: "";
    }
    .glyph-restore::before {
      top: 1px;
      right: 1px;
    }
    .glyph-restore::after {
      bottom: 1px;
      left: 1px;
      background: var(--pi-plugin-panel-page-background);
    }
    .glyph-close::before,
    .glyph-close::after {
      position: absolute;
      top: 5.5px;
      left: 0.5px;
      width: 11px;
      border-top: 1px solid currentColor;
      content: "";
      transform: rotate(45deg);
    }
    .glyph-close::after {
      transform: rotate(-45deg);
    }
    :host([data-theme="light"]) {
      color-scheme: light;
    }
    :host([data-theme="dark"]) {
      color-scheme: dark;
    }
    @media (prefers-reduced-motion: reduce) {
      .control {
        transition-duration: 0.01ms;
      }
    }
  `;

  const chrome = document.createElement("div");
  chrome.className = "chrome";

  const dragRegion = document.createElement("div");
  dragRegion.className = "drag-region";
  dragRegion.setAttribute("aria-hidden", "true");

  const safeAreaHint = isDevelopmentPanel() && chromeMode === "safe-area"
    ? document.createElement("span")
    : null;
  if (safeAreaHint) {
    safeAreaHint.className = "safe-area-hint";
    safeAreaHint.textContent = labels.safeArea;
    safeAreaHint.setAttribute("role", "note");
    safeAreaHint.setAttribute("aria-label", labels.safeArea);
  }

  const controls = document.createElement("div");
  controls.className = "capsule";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", labels.toolbar);

  const minimize = createControlButton(
    "minimize",
    labels.minimize,
    "minimize",
  );
  const maximize = createControlButton(
    "toggleMaximize",
    labels.maximize,
    "maximize",
  );
  const close = createControlButton("close", labels.close, "close");

  const setMaximized = (maximized: boolean) => {
    const label = maximized ? labels.restore : labels.maximize;
    maximize.title = label;
    maximize.setAttribute("aria-label", label);
    const glyph = maximize.firstElementChild;
    if (glyph) {
      glyph.className = `glyph glyph-${maximized ? "restore" : "maximize"}`;
    }
  };
  const invokeControl = async (action: PluginPanelWindowControlAction) => {
    try {
      const result = (await ipcRenderer.invoke(
        PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
        action,
      )) as { maximized?: boolean };
      if (action === "getState" || action === "toggleMaximize") {
        setMaximized(Boolean(result?.maximized));
      }
    } catch {
      // A close action can destroy the sender before Electron resolves IPC.
    }
  };

  minimize.addEventListener("click", () => void invokeControl("minimize"));
  maximize.addEventListener(
    "click",
    () => void invokeControl("toggleMaximize"),
  );
  close.addEventListener("click", () => void invokeControl("close"));
  ipcRenderer.on(
    PLUGIN_PANEL_WINDOW_STATE_CHANNEL,
    (_event, state: { maximized?: boolean }) =>
      setMaximized(Boolean(state?.maximized)),
  );
  // The plugin receives appearance changes through the same event channel.
  // Re-sample after the page has applied its new data attribute so the capsule
  // remains legible when a plugin switches between light and dark palettes.
  ipcRenderer.on(
    "pi-plugin-panel-event:appearance:changed",
    (_event, appearance: { locale?: string }) => {
      if (typeof appearance?.locale === "string") {
        labels = chromeLabels(appearance.locale);
        host.setAttribute("aria-label", labels.toolbar);
        controls.setAttribute("aria-label", labels.toolbar);
        minimize.title = labels.minimize;
        minimize.setAttribute("aria-label", labels.minimize);
        close.title = labels.close;
        close.setAttribute("aria-label", labels.close);
        const maximized = maximize.firstElementChild?.classList.contains(
          "glyph-restore",
        );
        setMaximized(Boolean(maximized));
        if (safeAreaHint) {
          safeAreaHint.textContent = labels.safeArea;
          safeAreaHint.setAttribute("aria-label", labels.safeArea);
        }
      }
      window.setTimeout(syncPageColors, 0);
    },
  );
  void invokeControl("getState");

  controls.append(minimize, maximize, close);
  chrome.append(dragRegion);
  if (safeAreaHint) chrome.append(safeAreaHint);
  chrome.append(controls);
  shadow.append(style, chrome);
  document.documentElement.append(host);
  if (chromeMode === "paint-through") {
    installPaintThroughDragMap(dragRegion);
  }
}

// Pre-publish the value before page styles and DOMContentLoaded handlers run.
// The install path repeats this defensively for pages that replace their root.
publishTitlebarHeight();

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installPanelChrome, { once: true });
} else {
  installPanelChrome();
}

export type PluginPanelBridge = typeof bridge;
