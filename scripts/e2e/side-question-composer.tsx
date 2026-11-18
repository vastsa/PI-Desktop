import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { TranscriptMenuProvider, useTranscriptMenu } from "../../apps/desktop/src/features/chat/transcript/TranscriptMenu";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { SideQuestionTab } from "../../apps/desktop/src/features/side-questions/SideQuestionTab";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { writeComposerDraft } from "../../apps/desktop/src/lib/composer-draft-cache";
import { attachChatContextChip } from "../../apps/desktop/src/lib/chat-context-chips";
import { sideQuestionReference } from "../../apps/desktop/src/features/side-questions/model";
import type { AgentPromptRequest, SessionDetail } from "@pi-desktop/shared";

declare global { var sideQuestionProbe: () => Promise<{ checks: number; inputHeight: number }> }
const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); };
const frame = () => new Promise(requestAnimationFrame);
async function until(predicate: () => unknown, label: string) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await frame();
  assert(predicate(), label);
}
const element = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const side = (id = "child"): SessionDetail => ({ id, title: "Synthetic side", messageCount: 0,
  mode: "agent", permissionMode: "auto", thinkingLevel: "off", providerId: "fixture", modelId: "model", projectPath: "/synthetic",
  createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z", messages: [],
  sideQuestion: { parentSessionId: "main", parentTitle: "Synthetic main", inheritedMessageCount: 0, anchorLabel: "", archived: false } });

function SourceSelection() {
  const open = useTranscriptMenu();
  return <div data-transcript-session-id="main">
    <p id="selectable-source" style={{ userSelect: "text" }} onContextMenu={event => open(event, { items: [
      { id: "copy", label: "Copy", onSelect: () => {} },
    ] })}>Before. Selected sentence. After.</p>
  </div>;
}

