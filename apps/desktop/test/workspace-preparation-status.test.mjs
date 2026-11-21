import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

let server;
let WorkspacePreparationStatus;
const previousWindow = globalThis.window;

before(async () => {
  globalThis.window = {
    piDesktop: {
      on: () => () => {},
      invoke: async () => ({ ok: true, data: {} }),
    },
  };
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ WorkspacePreparationStatus } = await server.ssrLoadModule(
    "/src/features/chat/session-target/WorkspacePreparationStatus.tsx",
  ));
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
});

after(async () => {
  globalThis.window = previousWindow;
  await server?.close();
});

const baseWorkspace = {
  environmentId: "env-1",
  hostKey: "h1",
  repository: { owner: "octo", name: "repo" },
  baseBranch: "main",
  workBranch: "pi-desktop/abc123",
};

const renderStatus = (workspace) =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(WorkspacePreparationStatus, { sessionId: "session-1", workspace }),
    ),
  );

test("preparing phase renders git progress detail and percent", () => {
  const html = renderStatus({
    ...baseWorkspace,
    state: "preparing",
    phase: "cloning",
    progress: { detail: "Receiving objects", percent: 42 },
  });
  assert.match(html, /role="status"/);
  assert.match(html, /Receiving objects 42%/);
});

test("runningSetup phase renders live setup logTail in an open details disclosure", () => {
  const html = renderStatus({
    ...baseWorkspace,
    state: "preparing",
    phase: "runningSetup",
    setup: { status: "running", logTail: "npm ci\ninstalled 42 packages" },
  });
  assert.match(html, /role="status"/);
  assert.match(html, /<details open="">/);
  assert.match(html, /Show log/);
  assert.match(html, /<pre>npm ci\ninstalled 42 packages<\/pre>/);
});

test("failed setup renders Retry and Dismiss controls with log disclosure", () => {
  const html = renderStatus({
    ...baseWorkspace,
    state: "ready",
    setup: { status: "failed", logTail: "exit code 1" },
  });
  assert.match(html, /The setup script failed\. The workspace is ready\./);
  assert.match(html, /<pre>exit code 1<\/pre>/);
  assert.match(html, />Retry<\/button>/);
  assert.match(html, />Dismiss<\/button>/);
});

const interactionFixture = String.raw`
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { WorkspacePreparationStatus } from "./src/features/chat/session-target/WorkspacePreparationStatus";

globalThis.workspacePrepProbe = async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  });
  const calls = [];
  window.piDesktop = {
    on() { return () => {}; },
    async invoke(channel, input) {
      calls.push({ channel, input });
      return { ok: true, data: {} };
    },
  };
  let setWorkspace;
  const failed = {
    environmentId: "env-1",
    hostKey: "h1",
    repository: { owner: "octo", name: "repo" },
    baseBranch: "main",
    workBranch: "pi-desktop/abc123",
    state: "ready",
    setup: { status: "failed", logTail: "boom" },
  };
  function Surface() {
    const [workspace, update] = React.useState(failed);
    setWorkspace = update;
    return <WorkspacePreparationStatus sessionId="session-1" workspace={workspace} />;
  }
  const rootEl = document.querySelector("#root");
  const view = createRoot(rootEl);
  flushSync(() => view.render(<Surface />));
  const button = (label) => [...rootEl.querySelectorAll("button")].find((el) => el.textContent.trim() === label);

  // Dismiss hides the banner, then a retry transition + second failure resets dismissed.
  button("Dismiss").click();
  flushSync(() => {});
  if (rootEl.textContent.trim() !== "") throw new Error("expected banner to be dismissed");
  flushSync(() => setWorkspace({ ...failed, state: "preparing", phase: "runningSetup", setup: { status: "running", logTail: "retrying..." } }));
  if (!rootEl.querySelector("details[open] pre")?.textContent.includes("retrying...")) {
    throw new Error("expected live setup log during retry");
  }
  flushSync(() => setWorkspace({ ...failed, setup: { status: "failed", logTail: "failed again" } }));
  if (!button("Retry")) throw new Error("expected banner to reappear after new setup failure");

  button("Retry").click();
  const deadline = performance.now() + 2_000;
  while (calls.length === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (calls.length !== 1 || calls[0].channel !== IPC.invoke.remoteSessionWorkspaceRetry || calls[0].input?.sessionId !== "session-1") {
    throw new Error("expected Retry button to invoke remoteSessionWorkspaceRetry: " + JSON.stringify(calls));
  }
  return true;
};
`;

test("failed setup Retry button invokes retryRemoteSessionWorkspace and dismiss resets on retry", {
  timeout: 75_000,
  skip: process.platform === "linux" && !process.env.DISPLAY && "Isolated Electron UI test requires a display",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-workspace-prep-"));
  try {
    await build({
      stdin: { contents: interactionFixture, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => console.error(event.message));
  await window.loadFile(join(__dirname, "index.html"));
  if (await window.webContents.executeJavaScript("globalThis.workspacePrepProbe()") !== true) {
    throw new Error("WorkspacePreparationStatus probe did not complete");
  }
  console.log("WORKSPACE_PREPARATION_STATUS_PROBE passed");
  app.exit(0);
}).catch((error) => {
  console.error(error?.stack ?? error);
  app.exit(1);
});
`,
    );
    const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output = (output + chunk).slice(-12_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const [code] = await once(child, "close");
      assert.equal(code, 0, output);
      assert.match(output, /^WORKSPACE_PREPARATION_STATUS_PROBE passed$/m, output);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
