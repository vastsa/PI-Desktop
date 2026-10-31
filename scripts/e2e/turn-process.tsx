import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ShowThinkingRow } from "../../apps/desktop/src/components/settings/ShowThinkingRow";
import { TranscriptDisplayModeRow } from "../../apps/desktop/src/components/settings/TranscriptDisplayModeRow";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptSearchContext } from "../../apps/desktop/src/lib/transcript-search-context";
import type { TranscriptSearchTarget } from "../../apps/desktop/src/lib/transcript-reading";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role,
  content,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...extra,
});

const tool = (
  id: string,
  toolName: string,
  extra: Partial<UiMessage> = {},
): UiMessage =>
  message(id, "tool", "", {
    toolName,
    toolCallId: `call-${id}`,
    toolStatus: "success",
    ...extra,
  });

const run = (id: string, command: string): UiMessage =>
  tool(id, "Bash", {
    toolArgs: { command },
    toolResult: { details: { stdout: "ok", exitCode: 0 } },
  });

/** Real mounted React components: disclosure ownership, preference and search. */
export async function turnProcessProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  // Keep the collapse rail's gutter inside the viewport, like the real
  // .thread-content padding does, so hit testing can address it.
  container.style.cssText =
    "width: 800px; max-width: 100%; padding-left: 32px; box-sizing: border-box;";
  document.body.append(container);
  const initialSettings = useAppStore.getState().settings;
  const baseSettings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    transcriptDisplayMode: "command-first",
  };
  const setSettings = (patch: Partial<AppSettings> = {}) =>
    flushSync(() => useAppStore.setState({ settings: { ...baseSettings, ...patch } }));
  setSettings();
  const errors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
  });
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const check = (value: unknown, name: string) => {
    assert(value, name);
    notes.push(name);
  };
  const render = (
    messages: UiMessage[],
    active = false,
    search: TranscriptSearchTarget | null = null,
    key = "turn",
  ) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    assert(entry?.kind === "assistant-turn", "missing turn");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptSearchContext.Provider value={search}>
            <AssistantTurn key={key} entry={entry} isActive={active} />
          </TranscriptSearchContext.Provider>
        </I18nextProvider>,
      ),
    );
    assert(!errors.length, `React error: ${errors.map(String).join("; ")}`);
  };
  const processHeaders = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".turn-process > button")];
  const firstProcess = () => container.querySelector<HTMLElement>(".turn-process-body");
  const visible = (element: Element | null) =>
    Boolean(element?.getBoundingClientRect().height);
  const leftOf = (element: Element | null) =>
    element?.getBoundingClientRect().left;
  const nearLeft = (left: number | undefined, right: number | undefined) =>
    typeof left === "number" && typeof right === "number" &&
    Math.abs(left - right) < 0.75;
  const pointIn = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + Math.min(6, rect.width / 2),
      rect.top + rect.height / 2,
    );
  };
  const owns = (header: Element | null, target: Element | null) =>
    Boolean(header && target && header.contains(target));
  const railHit = (rail: Element | null) => {
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  };
  const rectOf = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      top: rect.top,
      bottom: rect.bottom,
    };
  };
  const fontSize = (element: Element | null) =>
    element ? Number.parseFloat(getComputedStyle(element).fontSize) : NaN;
  const color = (element: Element | null) =>
    element ? getComputedStyle(element).color : "";
  const click = (element: HTMLElement | null) => {
    assert(element, "missing click target");
    flushSync(() => element.click());
  };
  const row = (id: string) =>
    container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const allCollapsed = () =>
    [...container.querySelectorAll<HTMLElement>("[aria-expanded]")].every(
      (element) => element.getAttribute("aria-expanded") === "false",
    );

  const intro = message("intro", "assistant", "Inspecting the files", {
    thinking: "reasoning detail",
    status: "complete",
  });
  const read = tool("read", "Read", {
    toolResult: "read output",
    toolArgs: { path: "src/example.ts" },
  });
  const grep = tool("grep", "Grep", {
    toolResult: "grep output",
    toolArgs: { query: "todo" },
  });
  const bash1 = run("bash1", "pnpm test");
  const bash2 = run("bash2", "pnpm build");
  const edit = tool("edit", "Edit", {
    toolResult: "edit output",
    toolArgs: { path: "src/example.ts" },
  });
  const answer = message("answer", "assistant", "The fix is ready.", {
    status: "complete",
    createdAt: "2026-09-17T00:00:03.000Z",
    responseDurationMs: 1000,
  });
  const mixed = [intro, read, grep, bash1, bash2, edit, answer];
  // No progress paragraph between these rows: the folded group must be one
  // contiguous ordinary stretch around both run rows.
  const contiguous = [read, grep, bash1, bash2, edit, answer];

  try {
    // One disclosure per turn: the Bash rows are rows inside the turn's process,
    // not siblings of it, so a long turn collapses in one gesture.
    render(mixed, true, null, "settling-activity-group");
    const bash1Row = row("bash1");
    const bash2Row = row("bash2");
    check(Boolean(bash1Row) && Boolean(bash2Row), "both adjacent Bash rows render");
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "a turn renders exactly one process disclosure",
    );
    check(
      bash1Row?.closest(".turn-process") !== null &&
        bash2Row?.closest(".turn-process") !== null,
      "every Bash row lives inside that one disclosure",
    );
    check(
      bash1Row?.closest(".turn-run-row") !== null &&
        bash1Row?.closest(".turn-run-row") !== bash2Row?.closest(".turn-run-row"),
      "adjacent Bash rows each render standalone",
    );
    check(
      bash1Row?.closest(".process-activity-group") === null &&
        bash1Row?.closest(".tool-activity-group") === null,
      "Bash rows are not folded into an activity group",
    );
    check(
      processHeaders()[0]?.querySelector(".tool-activity-count")?.textContent ===
        i18n.t("chat.processTools", { count: 5 }),
      "the process header counts every tool once",
    );
    const activeGroupHeader = row("read")?.closest<HTMLElement>(
      ".process-activity-group.grouped",
    )?.querySelector<HTMLElement>(".tool-activity-header");
    check(
      activeGroupHeader?.getAttribute("aria-expanded") === "true",
      "the active small activity group starts open",
    );
    render(mixed, false, null, "settling-activity-group");
    const completedGroupHeader = row("read")?.closest<HTMLElement>(
      ".process-activity-group.grouped",
    )?.querySelector<HTMLElement>(".tool-activity-header");
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "false" &&
        [...container.querySelectorAll<HTMLElement>(".tool-row:not(.thinking) .tool-row-header")].every(
          (header) => header.getAttribute("aria-expanded") === "false",
        ),
      "the completed process and tool payload rows start closed",
    );
    check(
      !visible(bash1Row) && !visible(bash2Row),
      "Bash rows are revealed by the turn's process, not left outside it",
    );
    check(
      !visible(row("read")) && !visible(row("grep")),
      "non-run work stays inside its collapsed process",
    );
    // Opening the one top-level disclosure reveals the whole run: the groups and
    // the standalone Bash rows alike.
    click(processHeaders()[0] ?? null);
    check(
      visible(bash1Row) && visible(bash2Row),
      "opening the process reveals the Bash rows",
    );
    check(
      visible(row("read")) && completedGroupHeader?.getAttribute("aria-expanded") === "true",
      "opening the process reveals the already-open activity group with its tool rows",
    );

    // Real geometry and hit testing: the turn title, a nested group title and a
    // Bash row share one left edge, and the collapse rail owns its gutter.
    const topHeader = processHeaders()[0] ?? null;
    const nestedHeader = container.querySelector<HTMLElement>(
      ".process-activity-group.grouped > .tool-activity-header",
    );
    const bashHeader = bash1Row?.querySelector<HTMLElement>(".tool-row-header") ?? null;
    const bashHead = bash1Row?.querySelector<HTMLElement>(".tool-row-head.is-run") ?? null;
    const topIcon = topHeader?.querySelector(".tool-activity-icon") ?? null;
    const nestedIcon = nestedHeader?.querySelector(".tool-activity-icon") ?? null;
    const bashIcon = bashHeader?.querySelector(".tool-row-icon") ?? null;
    const topLabel = topHeader?.querySelector(".tool-activity-label") ?? null;
    const nestedLabel = nestedHeader?.querySelector(".tool-activity-label") ?? null;
    const bashLabel = bashHeader?.querySelector(".tool-row-name") ?? null;
    check(
      nearLeft(leftOf(topIcon), leftOf(nestedIcon)) &&
        nearLeft(leftOf(nestedIcon), leftOf(bashIcon)),
      "turn, group and run icons share one left edge",
    );
    check(
      nearLeft(leftOf(topLabel), leftOf(nestedLabel)) &&
        nearLeft(leftOf(nestedLabel), leftOf(bashLabel)),
      "turn, group and run titles share one text line",
    );
    const topProcess = topHeader?.parentElement ?? null;
    check(
      topHeader !== null &&
        topProcess !== null &&
        Math.abs(
          topHeader.getBoundingClientRect().width -
            topProcess.getBoundingClientRect().width,
        ) < 1,
      "the turn header hairline spans the transcript band",
    );
    check(
      nearLeft(leftOf(topHeader), leftOf(topIcon)) &&
        nearLeft(leftOf(nestedHeader), leftOf(bashHead)),
      "the turn row starts at the prose edge and nested fills share their gutter",
    );
    check(
      owns(topHeader, pointIn(topIcon)) &&
        owns(nestedHeader, pointIn(nestedIcon)) &&
        owns(bashHeader, pointIn(bashIcon)),
      "each disclosure header owns its content hit target",
    );
    check(
      fontSize(topLabel) > fontSize(nestedLabel) &&
        fontSize(nestedLabel) === fontSize(bashLabel),
      "the nested group title is smaller than the turn title and matches run-row type",
    );
    check(
      color(topLabel) !== color(nestedLabel) &&
        color(nestedLabel) !== color(bashLabel),
      "the nested group title uses a quieter colour than the turn and run rows",
    );
    const topRail = firstProcess()?.querySelector<HTMLElement>(
      ":scope > .disclosure-collapse-rail",
    ) ?? null;
    check(
      topRail !== null && railHit(topRail) === topRail,
      "the turn collapse rail owns its gutter hit target",
    );
    if (nestedHeader?.getAttribute("aria-expanded") !== "true") {
      click(nestedHeader);
    }
    const nestedBody = nestedHeader?.parentElement?.querySelector<HTMLElement>(
      ":scope > .process-activity-body",
    ) ?? null;
    const nestedRail = nestedBody?.querySelector<HTMLElement>(
      ":scope > .disclosure-collapse-rail",
    ) ?? null;
    check(
      nestedRail !== null && railHit(nestedRail) === nestedRail,
      "the nested group collapse rail owns its gutter hit target",
    );
    metrics.desktop = {
      icons: [leftOf(topIcon), leftOf(nestedIcon), leftOf(bashIcon)],
      labels: [leftOf(topLabel), leftOf(nestedLabel), leftOf(bashLabel)],
      headers: [leftOf(topHeader), leftOf(nestedHeader), leftOf(bashHead)],
      turnRail: rectOf(topRail),
      groupRail: rectOf(nestedRail),
    };
    container.style.width = "420px";
    check(
      nearLeft(leftOf(topIcon), leftOf(nestedIcon)) &&
        nearLeft(leftOf(nestedIcon), leftOf(bashIcon)),
      "the shared left edge survives a narrow transcript",
    );
    check(
      topRail !== null && railHit(topRail) === topRail &&
        nestedRail !== null && railHit(nestedRail) === nestedRail,
      "both collapse rails stay usable in a narrow transcript",
    );
    metrics.narrow = {
      icons: [leftOf(topIcon), leftOf(nestedIcon), leftOf(bashIcon)],
      turnRail: rectOf(topRail),
      groupRail: rectOf(nestedRail),
    };
    container.style.width = "800px";

    check(
      bash1Row?.classList.contains("open") !== true,
      "a Bash row keeps its detail closed until opened",
    );
    click(bash1Row?.querySelector<HTMLElement>(".tool-row-header") ?? null);
    check(
      bash1Row?.classList.contains("open") === true,
      "a Bash row opens its own detail on request",
    );

    // A turn of only Bash calls still has its single process disclosure: the run
    // rows are what it reveals.
    render([run("only1", "echo 1"), run("only2", "echo 2")], false, null, "only-bash");
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "a Bash-only turn keeps its one process disclosure",
    );
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "false",
      "a completed Bash-only process starts collapsed",
    );
    check(
      processHeaders()[0]?.querySelector(".tool-activity-count")?.textContent ===
        i18n.t("chat.processTools", { count: 2 }),
      "a Bash-only header counts its commands once",
    );
    click(processHeaders()[0] ?? null);
    check(
      visible(row("only1")) && visible(row("only2")),
      "opening it reveals both Bash rows",
    );

    // Progress text without a tool still owns the turn's one process.
    const progressOnly = [
      message("progress-only", "assistant", "Inspecting the workspace", {
        status: "streaming",
      }),
      message("progress-final", "assistant", "Done", { status: "complete" }),
    ];
    render(progressOnly, false, null, "progress-only");
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "a progress-only process keeps its one disclosure",
    );
    click(processHeaders()[0] ?? null);
    check(
      visible(row("progress-only")),
      "opening the progress-only disclosure reveals its text",
    );

    // Active process content opens while the turn runs and closes when it stops.
    const activeTurn = [intro, read, grep];
    render(activeTurn, true, null, "active");
    check(
      firstProcess() !== null &&
        processHeaders()[0]?.getAttribute("aria-expanded") === "true" &&
        visible(firstProcess()),
      "the active process chunk starts open",
    );
    render(activeTurn, false, null, "active");
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "false" &&
        !visible(firstProcess()),
      "an untouched process chunk collapses on completion",
    );

    // A streaming thinking chunk superseded by a later Bash row must not keep a
    // false Thinking header: the real tail is the Bash row.
    const supersededThought = message("thought-before-bash", "assistant", "", {
      thinking: "Reasoning before a command",
      status: "streaming",
    });
    const bashLive = run("bash-live", "pnpm test");
    const thinkingLabel = i18n.t("chat.thinking");
    render([supersededThought, bashLive], true, null, "thinking-to-bash");
    check(
      row("bash-live")?.closest(".turn-run-row") !== null &&
        row("bash-live")?.closest(".process-activity-group") === null,
      "a Bash row that supersedes thinking renders as a standalone run row",
    );
    check(
      !processHeaders().some((header) =>
        header
          .querySelector(".tool-activity-label")
          ?.textContent?.startsWith(thinkingLabel),
      ),
      "a superseded thinking chunk does not keep a Thinking header",
    );
    setSettings({ showThinking: false });
    render([supersededThought, bashLive], true, null, "thinking-to-bash-hidden");
    check(
      container.querySelectorAll(".turn-process").length === 1 &&
        visible(row("bash-live")),
      "hidden superseded thinking leaves the run row in the live process",
    );
    setSettings();

    // A separate streamed answer supersedes the thinking chunk the same way.
    const supersededThought2 = message("thought-before-answer", "assistant", "", {
      thinking: "Reasoning before an answer",
      status: "streaming",
    });
    const separateAnswer = message("stream-answer", "assistant", "Answer text", {
      status: "streaming",
    });
    render([supersededThought2, separateAnswer], true, null, "thinking-to-answer");
    check(
      Boolean(row("stream-answer")) &&
        row("stream-answer")?.closest(".turn-process") === null,
      "a separate streamed answer stays outside the process",
    );
    check(
      !processHeaders().some((header) =>
        header
          .querySelector(".tool-activity-label")
          ?.textContent?.startsWith(thinkingLabel),
      ),
      "a separate streamed answer clears the Thinking header",
    );
    setSettings({ showThinking: false });
    render([supersededThought2, separateAnswer], true, null, "thinking-to-answer-hidden");
    // The live reasoning indicator is still a visible step of the turn's one
    // disclosure (that is what keeps the indicator), so the disclosure stays.
    // What must not happen is the answer being swallowed or hidden reasoning
    // leaving a row behind.
    check(
      container.querySelectorAll(".turn-process").length <= 1 &&
        !container.querySelector(".thinking") &&
        Boolean(row("stream-answer")),
      "hidden thinking superseded by a separate answer stays out of the answer row",
    );
    setSettings();

    // Show thinking off: the live indicator stays, completed reasoning leaves
    // nothing behind, and stored reasoning is never deleted.
    const liveThought = message("live-thought", "assistant", "", {
      thinking: "Reasoning before the answer",
      status: "streaming",
    });
    setSettings({ showThinking: false });
    render([liveThought], true, null, "thought-off-live");
    const liveHeader = processHeaders()[0];
    // A live turn whose only row is reasoning still says so, even with completed
    // reasoning hidden: the header answers "what is happening", and hiding the
    // finished rows must not hide that the model is thinking right now.
    const liveLabel = () =>
      liveHeader?.querySelector(".tool-activity-label")?.textContent ?? "";
    check(
      liveLabel() === i18n.t("chat.thinking"),
      "show thinking off keeps the live thinking indicator in the header",
    );
    check(
      Boolean(container.querySelector(".thinking-compact")),
      "show thinking off shows the live thinking row",
    );
    click(liveHeader);
    check(
      allCollapsed() && liveLabel() === i18n.t("chat.thinking"),
      "the live thinking indicator stays visible with the process closed",
    );
    render([{ ...liveThought, status: "complete" }], false, null, "thought-off-done");
    check(
      !container.querySelector(".turn-process") && !container.querySelector(".thinking"),
      "completed hidden thinking leaves no empty container",
    );
    check(
      liveThought.thinking === "Reasoning before the answer",
      "hiding thinking never deletes stored reasoning",
    );
    // A streaming reasoning row that already has assistant content is hidden
    // like any completed reasoning row. It must not leave an empty disclosure
    // behind, and the answer must stay visible.
    const hiddenStreamingContent = message(
      "hidden-streaming-content",
      "assistant",
      "Visible answer",
      { thinking: "Reasoning with content", status: "streaming" },
    );
    render([hiddenStreamingContent], true, null, "hidden-streaming-content");
    check(
      !container.querySelector(".turn-process") &&
        !container.querySelector(".thinking") &&
        visible(row("hidden-streaming-content")),
      "hidden streaming reasoning with content leaves no empty process shell",
    );
    setSettings({ showThinking: true });
    render([{ ...liveThought, status: "complete" }], false, null, "thought-on-done");
    check(
      Boolean(container.querySelector(".tool-row.thinking")),
      "turning show thinking back on restores the completed reasoning row",
    );
    click(processHeaders()[0] ?? null);
    const restoredThinking = container.querySelector<HTMLElement>(
      ".tool-row.thinking .tool-row-header",
    );
    if (restoredThinking?.getAttribute("aria-expanded") !== "true") {
      click(restoredThinking);
    }
    check(
      container.textContent?.includes("Reasoning before the answer"),
      "the restored row shows the retained reasoning text when opened",
    );

    // Search reveal opens the process chunk that owns the named message.
    setSettings();
    render(
      mixed,
      false,
      { sessionId: "s", messageId: "read", query: "read", requestId: 1 },
      "search",
    );
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "true" &&
        visible(firstProcess()),
      "search reveals the process chunk that owns the target",
    );

    // Command folding is read at render time: toggling it on the mounted turn
    // must regroup the rows without remounting the transcript.
    setSettings();
    render(contiguous, false, null, "command-folding-toggle");
    click(processHeaders()[0] ?? null);
    check(
      visible(row("bash1")) &&
        container.querySelectorAll(".turn-run-row").length === 2,
      "the mounted turn starts with standalone command rows",
    );
    setSettings({ transcriptDisplayMode: "fully-folded" });
    check(
      container.querySelectorAll(".turn-process").length === 1 &&
        container.querySelectorAll(".turn-run-row").length === 0,
      "toggling command folding keeps one process and removes standalone rows",
    );
    const foldedBash1 = row("bash1");
    const foldedBash2 = row("bash2");
    const foldedGroup = foldedBash1?.closest(".process-activity-group.grouped");
    check(
      foldedGroup !== null &&
        foldedGroup === foldedBash2?.closest(".process-activity-group.grouped"),
      "folded commands share one grouped activity ancestor",
    );
    check(
      foldedGroup?.contains(row("read") ?? null) === true &&
        foldedGroup?.contains(row("edit") ?? null) === true,
      "the shared group contains the surrounding tools",
    );
    check(
      foldedGroup?.querySelector(".tool-activity-header") !== null,
      "the shared group keeps its group header",
    );
    check(
      processHeaders()[0]?.querySelector(".tool-activity-count")?.textContent ===
        i18n.t("chat.processTools", { count: 5 }),
      "folding commands does not change the header tool count",
    );
    setSettings();
    check(
      container.querySelectorAll(".turn-run-row").length === 2 &&
        row("bash1")?.closest(".process-activity-group") === null,
      "toggling command folding back restores standalone rows without a remount",
    );

    // Flat keeps the outer process but suppresses nested activity groups and
    // standalone run wrappers.
    setSettings({ transcriptDisplayMode: "flat" });
    render(contiguous, false, null, "flat-mode");
    check(
      container.querySelector(".turn-process") !== null &&
        container.querySelectorAll(".process-activity-group").length === 0 &&
        container.querySelectorAll(".turn-run-row").length === 0,
      "flat mode renders one outer process with no nested activity groups",
    );
    setSettings();

    // The active tail may be wrapped in a merged off-mode part; the merged group
    // must still receive the live disclosure defaults.
    setSettings({ transcriptDisplayMode: "fully-folded" });
    render(
      [read, grep, run("live-folded-bash", "pnpm test")],
      true,
      null,
      "live-folded",
    );
    check(
      visible(row("live-folded-bash")) &&
        container.querySelector(".process-activity-group.grouped.open") !== null,
      "the merged group keeps its live disclosure default",
    );

    const earlierThinking = message("earlier-thinking", "assistant", "", {
      thinking: "Earlier reasoning remains available.",
      status: "complete",
    });
    const liveThinking = message("live-thinking", "assistant", "", {
      thinking: "Latest reasoning remains available.",
      status: "streaming",
    });
    const completedThinking = { ...liveThinking, status: "complete" as const };
    const thinkingAnswer = message("thinking-answer", "assistant", "Done.", {
      status: "complete",
    });
    render(
      [earlierThinking, read, liveThinking, thinkingAnswer],
      true,
      null,
      "fully-folded-thinking-settlement",
    );
    const liveThinkingHeaders = [
      ...container.querySelectorAll<HTMLElement>(".tool-row.thinking .tool-row-header"),
    ];
    check(
      liveThinkingHeaders.length === 2 &&
        liveThinkingHeaders.every((header) => header.getAttribute("aria-expanded") === "true"),
      "fully folded expands each visible thinking row by default",
    );
    render(
      [earlierThinking, read, completedThinking, thinkingAnswer],
      false,
      null,
      "fully-folded-thinking-settlement",
    );
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "false",
      "the completed process still starts closed",
    );
    click(processHeaders()[0] ?? null);
    const settledThinkingHeaders = [
      ...container.querySelectorAll<HTMLElement>(".tool-row.thinking .tool-row-header"),
    ];
    const settledThinkingGroupHeader = row("read")?.closest<HTMLElement>(
      ".process-activity-group.grouped",
    )?.querySelector<HTMLElement>(".tool-activity-header");
    check(
      settledThinkingGroupHeader?.getAttribute("aria-expanded") === "true" &&
        settledThinkingHeaders.length === 2 &&
        settledThinkingHeaders.every((header) => header.getAttribute("aria-expanded") === "true") &&
        container.textContent?.includes("Earlier reasoning remains available.") === true &&
        container.textContent?.includes("Latest reasoning remains available.") === true &&
        row("read")?.querySelector<HTMLElement>(".tool-row-header")?.getAttribute("aria-expanded") === "false",
      "reopening the process reveals the open group and reasoning while tool payloads stay collapsed",
    );

    const largeGroup = Array.from({ length: 5 }, (_, index) =>
      tool(`large-group-${index}`, "Read", { toolResult: `result ${index}` }),
    );
    render(
      [...largeGroup, thinkingAnswer],
      false,
      null,
      "large-completed-activity-group",
    );
    const largeGroupHeader = row("large-group-0")?.closest<HTMLElement>(
      ".process-activity-group.grouped",
    )?.querySelector<HTMLElement>(".tool-activity-header");
    click(processHeaders()[0] ?? null);
    check(
      largeGroupHeader?.getAttribute("aria-expanded") === "false",
      "large activity groups remain collapsed by default",
    );
    setSettings();

    // The header reports the turn's outcome, never the item it is working on.
    render(mixed, false, null, "completed-header");
    const completedLabel = i18n.t("chat.processCompleted");
    const completedText = processHeaders()[0]
      ?.querySelector(".tool-activity-label")
      ?.textContent ?? "";
    check(
      completedText.startsWith(completedLabel) &&
        !completedText.includes("pnpm test") &&
        !completedText.includes("pnpm build"),
      "a settled turn header reports completion without echoing a command",
    );
    render([intro, read, grep], true, null, "live-header");
    check(
      processHeaders()[0]
        ?.querySelector(".tool-activity-label")
        ?.textContent === i18n.t("chat.processRunning"),
      "a live turn header reports running",
    );

    // The store settles a Stop on the tool row itself: an aborted assistant row
    // is not written. The header must read the aborted activity row rather than
    // falling back to the tool's running/error state.
    const stoppedBash = [
      message("stopped-user", "user", "Run"),
      tool("stopped-bash", "Bash", {
        toolArgs: { command: "pnpm test" },
        status: "aborted",
        toolStatus: "error",
      }),
    ];
    render(stoppedBash, false, null, "stopped-bash");
    check(
      processHeaders()[0]
        ?.querySelector(".tool-activity-label")
        ?.textContent === i18n.t("chat.processStopped"),
      "an aborted running Bash row reports the turn stopped",
    );

    // The Settings row is a three-way transcript display mode control.
    let modeSaved: Partial<AppSettings> | undefined;
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisplayModeRow
            settings={{ ...baseSettings }}
            saveSettings={async (patch) => {
              modeSaved = patch;
            }}
          />
        </I18nextProvider>,
      ),
    );
    const modeButtons = Array.from(
      container.querySelectorAll<HTMLElement>('[role="radiogroup"] button'),
    );
    check(
      modeButtons.length === 3 &&
        modeButtons[1]?.getAttribute("aria-checked") === "true",
      "the transcript-display row exposes flat, command-first and fully-folded with command-first selected",
    );
    click(modeButtons[2] ?? null);
    check(
      modeSaved?.transcriptDisplayMode === "fully-folded",
      "the transcript-display row saves the selected mode",
    );


    // The Settings row is a boolean Show thinking toggle.
    let saved: Partial<AppSettings> | undefined;
    const settings: AppSettings = { ...baseSettings, showThinking: false };
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ShowThinkingRow
            settings={settings}
            saveSettings={async (patch) => {
              saved = patch;
            }}
          />
        </I18nextProvider>,
      ),
    );
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    check(
      toggle?.getAttribute("aria-checked") === "false",
      "the Show thinking row reflects the stored preference",
    );
    click(toggle);
    check(
      saved?.showThinking === true,
      "the Show thinking row saves the boolean preference",
    );

    return { ok: true, checks: notes, metrics };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState({ settings: initialSettings });
    container.remove();
  }
}
