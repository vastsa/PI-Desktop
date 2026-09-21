(function installPiOfficeBridge() {
  "use strict";

  const bridge = window.pluginBridge;
  const initialPath = new URL(window.location.href).searchParams.get("piViewOpen");
  const opened = new Map();
  let pendingConsumed = false;
  let currentPath = null;
  let closeCheckHandler = null;
  let closeSaveHandler = null;
  let closeCheckWaiter = null;
  let closeSaveWaiter = null;
  let openDocxHandler = null;
  let queuedOpenPath = null;
  let externalChangePending = false;
  let externalRefreshInFlight = false;
  let externalRefreshTimer = null;
  let aiPanelPrefs = {
    side: "left",
    fontSize: "default",
    customFontSize: 14,
    spellcheck: true,
  };

  function noop() {}
  function unsubscribe() {
    return noop;
  }

  function isAbsolutePath(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  function encodeBase64(value) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function language() {
    const raw = (navigator.language || "en").toLowerCase();
    return raw.startsWith("zh") ? "zh" : raw.startsWith("ja") ? "ja" : raw.startsWith("ko") ? "ko" : "en";
  }

  function theme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  async function readDoc(path) {
    const result = await bridge.invoke("office.read", {
      path,
      external: isAbsolutePath(path),
    });
    if (!result?.ok || typeof result.dataBase64 !== "string") return null;
    const file = {
      path: result.path || path,
      name: result.name || path.split(/[\\/]/).pop() || "document.docx",
      data: decodeBase64(result.dataBase64),
      hash: result.hash,
      size: result.size,
      mtimeMs: result.mtimeMs,
    };
    opened.set(file.path, file);
    currentPath = file.path;
    externalChangePending = false;
    return file;
  }

  function expectedFileState(file) {
    return {
      path: file.path,
      external: isAbsolutePath(file.path),
      expectedHash: file.hash,
      expectedSize: file.size,
      expectedMtimeMs: file.mtimeMs,
    };
  }

  function reportCloseCheck(state) {
    closeCheckWaiter?.(state);
    closeCheckWaiter = null;
  }

  function reportCloseSaveResult(ok) {
    closeSaveWaiter?.(ok === true);
    closeSaveWaiter = null;
  }

  async function requestCloseState() {
    if (!closeCheckHandler) return null;
    const result = new Promise((resolve) => {
      closeCheckWaiter = resolve;
      window.setTimeout(() => {
        if (!closeCheckWaiter) return;
        closeCheckWaiter = null;
        resolve(null);
      }, 2000);
    });
    closeCheckHandler();
    return result;
  }

  async function requestCloseSave() {
    if (!closeSaveHandler) return false;
    const result = new Promise((resolve) => {
      closeSaveWaiter = resolve;
      window.setTimeout(() => {
        if (!closeSaveWaiter) return;
        closeSaveWaiter = null;
        resolve(false);
      }, 30000);
    });
    closeSaveHandler();
    return result;
  }

  async function prepareForOpen(path) {
    if (!currentPath || currentPath === path) return true;
    const state = await requestCloseState();
    if (!state?.dirty) return true;
    if (!state.autoSave) {
      const message = language() === "zh"
        ? "当前文档有未保存的修改。保存后打开另一个文档吗？"
        : "The current document has unsaved changes. Save it before opening another document?";
      if (!window.confirm(message)) return false;
    }
    return requestCloseSave();
  }

  async function dispatchOpen(path) {
    if (!(await prepareForOpen(path))) return;
    const result = await readDoc(path);
    if (result) openDocxHandler?.(result);
  }

  bridge.on("view:open", (payload) => {
    const path = typeof payload?.path === "string" ? payload.path : "";
    if (!path) return;
    if (!openDocxHandler) {
      queuedOpenPath = path;
      return;
    }
    void dispatchOpen(path);
  });

  async function saveDoc(path, data, auto, force) {
    const previous = opened.get(path) || {};
    const result = await bridge.invoke("office.save", {
      path,
      external: isAbsolutePath(path),
      dataBase64: encodeBase64(data),
      expectedHash: previous.hash,
      expectedSize: previous.size,
      expectedMtimeMs: previous.mtimeMs,
      force: force === true,
    });
    if (result?.reason === "external-modified") {
      externalChangePending = true;
    }
    if (result?.reason === "external-modified" && !auto && force !== true) {
      const message = language() === "zh"
        ? "文件已在编辑器外发生变化。覆盖磁盘文件吗？"
        : "The file changed outside PI-Desktop. Overwrite the disk copy?";
      if (window.confirm(message)) return saveDoc(path, data, auto, true);
    }
    if (result?.ok) {
      opened.set(path, {
        ...previous,
        path,
        hash: result.hash,
        size: result.size,
        mtimeMs: result.mtimeMs,
      });
      externalChangePending = false;
    }
    return result || { ok: false, error: "office.save returned no result" };
  }

  async function refreshIfUnchangedInEditor() {
    if (
      externalRefreshInFlight ||
      externalChangePending ||
      !currentPath ||
      !openDocxHandler ||
      document.visibilityState === "hidden"
    ) {
      return;
    }

    const openedFile = opened.get(currentPath);
    if (!openedFile) return;

    externalRefreshInFlight = true;
    try {
      const result = await bridge.invoke(
        "office.checkConflict",
        { ...expectedFileState(openedFile), metadataOnly: true },
      );
      if (!result?.ok || result.conflict !== true) return;

      // Reuse GenOffice's existing lifecycle callback to determine whether the
      // in-memory editor is dirty. Never replace a user's unsaved document.
      const state = await requestCloseState();
      if (!state) return;
      if (state.dirty) {
        externalChangePending = true;
        return;
      }

      const refreshed = await readDoc(currentPath);
      if (refreshed && openDocxHandler) openDocxHandler(refreshed);
    } finally {
      externalRefreshInFlight = false;
    }
  }

  function startExternalRefresh() {
    if (externalRefreshTimer !== null) return;
    externalRefreshTimer = window.setInterval(() => {
      void refreshIfUnchangedInEditor();
    }, 2000);
    window.addEventListener("focus", refreshIfUnchangedInEditor);
    document.addEventListener("visibilitychange", refreshIfUnchangedInEditor);
  }

  function stopExternalRefresh() {
    if (externalRefreshTimer === null) return;
    window.clearInterval(externalRefreshTimer);
    externalRefreshTimer = null;
    window.removeEventListener("focus", refreshIfUnchangedInEditor);
    document.removeEventListener("visibilitychange", refreshIfUnchangedInEditor);
  }

  function unsupported(message) {
    return Promise.resolve({ ok: false, error: message });
  }

  const desktop = {
    getLanguage: () => Promise.resolve(language()),
    onLanguageChanged: unsubscribe,
    getTheme: () => Promise.resolve(theme()),
    getCurrentDocxPath: () => currentPath,
    onThemeChanged: unsubscribe,
    getAutoSaveDefault: () => Promise.resolve({ on: false, updatedAt: 0 }),
    onAutoSaveDefaultChanged: unsubscribe,
    getAiPanelPrefs: () => Promise.resolve(aiPanelPrefs),
    setAiPanelPrefs: (patch) => {
      aiPanelPrefs = { ...aiPanelPrefs, ...(patch || {}) };
      return Promise.resolve(aiPanelPrefs);
    },
    onAiPanelPrefsChanged: unsubscribe,
    onChromePressed: unsubscribe,
    onViewImage: unsubscribe,
    onZoteroRequest: unsubscribe,
    respondToZotero: noop,
    openDocx: () => Promise.resolve(null),
    openDocxPath: (path) => readDoc(path),
    openDocxDecrypt: () => Promise.resolve({ ok: false, reason: "unsupported" }),
    convertAltChunkHtml: () => Promise.resolve(null),
    setDocPassword: () => Promise.resolve({ ok: false }),
    docPasswordIntentRevision: () => Promise.resolve(0),
    discardDocPasswordIntents: () => Promise.resolve({ ok: true }),
    consumePendingOpenDocx: () => {
      if (pendingConsumed || !initialPath) return Promise.resolve(null);
      pendingConsumed = true;
      return readDoc(initialPath);
    },
    consumeNewBlankDoc: () => Promise.resolve(false),
    consumeAiDocContent: () => Promise.resolve(null),
    consumeHeadlessExport: () => Promise.resolve(null),
    headlessExportDone: noop,
    createDocument: () => unsupported("Creating a new DOCX is not available in the PI Office view"),
    onOpenDocx: (handler) => {
      openDocxHandler = handler;
      startExternalRefresh();
      if (queuedOpenPath) {
        const path = queuedOpenPath;
        queuedOpenPath = null;
        void dispatchOpen(path);
      }
      return () => {
        if (openDocxHandler === handler) openDocxHandler = null;
      };
    },
    onRenamedDocx: unsubscribe,
    saveDocx: (path, data, auto) => saveDoc(path, data, auto === true, false),
    writeRecoveryCopy: (path, data) => bridge.invoke("office.recovery", {
      path,
      dataBase64: encodeBase64(data),
    }),
    onTeardown: stopExternalRefresh,
    respellKick: () => Promise.resolve(),
    spellDiag: noop,
    saveDocxAs: () => unsupported("Save As is not available in the PI Office view"),
    saveDocxNew: () => unsupported("New documents are not available in the PI Office view"),
    saveDocxTo: () => unsupported("Explicit MCP saves are not available in the PI Office view"),
    onMcpCommand: unsubscribe,
    reportMcpResult: noop,
    signalMcpReady: noop,
    getRecentFiles: () => Promise.resolve([]),
    pickImage: () => Promise.resolve(null),
    fontMetrics: () => Promise.resolve(null),
    getAiSettings: () => Promise.resolve({ provider: "gsk", providers: {} }),
    setAiSettings: () => Promise.resolve(),
    copyImageToClipboard: () => Promise.resolve(false),
    getPathForFile: (file) => bridge.getDroppedFilePath(file),
    onAiStream: unsubscribe,
    onMenuCommand: unsubscribe,
    onCloseCheck: (handler) => {
      closeCheckHandler = handler;
      return () => {
        if (closeCheckHandler === handler) closeCheckHandler = null;
      };
    },
    reportCloseCheck,
    onCloseSaveRequest: (handler) => {
      closeSaveHandler = handler;
      return () => {
        if (closeSaveHandler === handler) closeSaveHandler = null;
      };
    },
    reportCloseSaveResult,
    reportViewMenuState: noop,
  };

  // GenOffice's editor has optional desktop-only features. Returning a safe
  // Promise from an unknown method keeps those controls inert without exposing
  // Electron, Node, or a wider host API to the page.
  window.desktop = new Proxy(desktop, {
    get(target, property) {
      if (property in target) return target[property];
      if (String(property).startsWith("on")) return unsubscribe;
      return () => Promise.resolve(null);
    },
  });

  window.filesPaneApi = new Proxy({}, { get: () => () => Promise.resolve({ ok: false, entries: [] }) });
  window.projectApi = new Proxy({}, { get: () => () => Promise.resolve(null) });

  // The PI work-panel editor is a document surface, not an AI surface. The
  // upstream app keeps the AI panel mounted for its normal desktop shell, so
  // default it closed before React's first render.
  localStorage.setItem("aidocs.showAi", "0");

  // The extracted file-pane toggle relies on GenOffice's desktop shell. Keep
  // it disabled so a prior click cannot remount the unsupported surface.
  localStorage.setItem("aidocs.showFiles", "0");

})();
