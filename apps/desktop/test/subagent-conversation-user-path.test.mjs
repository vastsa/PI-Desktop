import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const fixture = `
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { en } from "@pi-desktop/i18n/locales/en";
import { ConversationSettings } from "./features/settings/pages/ConversationSettings";
import { AssistantTurn } from "./features/chat/transcript/AssistantTurn";
import { TranscriptDisclosureProvider } from "./features/chat/transcript/disclosure";
import { SubagentTranscriptTab } from "./components/workpanel/SubagentTranscriptTab";
import { SlotSessionProvider } from "./plugins/renderer-slots/use-slots";
import { buildTranscriptEntries } from "./lib/assistant-turns";
import { useAppStore } from "./stores/app-store";
import "./styles/globals.css";

const sessionId = "fixture";
const message = (id, role, content, extra = {}) => ({
  id, role, content, createdAt: "2026-11-24T00:00:00.000Z", ...extra,
});
const tool = (id, toolName, content, extra = {}) => message(id, "tool", content, {
  toolName, toolCallId: id, toolStatus: "success", ...extra,
});
const task = (id, delegationId, description, status, modelId, resume) => tool(id, "Task", "", {
  toolArgs: { agent: "explorer", task: description, resume },
  toolResult: { details: { delegationId, status, modelId, thinkingLevel: "medium" } },
});
const first = task("task-first", "delegate-first", "Initial inspection", "completed", "earlier-model");
const latest = task("task-latest", "delegate-latest", "Follow-up inspection", "running", "latest-model", "delegate-first");
const child = { parentToolCallId: "task-first" };
const messages = [
  message("user", "user", "Inspect the project"),
  tool("main-read", "Read", "main read result"),
  tool("main-run", "Bash", "main output", { toolArgs: { command: "echo main" } }),
  first,
  message("thinking", "assistant", "", { ...child, thinking: "Delegate reasoning" }),
  tool("read", "Read", "delegate search needle", { ...child, toolResult: { content: [{ type: "text", text: "delegate search needle" }] } }),
  tool("run", "Bash", "delegate output", { ...child, toolArgs: { command: "echo delegate" } }),
  message("answer", "assistant", "Delegate final answer.", child),
  latest,
  task("task-other", "delegate-other", "Other delegate", "running", "other-model"),
  message("main-answer", "assistant", "Main answer."),
];
const entry = buildTranscriptEntries(messages).entries.find((item) => item.kind === "assistant-turn");
const requests = [];
const session = { id: sessionId, title: "Fixture", messages, navigationParent: first };
window.piDesktop = { invoke: async (channel, args) => {
  if (channel === IPC.invoke.sessionGet) return { ok: true, data: { session } };
  requests.push({ channel, args });
  return { ok: true, data: { pending: args.delegationIds } };
} };
const settings = { transcriptDisplayMode: "fully-folded", showThinking: true,
  autoCollapseSettledGroups: true, autoCollapseThinking: true };
useAppStore.setState({ activeSessionId: sessionId, retainedSessionIds: [sessionId],
  sessions: [session], settings, messages, runningSessions: { [sessionId]: true } });

function Harness() {
  const settings = useAppStore((state) => state.settings);
  const tabs = useAppStore((state) => state.workPanelTabs);
  const active = useAppStore((state) => state.activeWorkPanelTabId);
  const tab = tabs.find((item) => item.id === active);
  return <>
    <section id="settings"><ConversationSettings settings={settings} saveSettings={async (patch) => {
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, ...patch } });
    }} /></section>
    <section id="main"><SlotSessionProvider sessionId={sessionId}>
      <TranscriptDisclosureProvider sessionId={sessionId}>
        <AssistantTurn entry={entry} isActive={false} delegationsLive />
      </TranscriptDisclosureProvider>
    </SlotSessionProvider></section>
    <aside id="panel" style={{ width: 340, height: 370, display: "flex" }}>
      {tab?.kind === "subagent" ? <SubagentTranscriptTab delegationId={tab.resource} /> : null}
    </aside>
  </>;
}

window.probe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  flushSync(() => createRoot(document.getElementById("root")).render(
    <I18nextProvider i18n={i18n}><Harness /></I18nextProvider>,
  ));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const q = (selector) => document.querySelector(selector);
  const click = (item) => { check(item, "Missing click target"); flushSync(() => item.click()); };
  const radio = (label) => [...document.querySelectorAll('[role="radio"]')].find((item) => item.textContent.trim() === label);
  const toggle = (label) => q('[role="switch"][aria-label="' + label + '"]');
  const process = () => q("#panel .turn-process > button");
  const group = () => q("#panel .process-activity-group.grouped > button");
  const reasoning = () => q("#panel .thinking > button");
  const open = (item) => item?.getAttribute("aria-expanded") === "true";
  const unfold = (item) => { if (!open(item)) click(item); };
  const visible = (selector) => Boolean(q(selector) && !q(selector).closest("[hidden]"));
  const until = async (condition, message) => {
    const deadline = performance.now() + 3000;
    while (!condition()) {
      check(performance.now() < deadline, message);
      await new Promise(requestAnimationFrame);
    }
  };
  unfold(q("#main .turn-process > button"));
  const node = (id) => q('#main [data-message-id="' + id + '"] .subagent-topology-node-header');
  click(node("task-first"));
  check(q("#panel").textContent.includes("Initial inspection") && q("#panel").textContent.includes("Follow-up inspection"), "resume chain did not open as two prompts");
  check(!open(process()) && visible('#panel [data-message-id="answer"]'), "settled process must be closed while the answer stays visible");
  unfold(process());
  check(!open(group()), "settled group must default to folded");
  click(toggle("Fold finished groups"));
  check(open(group()), "disabling automatic group folding did not open a settled group");
  click(toggle("Fold finished thinking"));
  check(open(reasoning()), "disabling automatic thinking folding did not open settled reasoning");
  click(toggle("Fold finished thinking"));
  click(toggle("Fold finished groups"));
  check(!open(group()), "re-enabling automatic group folding did not close the group");
  unfold(group());
  check(!open(reasoning()), "settled reasoning must default to folded");
  unfold(reasoning());
  click(process());
  check(!visible("#panel .thinking-prose"), "folded process did not hide nested details");
  unfold(process());
  check(open(group()) && visible("#panel .thinking-prose"), "reopening process did not restore nested choices");
  click(node("task-other"));
  check(!q('#panel [data-message-id="answer"]'), "parallel delegate inherited another delegate’s answer");
  click(node("task-first"));
  check(open(process()) && open(group()), "returning to the tab lost its manual choices");

  click(radio("Flat"));
  check(!q("#main .process-activity-group.grouped") && !group() && process(), "Flat did not remove inner groups from both transcripts");
  click(radio("Commands first"));
  check(q("#main .turn-run-row") && q("#panel .turn-run-row"), "Commands first did not lift commands in both transcripts");
  click(radio("Fully folded"));
  check(!q("#main .turn-run-row") && !q("#panel .turn-run-row") && group(), "Fully folded did not group commands in both transcripts");
  click(toggle("Show thinking"));
  check(!reasoning(), "Show thinking did not hide completed reasoning");
  click(toggle("Show thinking"));
  check(reasoning(), "re-enabling thinking did not restore the row");
  if (open(group())) click(group());
  if (open(process())) click(process());
  await useAppStore.getState().navigateTranscript({ sessionId, messageId: "read", query: "search needle" });
  await until(() => open(process()), "search did not open the process");
  check(open(group()), "search did not open the activity group");
  const readButton = q('#panel [data-message-id="read"] .tool-row-header');
  check(open(readButton) && !readButton.disabled, "search did not open the tool result");
  check(q("#panel .transcript-search-target"), "search did not claim the delegate hit");

  const footer = q("#panel footer");
  check(footer.querySelector(".composer-shell") && footer.textContent.includes("input is unavailable"), "read-only composer shell or hint missing");
  check(footer.textContent.includes("latest-model") && footer.textContent.includes("medium") && !footer.textContent.includes("earlier-model"), "metadata was not read from the latest Task");
  check(!footer.querySelector("textarea,input,[contenteditable],[aria-haspopup],.send-btn") && footer.querySelectorAll("button").length === 1,
    "footer exposed an editor, picker, or extra action");
  click(footer.querySelector(".stop-btn"));
  check(JSON.stringify(requests) === JSON.stringify([{ channel: IPC.invoke.agentStopSubagents,
    args: { sessionId, delegationIds: ["delegate-latest"] } }]), "stop was not scoped to the latest delegate");
};
`;

const entry = `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  await window.loadFile(join(__dirname, "index.html"));
  await window.webContents.executeJavaScript("window.probe()");
  console.log("PASS subagent conversation");
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
`;

test("open a delegation and use the shared conversation display with a read-only composer", {
  skip: process.platform === "linux" && !process.env.DISPLAY,
}, async () => {
  const root = repositoryRoot();
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-subagent-conversation-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "apps/desktop/src"), loader: "tsx" },
      bundle: true, jsx: "automatic", format: "esm", outfile: join(temp, "fixture.js"),
      conditions: ["style"],
      loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html>
      <meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:">
      <link rel="stylesheet" href="fixture.css">
      <div id="root"></div><script type="module" src="fixture.js"></script>`);
    await writeFile(join(temp, "main.cjs"), entry);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, timeout: 30000 });
    assert.match(stdout, /PASS subagent conversation/);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
