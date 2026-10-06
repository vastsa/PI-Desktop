import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { api } from "../../apps/desktop/src/lib/api";
import { AgentSubagentsPage } from "../../apps/desktop/src/components/settings/AgentSubagentsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
window.piDesktop = { platform: "darwin", on() { return () => {}; } };
let record = { id: "scope-reviewer", name: "scope-reviewer", description: "Review fixture", tools: ["Read"], enabled: false, scope: { mode: "global", projects: [] }, path: "/fixture/reviewer.md" };
const saved = [];
localStorage.setItem("pi.desktop.recentProjects", JSON.stringify([
  { path: "/recent-only", name: "Recent only", openedAt: 1 },
]));
api.listUserSubagents = async () => ({ subagents: [record] });
api.subagentCatalog = async () => ({ subagents: [], builtins: [] });
api.readUserSubagent = async () => ({ subagent: record, body: "Review only." });
api.listProjects = async () => ({ projects: [] });
api.listProjectGroups = async () => ({ groups: [
  { id: "a", name: "Project A", primaryPath: "/project-a", lastOpenedAt: 1, pinned: false, roots: [{ path: "/project-a", name: "a" }] },
  { id: "b", name: "Project B", primaryPath: "/project-b", lastOpenedAt: 1, pinned: false, roots: [{ path: "/project-b", name: "b" }] },
] });
api.updateUserSubagent = async (id, input) => { record = { ...record, ...input }; saved.push(input); return { subagent: record }; };
useAppStore.setState({ workspace: { path: "/project-a" }, providers: [], showToast() {} });
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
flushSync(() => createRoot(document.getElementById("root")).render(<AgentSubagentsPage />));
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(query) { for (let i=0;i<120;i++) { const value=query(); if(value) return value; await frame(); } throw new Error("UI condition not reached: " + document.body.innerText + JSON.stringify([...document.querySelectorAll("button")].map(n => ({label:n.getAttribute("aria-label"),cls:n.className})))); }
const radio = (label) => [...document.querySelectorAll('[role="radio"]')].find(n => n.getAttribute("aria-label") === label);
const saveButton = () => [...document.querySelectorAll("button")].find(n => n.textContent.trim() === "Save");
async function edit() { const button=await waitFor(() => document.querySelector('.settings-icon-button[aria-label*="scope-reviewer"]')); flushSync(() => button.click()); const projects = await waitFor(() => radio("Projects")); projects.scrollIntoView({ block: "center" }); await frame(); }
window.subagentProjectScopeProbe = async () => {
  await edit();
  if (radio("Off")) throw new Error("Scope must not include enablement");
  flushSync(() => radio("Projects").click());
  await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(n => n.textContent.includes("Recent only")));
  const a = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(n => n.textContent.includes("Project A")));
  if (a.getAttribute("aria-selected") !== "false") throw new Error("Current project must not be selected automatically");
  flushSync(() => a.click());
  const b = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(n => n.textContent.includes("Project B")));
  if (!b.closest(".ext-sheet")) throw new Error("Project choices must stay inside the editor");
  flushSync(() => b.click());
  flushSync(() => saveButton().click());
  await waitFor(() => saved.length === 1 && !radio("Projects"));
  await edit();
  if (radio("Projects").getAttribute("aria-checked") !== "true") throw new Error("Scope did not reload");
  flushSync(() => radio("Everywhere").click());
  flushSync(() => saveButton().click());
  await waitFor(() => saved.length === 2 && !radio("Projects"));
  await edit();
  flushSync(() => radio("Projects").click());
  flushSync(() => saveButton().click());
  await waitFor(() => saved.length === 3 && !radio("Projects"));
  return { saved };
};
`;

const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

test("Subagent editor saves project scope and retains selection across global mode", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-subagent-project-scope-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "subagent-project-scope.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [urlAssets],
    });

    const renderer = join(root, "apps/desktop/out/renderer");
    const rendererHtml = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...rendererHtml.matchAll(/href="([^" ]+\.css)"/g)]
      .map((match) => match[1]);
    assert(css.length, "Run pnpm --filter @pi-desktop/desktop build before this test");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.subagentProjectScopeProbe()");
    console.log("SUBAGENT_PROJECT_SCOPE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output);
    const resultLine = output.split(/\r?\n/)
      .find((line) => line.startsWith("SUBAGENT_PROJECT_SCOPE "));
    assert(resultLine, output);
    const result = JSON.parse(resultLine.slice("SUBAGENT_PROJECT_SCOPE ".length));

    assert.equal(result.saved.length, 3);
    assert(result.saved.every((draft) => draft.enabled === false), "Scope edits preserve disabled state");
    assert.deepEqual(result.saved[0].scope, { mode: "projects", projects: ["/project-a", "/project-b"] });
    assert.deepEqual(result.saved[1].scope, { mode: "global", projects: ["/project-a", "/project-b"] });
    assert.deepEqual(result.saved[2].scope, result.saved[0].scope);

  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