window.sideQuestionProbe = async () => {
  let checks = 0;
  const check = (value: unknown, label: string) => { assert(value, label); checks++; };
  window.piDesktop = { platform: "darwin", on: () => () => {}, invoke: async () => ({ ok: true, data: { run: null } }) } as typeof window.piDesktop;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const mainMessages = [{ id: "main-message", role: "assistant" as const, content: "Private main history", createdAt: "2026-11-17T00:00:00Z" }];
  useAppStore.setState({ activeSessionId: "main", sessions: [{ ...side("main"), sideQuestion: undefined }], messages: mainMessages,
    workspace: { path: "/synthetic", name: "Synthetic" }, activeProjectPath: "/synthetic", defaultProjectPath: "/default",
    runningSessions: { main: true }, isRunning: true, activeWorkPanelTabId: "side-question:child",
    providers: [{ id: "fixture", name: "Synthetic", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", authKind: "none", hasSecret: false,
      enabled: true, models: [{ id: "model", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null }], supportsReasoning: false, supportedThinkingLevels: [] }],
    providerModels: { fixture: [] }, loadProviderModels: async () => {}, restorePendingInteractive: async () => {} });
  api.getSession = async id => ({ session: side(id) });
  api.renameSession = async () => ({ ok: true });
  let configured = "";
  api.configureSession = async (id, config) => { configured = id; return { session: { ...side(id), ...config } }; };
  let stopped = "";
  api.abort = async id => { stopped = id; return { requested: true }; };
  api.getTodos = async sessionId => ({ sessionId, revision: 0, list: { phases: [] } });
  api.backgroundTasksList = async () => ({ tasks: [] });
  api.remoteAgentTasksList = async () => ({ tasks: [] });
  for (const key of ["onSessionTodosChanged", "onHostStatus", "onBackgroundTasksChanged", "onRemoteAgentTasksChanged", "onComposerFileLines", "onPluginChanged", "onApplicationBindingChanged"] as const) {
    api[key] = () => () => {};
  }
  useAppStore.getState().retainSideQuestion(side());
  writeComposerDraft("main", { text: "Keep main draft", fileReferences: [] });
  writeComposerDraft("child", { text: "Explain this", fileReferences: [] });
  const source = "A selected sentence with enough characters to require truncation.\n  Full source stays intact.";
  attachChatContextChip("child", sideQuestionReference(source));
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:1500px;height:700px";
  document.body.append(host);
  const root = createRoot(host);
  const render = (id = "child") => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <div id="main" style={{ position: "relative", width: 750 }}><Composer /></div>
    <div id="side" style={{ display: "flex", width: 750 }}><SideQuestionTab key={id} id={id} parentId="main" /></div>
  </I18nextProvider>));
  try {
    render();
    await until(() => document.querySelector("#side .composer-input"), "Side composer ready");
    await frame();
    const mainInput = element<HTMLDivElement>("#main .composer-input");
    const sideInput = element<HTMLDivElement>("#side .composer-input");
    check(mainInput.textContent === "Keep main draft", "Main draft restored");
    check(sideInput.textContent === "Explain this", "Reference stays outside editor");
    const title = element("#side .side-question-composer .composer-ctx-chip-title").textContent;
    check(title === sideQuestionReference(source).title, "Short reference label");
    for (const selector of [".composer-shell", ".composer-input", ".composer-toolbar"]) {
      const mainStyle = getComputedStyle(element(`#main ${selector}`));
      const sideStyle = getComputedStyle(element(`#side ${selector}`));
      for (const property of ["font-size", "line-height", "padding", "border-radius", "background-color"]) {
        check(mainStyle.getPropertyValue(property) === sideStyle.getPropertyValue(property), `Shared ${selector} ${property}`);
      }
    }
    const mainRect = element("#main .composer-shell").getBoundingClientRect();
    const sideRect = element("#side .composer-shell").getBoundingClientRect();
    check(Math.abs(mainRect.width - sideRect.width) < 1, "Equal pane widths give equal composer widths");
    check(Math.abs(mainRect.bottom - sideRect.bottom) < 1, "Both composers use the same bottom inset");
    check(Math.abs(mainInput.getBoundingClientRect().height - sideInput.getBoundingClientRect().height) < 1, "Same single-line editor height");
    check(useAppStore.getState().isRunning && Boolean(document.querySelector("#main .send-btn")), "Main keeps running with its draft");
    check(Boolean(document.querySelector("#side .send-btn")), "Side independently idle");
    check(element("#side .composer-permission button").textContent?.includes(catalogs.en.chat.permissionAuto), "Inherited Full auto displayed");
    let sent: AgentPromptRequest | undefined;
    let rejectSend: (error: Error) => void = () => {};
    api.promptSideQuestion = request => { sent = request; return new Promise((_resolve, reject) => { rejectSend = reject; }); };
    element("#side .send-btn").click();
    await until(() => sent, "Side submitted");
    check(sent?.sessionId === "child" && sent.viewingSessionId === null, "Child prompt ownership");
    check(sent?.content.includes("Full source stays intact.") && !sent.content.includes("Private main history"), "Complete reference without main history");
    element("#side .side-question-composer .composer-ctx-chip-remove").click();
    sideInput.textContent = "Newer side draft";
    sideInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Newer side draft" }));
    await frame();
    rejectSend(new Error("Synthetic rejected send"));
    await until(() => document.querySelector("#side .send-btn:not([disabled])"), "Rejected send settled");
    check(sideInput.textContent === "Newer side draft", "Failed send preserves newer text");
    check(!document.querySelector("#side .side-question-composer .composer-ctx-chip"), "Deleted reference never resurrects");
    check(mainInput.textContent === "Keep main draft", "Side send preserves main draft");
    attachChatContextChip("child", sideQuestionReference("Submitted reference"), "submitted");
    let finishSend: ((value: { accepted: true }) => void) | undefined;
    api.promptSideQuestion = request => { sent = request; return new Promise(resolve => { finishSend = resolve; }); };
    await frame();
    element("#side .send-btn").click();
    await until(() => finishSend, "Second send pending");
    attachChatContextChip("child", sideQuestionReference("Later reference"), "later");
    await frame();
    finishSend!({ accepted: true });
    await until(() => document.querySelectorAll("#side .side-question-composer .composer-ctx-chip").length === 1, "Only submitted reference consumed");
    check(element("#side .side-question-composer .composer-ctx-chip-title").textContent === "Later reference", "Successful send preserves newly attached reference");
    check(sideInput.textContent === "", "Accepted draft cleared");
    element("#side .side-question-composer .composer-ctx-chip-remove").click();
    await frame();
    useAppStore.setState({ runningSessions: { main: true, child: true } });
    await until(() => document.querySelector("#side .stop-btn"), "Child Stop shown");
    element("#side .stop-btn").click();
    await until(() => stopped, "Child stopped");
    check(stopped === "child" && useAppStore.getState().runningSessions.main, "Stop preserves main turn");
    let finishStaleRead: ((value: { session: SessionDetail }) => void) | undefined;
    api.getSession = () => new Promise(resolve => { finishStaleRead = resolve; });
    useAppStore.setState({ runningSessions: { main: true } });
    await until(() => finishStaleRead, "Idle metadata read started");
    await frame();
    element("#side .composer-permission button").click();
    const ask = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-permission-menu [role="menuitemradio"]'))
      .find(button => button.textContent?.includes(catalogs.en.chat.permissionAsk));
    await until(ask, "Permission menu opened");
    ask()?.click();
    await until(() => configured, "Child permission configured");
    check(configured === "child" && useAppStore.getState().sessions[0].permissionMode === "auto", "Permission changes independent");
    finishStaleRead!({ session: side() });
    await frame(); await frame();
    check(element("#side .composer-permission button").textContent?.includes(catalogs.en.chat.permissionAsk), "Stale metadata cannot reset the new permission");
    api.getSession = async id => ({ session: { ...side(id), permissionMode: "ask" } });
    sideInput.textContent = "Restore this draft";
    sideInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    attachChatContextChip("child", sideQuestionReference(source));
    await frame();
    render("other");
    await until(() => document.querySelector("#side .composer-input"), "Other side opened");
    render();
    await until(() => document.querySelector("#side .composer-input")?.textContent === "Restore this draft", "Side draft survives remount and pruning");
    check(Boolean(document.querySelector("#side .side-question-composer .composer-ctx-chip")), "Reference survives remount");
    check(useAppStore.getState().activeSessionId === "main" && useAppStore.getState().messages === mainMessages, "Main transcript remains active");
    const inputHeight = element("#side .composer-input").getBoundingClientRect().height;
    const children = new Map<string, SessionDetail>();
    const createRequests: Array<{ parent: string; referenceOnly?: boolean }> = [];
    api.createSideQuestion = async (parent, title, options) => {
      createRequests.push({ parent, referenceOnly: options?.referenceOnly });
      const child = { ...side(`created-${createRequests.length}`), title };
      children.set(child.id, child);
      return { session: child };
    };
    api.getSession = async id => ({ session: children.get(id) ?? side(id) });
    api.listSideQuestions = async () => ({ sessions: [...children.values()].reverse(), total: children.size });
    api.deleteSession = async id => { children.delete(id); return { ok: true }; };
    api.promptSideQuestion = async request => { sent = request; return { accepted: true }; };
    const panels = useAppStore.getState();
    useAppStore.setState({ workPanelOpen: true, workPanelWidth: 650, activeWorkPanelTabId: null, workPanelTabs: [], workPanelContexts: {} });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <div id="main" style={{ position: "relative", width: 750 }}>
        <div id="main-reading" style={{ height: 140, overflow: "auto" }}>
          <TranscriptMenuProvider><SourceSelection /></TranscriptMenuProvider>
          <div style={{ minHeight: 480 }} />
        </div>
        <Composer />
      </div>
      <WorkPanel containerWidth={1500} sidebarCollapsed />
    </I18nextProvider>));
    await until(() => document.querySelector(".work-panel-new-tab"), "Work panel ready");
    element(".work-panel-new-tab").click();
    await until(() => useAppStore.getState().workPanelTabs.at(-1)?.kind === "new", "Plus opens launcher");
    check(children.size === 0 && Boolean(document.querySelector('[data-testid="work-panel-empty"]')), "Plus creates a blank launcher only");
    const launch = Array.from(document.querySelectorAll<HTMLElement>(".work-panel-launcher-row"))
      .find(node => node.textContent === catalogs.en.sideQuestions.title);
    check(Boolean(launch), "Side question action is visible in launcher");
    launch?.click();
    await until(() => document.querySelector(".work-panel-main .composer-input"), "Side child opened");
    check(createRequests[0]?.parent === "main" && createRequests[0]?.referenceOnly === false, "Launcher uses parent snapshot");
    element(".work-panel-new-tab").click();
    await until(() => document.querySelector(".side-question-recent .work-panel-launcher-row"), "Recent child in launcher");
    element(".side-question-recent .work-panel-launcher-row").click();
    await until(() => useAppStore.getState().activeWorkPanelTabId === "side-question:created-1", "History reopens existing child");
    check(children.size === 1, "Opening history does not create another child");
    await until(() => document.querySelector(".work-panel-main .composer-input"), "Reopened editor ready");
    await frame();
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    const sourceNode = element("#selectable-source");
    const range = document.createRange();
    range.setStart(sourceNode.firstChild!, "Before. ".length);
    range.setEnd(sourceNode.firstChild!, "Before. Selected sentence.".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    assert(selection.toString() === "Selected sentence.", "Selection fixture owns the highlighted text");
    sourceNode.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 100 }));
    const menuAction = () => document.querySelector<HTMLElement>('[data-context-menu-item="side-question"]');
    try {
      await until(menuAction, "Selection action in transcript menu");
    } catch {
      const state = useAppStore.getState();
      throw new Error(`Selection menu missing (items: ${[...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent).join(", ")}, active: ${state.activeSessionId}, selecting: ${state.selectingSessionId})`);
    }
    menuAction()?.click();
    await until(() => document.querySelector(".work-panel-main .composer-ctx-chip-title"), "Selection renders reference chip");
    check(createRequests[1]?.referenceOnly === true, "Selection requests empty child");
    check(element(".work-panel-main .composer-ctx-chip-title").textContent === sideQuestionReference("Selected sentence.").title, "Selection label abbreviates only highlighted text");
    check(!element(".work-panel-main .composer-input").textContent, "Selected text leaves editor blank");
    const selectedEditor = element(".work-panel-main .composer-input");
    selectedEditor.textContent = "Explain";
    selectedEditor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    selectedEditor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await until(() => sent?.sessionId === "created-2", "Selected reference submitted");
    check(sent?.content.includes("Selected sentence.") && !sent.content.includes("Before.") &&
      !sent.content.includes("After."), "Selected child receives exactly the selected span");
    const mainEditor = element("#main .composer-input");
    mainEditor.textContent = "/btw Isolated follow-up";
    mainEditor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    mainEditor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await until(() => sent?.content === "Isolated follow-up", "/btw question reached child");
    check(sent?.sessionId === "created-3" && createRequests[2]?.referenceOnly === false, "/btw uses the launcher snapshot path");
    await until(() => document.querySelector<HTMLButtonElement>('.work-panel-main button[aria-label="Delete side question"]:not([disabled])'), "Delete control ready");
    element('.work-panel-main button[aria-label="Delete side question"]').click();
    await until(() => document.querySelector("dialog[open]"), "Delete confirmation opened");
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("dialog[open] button"))
      .find(button => button.textContent === catalogs.en.sideQuestions.delete);
    check(Boolean(confirm) && children.has("created-3"), "Delete waits for confirmation");
    confirm?.click();
    await until(() => !children.has("created-3"), "Confirmed deletion reached child");
    check(useAppStore.getState().activeSessionId === "main" && panels.messages === useAppStore.getState().messages, "Panel lifecycle leaves main transcript untouched");
    const reading = element("#main-reading");
    reading.scrollTop = 60;
    const readingPosition = reading.scrollTop;
    assert(readingPosition > 0, "Main reading position is measurable");
    const editorIn = (id: string) => `[aria-labelledby="work-panel-tab-side-question:${id}"] .composer-input`;
    const activate = async (id: string) => {
      element(`[data-work-panel-tab-id="side-question:${id}"] [role="tab"]`).click();
      await until(() => document.querySelector(editorIn(id)), `Side tab ${id} ready`);
      await frame();
    };
    const typeSide = (id: string, text: string) => {
      const editor = element(editorIn(id));
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return editor;
    };
    const running = (id: string, active: boolean) => useAppStore.setState(state => ({
      runningSessions: { ...state.runningSessions, [id]: active },
    }));
    api.promptSideQuestion = async request => {
      running(request.sessionId, true);
      return { accepted: true };
    };
    api.abort = async id => { stopped = id; running(id, false); return { requested: true }; };
    const start = async (id: string, prompt: string) => {
      await activate(id);
      typeSide(id, prompt).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await until(() => useAppStore.getState().runningSessions[id], `${id} started`);
    };
    await start("created-1", "A is running");
    await start("created-2", "B is running");
    check(Boolean(useAppStore.getState().runningSessions["created-1"]), "Both sibling branches run independently");
    typeSide("created-2", "Keep this next question for B");
    await frame();
    await activate("created-1");
    await until(() => document.querySelector(".work-panel-main .stop-btn"), "A has its own Stop button");
    element(".work-panel-main .stop-btn").click();
    await until(() => stopped === "created-1" && !useAppStore.getState().runningSessions["created-1"], "A stopped");
    await activate("created-2");
    check(element(editorIn("created-2")).textContent === "Keep this next question for B", "B draft survived switching and stopping A");
    check(Boolean(useAppStore.getState().runningSessions["created-2"]), "A stop leaves B running");
    check(reading.scrollTop === readingPosition && useAppStore.getState().runningSessions.main, "Main keeps its reading position and turn");
    return { checks, inputHeight };
  } finally { flushSync(() => root.unmount()); host.remove(); }
};
