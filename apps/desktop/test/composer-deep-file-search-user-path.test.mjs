/**
 * Issue #1781: in a large tree the `@` menu could not reach deep files.
 *
 * The file index keeps only the shallowest 8000 entries, so a script deep in a
 * Unity project matched nothing however much of its name was typed. This drives
 * the composer pieces the app wires together — draft, completions, input, menu —
 * against a truncated index and a main-process search the test answers itself.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("the search channel runs main's listing search and leaves remote sessions on their snapshot", async () => {
  const [protocol, api, workspaceIpc] = await Promise.all([
    readFile(join(root, "packages/shared/src/protocol.ts"), "utf8"),
    readFile(join(root, "apps/desktop/src/lib/api.ts"), "utf8"),
    readFile(join(root, "apps/desktop/electron/main/ipc/workspace-ipc.ts"), "utf8"),
  ]);
  assert.match(protocol, /fsSearch: "pi-desktop\/fs\/search"/);
  assert.match(api, /invoke<FsIndexResult>\(IPC\.invoke\.fsSearch, \{ \.\.\.\(sessionId \? \{ sessionId \} : \{\}\), query \}\)/);
  const handler = workspaceIpc.match(/handle\(IPC\.invoke\.fsSearch,[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(handler, "main must register the search channel");
  assert.match(handler, /remoteFileWorkspace\(input\.sessionId\)\) return \{ entries: \[\], truncated: true \}/);
  assert.match(handler, /return searchWorkspaceFiles\(root, String\(input\.query \?\? ""\)\)/);
});

const fixture = String.raw`
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { useComposerDraft } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import { setEditorCaret } from "../../apps/desktop/src/features/chat/composer/editor";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const DEEP = "Assets/_Game/Scripts/Gameplay/Player/Controllers/FeatureController.cs";
const SAVE = "Assets/_Game/Scripts/Systems/Save/SaveSlots.cs";
const STALE = "Assets/Stale/SaveFeature.cs";
// Short enough to rank inside the bare @ menu if a searched row leaked into it.
const SHORT = "a.cs";
const UNICODE = "src/café-竞赛-🚀.ts";
// The shallowest 8000 entries of a large tree; the deep scripts are not among them.
const shallow = Array.from({ length: 8000 }, (_, index) => ({
  path: "Assets/Art/Group" + Math.floor(index / 300) + "/asset_" + index + ".png",
  kind: "file",
}));
let fileIndex = { entries: shallow, truncated: true };
const searches = [];
api.fsIndex = async () => fileIndex;
api.fsSearch = (sessionId, query) =>
  new Promise((resolve, reject) => searches.push({ sessionId, query, resolve, reject }));

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
useAppStore.setState({ activeSessionId: "s1", workspace: { path: "/large", name: "large" } });

const noop = () => {};
let draft;
function Fixture() {
  draft = useComposerDraft({
    variant: "docked", activeSessionId: "s1", workspacePath: "/large",
    sessions: [{ id: "s1" }], composerPrefill: null, clearComposerPrefill: noop,
    t: (key) => key, invalidateComposerTransforms: noop, inputBlocked: false,
  });
  const completions = useComposerCompletions({
    value: draft.value, cursor: draft.cursor, composing: draft.composing, enabled: true,
    referenceSessionId: "s1", fileReferencesRef: draft.fileReferencesRef,
    applyEditorDraft: draft.applyEditorDraft, handleInput: draft.handleInput,
    invalidateComposerTransforms: noop,
  });
  return <>
    <ComposerInput inputRef={draft.ref} value={draft.value} placeholderText="" placeholderKey="fixture"
      inputBlocked={false} pasting={false} enterToSend={false} runActive={false}
      composerAc={completions.ac} onPaste={noop} onAcceptCompletion={completions.acceptCompletion}
      onSubmit={noop} onInsertNewline={noop} onHistoryNavigate={() => false}
      onInput={(source, caret) => completions.handleInput(source, caret)}
      onCompositionStart={() => draft.setComposing(true)}
      onCompositionEnd={() => draft.setComposing(false)}
      onSettledInput={() => draft.setComposing(false)} onFocus={noop} onBlur={noop} />
    <ComposerAutocomplete anchorRef={draft.ref} ac={completions.ac} onAccept={completions.acceptCompletion} />
  </>;
}

const rootNode = createRoot(document.getElementById("root"));
const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
const editor = () => document.querySelector(".composer-input");
const rows = () => [...document.querySelectorAll('[role="option"] .composer-ac-path')].map((row) => row.textContent);
const noteShown = () => document.querySelector(".composer-ac-truncated") !== null;
function check(condition, message) { if (!condition) throw new Error(message + " rows=" + JSON.stringify(rows().slice(0, 5))); }
async function until(predicate, message) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check(false, message);
}
async function type(text) {
  const el = editor();
  el.textContent = text;
  setEditorCaret(el, text.length);
  await settle();
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  await settle();
}

window.deepFileSearchProbe = async () => {
  flushSync(() => rootNode.render(<Fixture />));
  await settle();
  editor().focus();

  await type("@");
  await until(() => rows().length > 0, "the @ menu did not open");
  check(noteShown(), "a truncated index must say so");
  check(searches.length === 0, "an empty query must not search");

  await type("@FeatureController");
  check(!rows().includes(DEEP), "the truncated index cannot know the deep file");
  await until(() => searches.length === 1, "the query was not searched after the pause");
  check(searches[0].query === "FeatureController" && searches[0].sessionId === "s1",
    "searched the wrong query or session: " + searches[0].query);
  searches[0].resolve({ entries: [{ path: DEEP, kind: "file" }], truncated: false });
  await until(() => rows().includes(DEEP), "the searched deep file did not appear");
  check(!noteShown(), "a complete search must clear the truncation note");
  check(searches.length === 1, "one pause must search once");

  editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  check(draft.fileReferencesRef.current.some((reference) => reference.path === DEEP),
    "accepting the row did not reference the deep file");

  await type("@Feat");
  check(!rows().includes(DEEP), "a new @ token inherited the previous token's rows");
  await until(() => searches.length === 2, "the second query was not searched");
  await type("@Save");
  await until(() => searches.length === 3, "the third query was not searched");
  searches[2].resolve({ entries: [{ path: SAVE, kind: "file" }, { path: SHORT, kind: "file" }], truncated: false });
  await until(() => rows().includes(SAVE), "the current answer did not appear");
  searches[1].resolve({ entries: [{ path: STALE, kind: "file" }], truncated: false });
  await settle();
  check(!rows().includes(STALE), "an answer for an earlier query replaced the current one");

  await type("@");
  await settle();
  check(!rows().includes(SHORT), "a bare @ listed rows searched for an earlier query");
  check(noteShown(), "a bare @ must report that the index alone is incomplete");

  await type("@Missing");
  await until(() => searches.length === 4, "the incomplete query was not searched");
  searches[3].resolve({ entries: [], truncated: true });
  await settle();
  check(noteShown(), "an incomplete search must keep the truncation note");

  await type("@Broken");
  await until(() => searches.length === 5, "the failing query was not searched");
  searches[4].reject(new Error("search failed"));
  await settle();
  check(noteShown(), "a failed search must keep the truncation note");

  fileIndex = { entries: ["README.md", UNICODE].map((path) => ({ path, kind: "file" })), truncated: false };
  useAppStore.setState({ workspace: { path: "/small", name: "small" } });
  await type("");
  await type("@竞赛");
  await until(() => rows().includes(UNICODE), "the Unicode file name was not preserved in the menu");
  editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  check(draft.fileReferencesRef.current.some((reference) => reference.path === UNICODE),
    "accepting the Unicode row changed the file reference");
  await type("@nothing");
  await new Promise((resolve) => setTimeout(resolve, 400));
  check(searches.length === 5, "a complete index must not search");
  check(!noteShown(), "a complete index has no truncation note");

  flushSync(() => rootNode.unmount());
  return { passed: true, queries: searches.map((search) => search.query) };
};
`;

test("an @ query reaches deep files past a truncated file index", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-deep-file-search-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  // Hidden Windows windows need offscreen painting to advance animation frames.
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: process.platform === "win32" } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("DEEP_FILE_SEARCH_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.deepFileSearchProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("DEEP_FILE_SEARCH_PROBE "));
    assert.ok(line, output.slice(-6000));
    const result = JSON.parse(line.slice("DEEP_FILE_SEARCH_PROBE ".length));
    assert.equal(result.passed, true);
    assert.deepEqual(result.queries, ["FeatureController", "Feat", "Save", "Missing", "Broken"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
