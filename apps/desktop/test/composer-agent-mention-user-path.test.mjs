/**
 * ADR 0346: `@agent` in the composer. Drives the real draft, completions,
 * input and menu against a stubbed delegation catalog and file index, then
 * checks the accepted chip serializes to a token the send-time resolver reads.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { findAgentMentions, serializeComposerFileReferences } from "@pi-desktop/shared";
import { useComposerDraft } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import { setEditorCaret } from "../../apps/desktop/src/features/chat/composer/editor";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

let catalogReads = 0;
api.fsIndex = async () => ({ entries: [{ path: "README.md", kind: "file" }, { path: "fixer", kind: "file" }], truncated: false });
api.subagentCatalog = async () => {
  catalogReads += 1;
  return {
    subagents: [
      { name: "explorer", description: "Fast codebase search" },
      { name: "fixer", description: "Implements a change" },
    ],
    builtins: [], diagnostics: [], projectPath: "/repo",
  };
};

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
useAppStore.setState({ activeSessionId: "s1", workspace: { path: "/repo", name: "repo" } });

const noop = () => {};
let draft;
function Fixture({ agentsEnabled }) {
  draft = useComposerDraft({
    variant: "docked", activeSessionId: "s1", workspacePath: "/repo",
    sessions: [{ id: "s1" }], composerPrefill: null, clearComposerPrefill: noop,
    t: (key) => key, invalidateComposerTransforms: noop, inputBlocked: false,
  });
  const completions = useComposerCompletions({
    value: draft.value, cursor: draft.cursor, composing: draft.composing, enabled: true,
    agentsEnabled,
    referenceSessionId: "s1", fileReferencesRef: draft.fileReferencesRef,
    applyEditorDraft: draft.applyEditorDraft, handleInput: draft.handleInput,
    invalidateComposerTransforms: noop,
  });
  return <>
    <ComposerInput inputRef={draft.ref} value={draft.value} placeholderText="" placeholderKey="fixture"
      inputBlocked={false} pasting={false} enterToSend={false} runActive={false}
      composerAc={completions.ac} onPaste={noop} onAcceptCompletion={completions.acceptCompletion}
      onSubmit={noop} onInsertNewline={noop} onHistoryNavigate={() => false}
      onInput={(source, caret, composing) => completions.handleInput(source, caret, composing)}
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
const options = () => [...document.querySelectorAll('[role="option"]')].map((row) => row.getAttribute("aria-label"));
const headings = () => [...document.querySelectorAll(".composer-model-group-label")].map((row) => row.textContent);
function check(condition, message) {
  if (!condition) throw new Error(message + " options=" + JSON.stringify(options()) + " headings=" + JSON.stringify(headings()));
}
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

window.agentMentionProbe = async () => {
  // Plan / Goal: no Agents group, the file menu is unchanged.
  flushSync(() => rootNode.render(<Fixture agentsEnabled={false} />));
  await settle();
  editor().focus();
  await type("@");
  await until(() => options().includes("README.md"), "the @ menu did not open");
  check(!options().includes("@explorer"), "Plan mode must not offer agents");
  check(headings().length === 0, "a plain file list carries no headings");
  check(catalogReads === 0, "Plan mode must not read the delegation catalog");

  // Agent mode: an Agents group above the files; a root file shadows its agent.
  flushSync(() => rootNode.render(<Fixture agentsEnabled />));
  await type("");
  await type("@");
  await until(() => options().includes("@explorer"), "Agent mode did not offer the explorer");
  check(JSON.stringify(headings()) === JSON.stringify(["Agents", "Files"]), "Agents and Files headings");
  check(!options().includes("@fixer"), "a root file named fixer must hide that agent");
  check(options().indexOf("@explorer") < options().indexOf("README.md"), "agents list above files");

  // Mid-sentence accept → one atomic chip that serializes to a resolvable token.
  await type("look @expl");
  await until(() => options()[0] === "@explorer", "the query did not rank the explorer first");
  editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  const chips = [...editor().querySelectorAll(".composer-chip[data-agent]")];
  check(chips.length === 1 && chips[0].dataset.agent === "explorer", "accepting did not place one agent chip");
  check(chips[0].textContent.includes("explorer"), "the chip must show the agent name");
  const references = draft.fileReferencesRef.current;
  check(references.length === 1 && references[0].kind === "agent", "the chip must be an agent reference");
  const text = draft.value + "where the retry policy lives";
  const serialized = serializeComposerFileReferences(text, references);
  check(findAgentMentions(serialized, new Set(["explorer"])).length === 1, "the serialized prompt lost the mention");

  flushSync(() => rootNode.unmount());
  return { passed: true, serialized };
};
`;

test("the @ menu offers subagents in Agent mode and accepts one as an atomic chip", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-agent-mention-ui-"));
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
    console.log("AGENT_MENTION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.agentMentionProbe()")));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("AGENT_MENTION_PROBE "));
    assert.ok(line, output.slice(-6000));
    const result = JSON.parse(line.slice("AGENT_MENTION_PROBE ".length));
    assert.equal(result.passed, true);
    assert.equal(result.serialized, "look @explorer where the retry policy lives");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
