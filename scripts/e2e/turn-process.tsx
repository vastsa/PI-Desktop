import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AppSettings, ReviewChange, UiMessage } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { ThinkingDisplayModeRow } from "../../apps/desktop/src/components/settings/ThinkingDisplayModeRow";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptSearchContext } from "../../apps/desktop/src/lib/transcript-search-context";
import type { TranscriptSearchTarget } from "../../apps/desktop/src/lib/transcript-reading";
import { reviewChangesFromMessage } from "../../apps/desktop/src/lib/workspace-review";
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

const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function review(
  messageId: string,
  snapshotId: string,
  path: string,
  additions: number,
  deletions: number,
  extra: Partial<ReviewChange> = {},
): ReviewChange {
  return {
    version: 1,
    messageId,
    snapshotId,
    path,
    operation: "edit",
    status: "modified",
    state: "active",
    additions,
    deletions,
    hunks: [
      {
        header: "@@ -1,2 +1,4 @@",
        lines: [
          { type: "del", text: "class Main {}" },
          { type: "add", text: "class Main {" },
          { type: "add", text: "  static void run() {}" },
          { type: "add", text: "}" },
        ],
      },
    ],
    reversible: true,
    ...extra,
  };
}

function DelegatedEditReviewFixture({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((state) => state.messages);
  const workPanelOpen = useAppStore((state) => state.workPanelOpen);
  const entry = buildTranscriptEntries(messages).entries.find(
    (item) => item.kind === "assistant-turn",
  );
  assert(entry?.kind === "assistant-turn", "delegated edit turn missing");
  return (
    <div className="delegated-edit-review-fixture">
      <TranscriptDisclosureProvider>
        <TranscriptSearchContext.Provider value={null}>
          <AssistantTurn
            entry={entry}
            sessionId={sessionId}
            isActive={false}
          />
        </TranscriptSearchContext.Provider>
      </TranscriptDisclosureProvider>
      {workPanelOpen ? <WorkPanel containerWidth={1280} sidebarCollapsed /> : null}
    </div>
  );
}

/** Real mounted React components: disclosure ownership, preferences and search. */
export async function turnProcessProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const initialState = useAppStore.getState();
  const previousBridge = window.piDesktop;
  const settings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
  };
  flushSync(() => useAppStore.setState({ settings }));
  const errors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
  });
  const notes: string[] = [];
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
          <TranscriptDisclosureProvider key={key}>
            <TranscriptSearchContext.Provider value={search}>
              <AssistantTurn
                key={key}
                entry={entry}
                sessionId={undefined}
                isActive={active}
              />
            </TranscriptSearchContext.Provider>
          </TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
    assert(!errors.length, `React error: ${errors.map(String).join("; ")}`);
  };
  const renderUserMessage = (userMessage: UiMessage) => {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <MessageRow message={userMessage} isRunning={false} />
        </I18nextProvider>,
      ),
    );
    assert(!errors.length, `React error: ${errors.map(String).join("; ")}`);
  };
  const header = () =>
    container.querySelector<HTMLButtonElement>(".turn-process > button");
  const process = () => container.querySelector<HTMLElement>(".turn-process-body");
  const visible = (element: Element | null) =>
    Boolean(element?.getBoundingClientRect().height);
  const click = (element: HTMLElement | null) => {
    assert(element, "missing click target");
    flushSync(() => element.click());
  };
  const intro = message("intro", "assistant", "Inspecting the files", {
    thinking: "reasoning detail",
    status: "complete",
  });
  const read = message("read", "tool", "read output", {
    toolName: "Read",
    toolCallId: "read-call",
    toolStatus: "success",
    toolArgs: { path: "src/example.ts" },
  });
  const progress = message("progress", "assistant", "Found the problem");
  const edit = message("edit", "tool", "edit output", {
    toolName: "Edit",
    toolCallId: "edit-call",
    toolStatus: "success",
    toolArgs: { path: "src/example.ts" },
  });
  const answer = message("answer", "assistant", "The fix is ready.", {
    status: "complete",
    createdAt: "2026-09-17T00:00:03.000Z",
    responseDurationMs: 1000,
  });
  const messages = [intro, read, progress, edit, answer];
  const deniedWrite = message("denied-write", "tool", "permission denied", {
    toolName: "Write",
    toolCallId: "write-call",
    toolStatus: "denied",
    toolArgs: { path: "src/example.ts", content: "updated" },
  });
  const recoveredBash = message("recovered-bash", "tool", "updated", {
    toolName: "Bash",
    toolCallId: "bash-call",
    toolStatus: "success",
    toolArgs: { command: "Set-Content src/example.ts updated" },
  });
  const recoveredAnswer = message(
    "recovered-answer",
    "assistant",
    "The fallback completed the update.",
    { status: "complete", createdAt: "2026-09-17T00:00:04.000Z" },
  );
  const activeRecovery = [intro, deniedWrite, recoveredBash];
  const completedRecovery = [...activeRecovery, recoveredAnswer];
  const steeringRoot = message("steering-root", "user", "Inspect the renderer", {
    createdAt: "2026-09-17T00:00:00.000Z",
  });
  const steering = message("steering-supplement", "user", "Also preserve the attachment", {
    steering: true,
    createdAt: "2026-09-17T00:00:02.500Z",
    attachments: [{ kind: "file", name: "notes.txt", ref: "notes.txt" }],
  });
  const activeSteered = [steeringRoot, intro, read, steering, edit];
  const completedSteered = [...activeSteered, answer];
  const preOutputSteered = [steeringRoot, steering, read, answer];
  const verifyCompletionLifecycle = (
    mode: "detailed" | "compact",
    requestId: number,
  ) => {
    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, thinkingDisplayMode: mode },
      }),
    );
    const key = `${mode}-completion`;
    render(activeRecovery, true, null, key);
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      `${mode} active recovery process opens automatically`,
    );
    const nestedRow = container.querySelector('[data-message-id="denied-write"]');
    const nestedHeader = container.querySelector<HTMLButtonElement>(
      '[data-message-id="denied-write"] .tool-row-header',
    );
    const groupHeader = nestedRow?.closest(".process-activity-group")
      ?.querySelector<HTMLButtonElement>(":scope > .tool-activity-header");
    if (groupHeader?.getAttribute("aria-expanded") === "false") click(groupHeader);
    click(nestedHeader);
    check(
      nestedHeader?.getAttribute("aria-expanded") === "true",
      `${mode} active nested interaction expands tool details`,
    );
    flushSync(() => nestedHeader?.focus());
    check(
      document.activeElement === nestedHeader,
      `${mode} nested tool owns focus before completion`,
    );
    render(completedRecovery, false, null, key);
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      `${mode} completion folds the entire interacted process`,
    );
    check(
      container.querySelector('[data-message-id="denied-write"]') === nestedRow,
      `${mode} completion does not remount nested process children`,
    );
    check(
      document.activeElement === header(),
      `${mode} completion returns nested focus to the process header`,
    );
    const foldedMarker = header()?.querySelector(".turn-process-error");
    check(
      Boolean(foldedMarker) && !(foldedMarker?.textContent || "").trim(),
      `${mode} completed folded header keeps an icon-only failure marker`,
    );
    check(
      visible(container.querySelector('[data-message-id="recovered-answer"]')),
      `${mode} recovered final answer remains outside the process`,
    );
    click(header());
    check(
      header()?.getAttribute("aria-expanded") === "true" &&
        Boolean(header()?.querySelector(".turn-process-error")) &&
        Boolean(process()?.querySelector('[data-message-id="denied-write"]')),
      `${mode} reopening preserves the failure marker and tool details`,
    );
    render(
      [
        ...activeRecovery,
        { ...recoveredAnswer, responseDurationMs: 1000 },
      ],
      false,
      null,
      key,
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      `${mode} completed manual reopen survives unrelated updates`,
    );
    click(header());
    render(
      completedRecovery,
      false,
      {
        sessionId: "s",
        messageId: "denied-write",
        query: "permission",
        requestId,
      },
      key,
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" &&
        visible(container.querySelector('[data-message-id="denied-write"]')),
      `${mode} search reveals a completed folded process`,
    );
  };
  try {
    render(messages);
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "detailed groups one process per turn",
    );
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "detailed completed process starts collapsed",
    );
    check(
      visible(container.querySelector('[data-message-id="answer"]')),
      "final answer stays visible outside the process",
    );
    check(
      !visible(container.querySelector('[data-message-id="progress"]')),
      "completed progress starts folded",
    );
    check(
      header()?.textContent?.includes("2 tools"),
      "detailed process counts reasoning, tools, and progress once",
    );
    check(
      header()?.textContent?.includes(
        i18n.t("chat.processedFor", { time: "4s" }),
      ),
      "completed process header shows elapsed time",
    );
    click(header());
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "detailed keeps completed progress recoverable",
    );
    check(
      container.querySelector('[data-message-id="edit"]')?.classList.contains("open") === true,
      "detailed opens the last tool inside the process",
    );
    check(
      container.querySelector('[data-message-id="read"]')?.classList.contains("open") !== true,
      "detailed keeps earlier tools collapsed",
    );
    check(
      process()?.querySelectorAll(".tool-row").length === 3,
      "detailed keeps completed thinking and tools recoverable",
    );
    render(
      [intro, { ...read, toolStatus: "error", isError: true }, answer],
      false,
      null,
      "failed-last-tool",
    );
    check(
      container.querySelector('[data-message-id="read"]')?.classList.contains("open") !== true,
      "detailed keeps a last failed tool collapsed",
    );


    render(activeSteered, true, null, "steering-lifecycle");
    check(
      container.querySelectorAll(".turn-process").length === 1 &&
        header()?.getAttribute("aria-expanded") === "true",
      "marked steering keeps earlier and later work in one active process",
    );
    const readRow = container.querySelector('[data-message-id="read"]');
    const steeringRow = container.querySelector('[data-message-id="steering-supplement"]');
    const editRow = container.querySelector('[data-message-id="edit"]');
    check(
      Boolean(
        readRow &&
          steeringRow &&
          editRow &&
          (readRow.compareDocumentPosition(steeringRow) &
            Node.DOCUMENT_POSITION_FOLLOWING) &&
          (steeringRow.compareDocumentPosition(editRow) &
            Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      "expanded process preserves work, steering bubble, continuation order",
    );
    check(
      steeringRow?.querySelector(".chat-file-chip")?.textContent?.includes("notes.txt") === true,
      "embedded steering keeps user attachments",
    );
    render(completedSteered, false, null, "steering-lifecycle");
    check(
      header()?.getAttribute("aria-expanded") === "false" &&
        !visible(container.querySelector('[data-message-id="steering-supplement"]')) &&
        visible(container.querySelector('[data-message-id="answer"]')),
      "completed steering process folds while the final answer stays outside",
    );
    render(
      completedSteered,
      false,
      {
        sessionId: "s",
        messageId: "steering-supplement",
        query: "attachment",
        requestId: 103,
      },
      "steering-lifecycle",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" &&
        visible(container.querySelector('[data-message-id="steering-supplement"]')),
      "search reveals a steering bubble inside the folded process",
    );
    render(preOutputSteered, false, null, "steering-before-output");
    const steeringAnchor = container.querySelector(
      '[data-minimap-id="steering-supplement"]',
    );
    const assistantAnchor = container.querySelector('[data-minimap-id="answer"]');
    check(
      steeringAnchor === null &&
        container.querySelectorAll('[data-minimap-id="answer"]').length === 1 &&
        visible(assistantAnchor) &&
        !visible(container.querySelector('[data-message-id="steering-supplement"]')),
      "grouped steering has no hidden minimap anchor while the assistant anchor stays visible",
    );
    renderUserMessage(steering);
    check(
      container.querySelectorAll('[data-minimap-id="steering-supplement"]').length === 1 &&
        visible(container.querySelector('[data-minimap-id="steering-supplement"]')),
      "standalone leading steering keeps a visible minimap anchor",
    );
    const streaming = message("stream", "assistant", "Live text", {
      status: "streaming",
    });
    render([streaming], true, null, "stream");
    check(
      !header() && visible(container.querySelector('[data-message-id="stream"]')),
      "streamed answer is never delayed behind disclosure",
    );
    render([streaming, read], true, null, "stream");
    check(
      header()?.getAttribute("aria-expanded") === "true" &&
        visible(container.querySelector('[data-message-id="stream"]')),
      "later tools move provisional text into the expanded process",
    );
    render([intro, read, { ...answer, status: "aborted" }], false, null, "aborted");
    check(
      visible(container.querySelector('[data-message-id="answer"]')),
      "stopped partial answer remains visible",
    );
    render(
      [
        intro,
        read,
        message("failure", "assistant", "", {
          error: { code: "INTERNAL", message: "Connection failed", retryable: true },
        }),
      ],
      false,
      null,
      "error",
    );
    check(
      visible(container.querySelector('[data-message-id="failure"]')),
      "failure remains visible",
    );

    verifyCompletionLifecycle("detailed", 101);
    verifyCompletionLifecycle("compact", 102);
    render(messages, false, null, "compact-group");
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "one process per turn",
    );
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "compact completed process starts collapsed",
    );
    check(
      container.querySelector('[data-message-id="edit"]')?.classList.contains("open") !== true,
      "compact keeps tool payloads collapsed",
    );
    check(
      header()?.textContent?.includes("2 tools"),
      "process counts tools and progress once",
    );
    click(header());
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "expanding reveals intermediate progress",
    );
    check(
      process()?.querySelectorAll(".tool-row").length === 2,
      "compact expanding retains both tools without thinking",
    );
    render(messages, true, null, "compact-group-reset");
    click(container.querySelector('[data-message-id="read"] .tool-row-header'));
    render(messages, false, null, "compact-group-reset");
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "active-to-complete transition resets a previously opened process",
    );

    render([intro, read], true, null, "live");
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "compact live process opens automatically",
    );
    render(messages, false, null, "live");
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "compact live process collapses after completion",
    );
    render(
      messages,
      false,
      { sessionId: "s", messageId: "progress", query: "problem", requestId: 1 },
      "search",
    );
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "search reveals folded progress",
    );

    const liveThought = message("live-thought", "assistant", "", {
      thinking: "Reasoning before the answer",
      status: "streaming",
    });
    const processLabel = () =>
      container.querySelector(".tool-activity-label")?.textContent;
    render([liveThought], true, null, "thinking-transition");
    check(
      processLabel()?.startsWith(i18n.t("chat.thinkingFor", { time: "" })),
      "active reasoning uses the thinking label",
    );
    render(
      [{ ...liveThought, content: "Answer has started" }],
      true,
      null,
      "thinking-transition",
    );
    check(
      !header() &&
        visible(container.querySelector('[data-message-id="live-thought"]')),
      "answer streaming ends the thinking label even when reasoning is retained",
    );
    render(
      [
        liveThought,
        message("separate-answer", "assistant", "Answer text", {
          status: "streaming",
        }),
      ],
      true,
      null,
      "thinking-transition",
    );
    check(
      processLabel()?.startsWith(i18n.t("chat.processingFor", { time: "" })),
      "a later answer takes precedence over an earlier streaming thought",
    );

    render([streaming, read], true, null, "stream-compact");
    check(
      process()?.querySelector('[data-message-id="stream"]'),
      "later tool moves provisional text into process",
    );

    render(
      [intro, { ...read, toolStatus: "error", isError: true }, answer],
      false,
      null,
      "tool-error",
    );
    check(
      header()?.getAttribute("aria-expanded") === "false" &&
        !visible(process()) &&
        Boolean(header()?.querySelector(".turn-process-error")) &&
        !(header()?.querySelector(".turn-process-error")?.textContent || "").trim(),
      "completed tool failures stay folded with an icon-only header marker",
    );

    let saved: Partial<AppSettings> | undefined;
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ThinkingDisplayModeRow
            settings={settings}
            saveSettings={async (patch) => {
              saved = patch;
              useAppStore.setState({ settings: { ...settings, ...patch } });
            }}
          />
        </I18nextProvider>,
      ),
    );
    click(container.querySelector('button[aria-haspopup="listbox"]'));
    click(
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (item) => item.textContent === "Compact",
      ) ?? null,
    );
    check(
      saved?.thinkingDisplayMode === "compact",
      "settings control saves compact mode",
    );

    render(
      [intro, { ...read, toolStatus: "error", isError: true }, answer],
      true,
      null,
      "compact-error",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "compact mode reveals an active tool failure",
    );

    const thought = message("thought", "assistant", "", {
      thinking: "hidden thinking words",
      status: "streaming",
    });
    render([thought], true, null, "compact");
    check(
      Boolean(header()) && !container.textContent?.includes("hidden thinking words"),
      "compact live thinking has status without reasoning text",
    );
    check(header()?.getAttribute("aria-expanded") === "true", "compact live process starts expanded");
    check(
      visible(container.querySelector(".thinking-compact")),
      "compact live thinking remains indicator-only when expanded",
    );
    render([{ ...thought, status: "complete" }], false, null, "compact");
    check(
      !header() && !container.querySelector(".thinking"),
      "completed compact thinking leaves no empty process or thought block",
    );
    render([{ ...thought, content: "Started answer" }], true, null, "compact");
    check(
      !container.querySelector(".thinking") &&
        visible(container.querySelector('[data-message-id="thought"]')),
      "compact thinking ends as soon as answer text starts",
    );
    render(messages, false, null, "compact-tools");
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "compact completed process starts collapsed",
    );
    click(header());
    check(
      !container.querySelector(".thinking") &&
        process()?.querySelectorAll(".tool-row").length === 2,
      "compact keeps tools and progress accessible",
    );
    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, thinkingDisplayMode: "detailed" },
      }),
    );
    check(
      Boolean(container.querySelector(".thinking")),
      "mode changes update mounted history",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "mode changes preserve a completed manual reopen",
    );
    check(
      messages[0].thinking === "reasoning detail",
      "presentation never deletes reasoning data",
    );

    render(messages, false, null, "completed-timestamp");
    const assistantTime = container.querySelector<HTMLTimeElement>(
      ".assistant-turn .message-actions .message-timestamp",
    );
    const assistantActions = container.querySelector<HTMLElement>(
      ".assistant-turn .message-actions",
    );
    const expectedEnd = new Intl.DateTimeFormat(
      i18n.resolvedLanguage ?? i18n.language,
      { dateStyle: "medium", timeStyle: "short" },
    ).format(new Date("2026-09-17T00:00:04.000Z"));
    check(
      assistantTime?.dateTime === "2026-09-17T00:00:04.000Z" &&
        assistantTime.textContent === expectedEnd &&
        Boolean(assistantActions?.contains(assistantTime)) &&
        getComputedStyle(assistantActions!).opacity === "0",
      "completed assistant timestamp lives in hidden hover action chrome",
    );
    document.documentElement.classList.add("pointer-outside");
    check(
      getComputedStyle(assistantActions!).opacity === "0",
      "assistant timestamp stays hidden when the pointer leaves the window",
    );
    document.documentElement.classList.remove("pointer-outside");

    const userTimestamp = "2026-09-17T13:45:00.000Z";
    renderUserMessage(
      message("timestamp-user", "user", "Timestamped request", {
        createdAt: userTimestamp,
      }),
    );
    const time = container.querySelector<HTMLTimeElement>(".message-timestamp");
    const actions = container.querySelector<HTMLElement>(".message-actions");
    const bubble = container.querySelector(".message-bubble");
    const expectedTimestamp = new Intl.DateTimeFormat(
      i18n.resolvedLanguage ?? i18n.language,
      { dateStyle: "medium", timeStyle: "short" },
    ).format(new Date(userTimestamp));
    check(
      time?.dateTime === userTimestamp &&
        time.textContent === expectedTimestamp &&
        Boolean(actions?.contains(time)) &&
        Boolean(
          bubble &&
            (bubble.compareDocumentPosition(time) &
              Node.DOCUMENT_POSITION_FOLLOWING),
        ) &&
        getComputedStyle(actions!).opacity === "0",
      "user timestamp is semantic, localized, and only in the hover action chrome",
    );
    document.documentElement.classList.add("pointer-outside");
    check(
      getComputedStyle(actions!).opacity === "0",
      "user timestamp stays hidden when the pointer leaves the window",
    );
    document.documentElement.classList.remove("pointer-outside");
    renderUserMessage(
      message("invalid-timestamp", "user", "Invalid timestamp", {
        createdAt: "not-a-date",
      }),
    );
    check(
      !container.querySelector(".message-timestamp"),
      "invalid user timestamp is omitted",
    );
    const delegatedSessionId = "delegated-edit-summary";
    const delegatedTaskCallId = "task-call-delegated-edit";
    const delegatedEditMessageId = "delegated-edit-main";
    const delegatedSnapshotId = "snapshot-delegated-edit-main";
    const delegatedMessages: UiMessage[] = [
      message("delegated-user", "user", "Update the Java entry point"),
      message("delegated-task", "tool", "Delegated successfully", {
        toolName: "Task",
        toolCallId: delegatedTaskCallId,
        toolStatus: "success",
        toolArgs: {
          subagent_type: "fixer",
          description: "Update Main.java",
          prompt: "Apply the requested Java change.",
        },
        toolResult: {
          details: { delegationId: "delegated-run", status: "completed" },
        },
      }),
      message(delegatedEditMessageId, "tool", "Updated src/Main.java", {
        parentToolCallId: delegatedTaskCallId,
        agentName: "fixer",
        toolName: "Edit",
        toolCallId: "delegated-native-edit-call",
        toolStatus: "success",
        toolArgs: { path: "src/Main.java" },
        toolResult: {
          details: {
            root: "workspace",
            review: review(
              delegatedEditMessageId,
              delegatedSnapshotId,
              "src/Main.java",
              3,
              1,
            ),
          },
        },
      }),
      message("parent-gradle-build", "tool", "Build completed", {
        toolName: "Bash",
        toolCallId: "parent-gradle-build-call",
        toolStatus: "success",
        toolArgs: { command: ".\\gradlew.bat build" },
        toolResult: {
          details: {
            root: "workspace",
            exitCode: 0,
            review: review(
              "parent-gradle-build",
              "snapshot-gradle-current",
              ".gradle/8.10/fileHashes/fileHashes.bin",
              0,
              0,
              { binary: true },
            ),
            reviews: [
              review(
                "parent-gradle-build",
                "snapshot-gradle-history",
                "module/.gradle/buildOutputCleanup/cache.properties",
                1,
                1,
              ),
            ],
            reviewCapture: { status: "complete" },
          },
        },
      }),
      message("delegated-final", "assistant", "The Java change is complete.", {
        status: "complete",
      }),
      message("delegated-resume-user", "user", "Continue the same delegate"),
      message("delegated-resume-task", "tool", "Resumed successfully", {
        toolName: "Task",
        toolCallId: "task-call-delegated-resume",
        toolStatus: "success",
        toolArgs: { agent: "fixer", resume: "delegated-run" },
        toolResult: {
          details: { delegationId: "delegated-resume-run", status: "completed" },
        },
      }),
      message("delegated-resume-final", "assistant", "No further edits needed.", {
        status: "complete",
      }),
    ];
    let rollbackInput: { sessionId: string; snapshotId: string } | undefined;
    let rollbackTarget: { messageId: string; snapshotId: string } | undefined;
    const rollbackWorkspaceChange = initialState.rollbackWorkspaceChange;
    window.piDesktop = {
      invoke: async (_channel, input) => {
        rollbackInput = input as { sessionId: string; snapshotId: string };
        return {
          ok: true,
          data: {
            status: "rolledBack",
            snapshotId: rollbackInput.snapshotId,
          },
        };
      },
      on: () => () => undefined,
      channels:
        previousBridge?.channels ??
        ({} as NonNullable<typeof window.piDesktop>["channels"]),
      platform: "win32",
    };
    flushSync(() =>
      useAppStore.setState({
        activeSessionId: delegatedSessionId,
        isRunning: false,
        messages: delegatedMessages,
        workPanelOpen: false,
        workPanelTabs: [],
        activeWorkPanelTabId: null,
        workPanelContexts: {},
        rollbackWorkspaceChange: async (messageId, snapshotId) => {
          rollbackTarget = { messageId, snapshotId };
          return rollbackWorkspaceChange(messageId, snapshotId);
        },
      }),
    );
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <DelegatedEditReviewFixture sessionId={delegatedSessionId} />
        </I18nextProvider>,
      ),
    );
    const delegatedSummary = container.querySelector<HTMLElement>(
      ".turn-file-summary",
    );
    const delegatedFile = container.querySelector<HTMLButtonElement>(
      ".turn-file-summary-file-header",
    );
    check(
      delegatedSummary?.getAttribute("aria-label") ===
        i18n.t("chat.turnFilesEdited", { count: 1 }) &&
        container.querySelectorAll(".turn-file-summary-file-header").length === 1,
      "delegated native edit contributes the only summarized file",
    );
    check(
      delegatedFile?.querySelector(".turn-file-summary-path")?.textContent ===
        "src/Main.java" &&
        !delegatedSummary?.textContent?.includes(".gradle"),
      "summary keeps the delegated source path and excludes parent Gradle caches",
    );
    check(
      delegatedSummary
        ?.querySelector(".turn-file-summary-totals")
        ?.getAttribute("aria-label") ===
        i18n.t("chat.turnFilesEditTotalsLabel", { additions: 3, deletions: 1 }) &&
        delegatedFile?.getAttribute("aria-label") ===
          `src/Main.java · ${i18n.t("chat.reviewChangeCounts", {
            additions: 3,
            deletions: 1,
          })}`,
      "delegated native edit reports its actual addition and deletion totals",
    );
    click(delegatedFile);
    await painted();
    const reviewSelection =
      useAppStore.getState().workPanelContexts[delegatedSessionId]?.reviewSelection;
    check(
      useAppStore.getState().activeWorkPanelTabId === "review" &&
        reviewSelection?.selectedPath === "src/Main.java" &&
        reviewSelection.snapshotIds.length === 1 &&
        reviewSelection.snapshotIds[0] === delegatedSnapshotId,
      "delegated summary click opens Review with the original snapshot",
    );
    check(
      container.querySelectorAll(".review-scroll .review-change-card").length === 1 &&
        container
          .querySelector(".review-scroll .review-change-card-path")
          ?.textContent?.includes("src/Main.java") === true,
      "Review renders only the selected delegated native edit",
    );
    const delegatedRollback = container.querySelector<HTMLButtonElement>(
      ".review-scroll .review-change-rollback",
    );
    click(delegatedRollback);
    await painted();
    const rolledBackDelegate = useAppStore
      .getState()
      .messages.find((item) => item.id === delegatedEditMessageId);
    check(
      rollbackTarget?.messageId === delegatedEditMessageId &&
        rollbackTarget.snapshotId === delegatedSnapshotId &&
        rollbackInput?.sessionId === delegatedSessionId &&
        rollbackInput.snapshotId === delegatedSnapshotId &&
        Boolean(
          rolledBackDelegate &&
            reviewChangesFromMessage(rolledBackDelegate)[0]?.state === "rolledBack",
        ),
      "Review rollback preserves the delegated message id and snapshot id",
    );
    check(
      container.querySelector(".turn-file-summary-totals")?.getAttribute("aria-label") ===
        i18n.t("chat.turnFilesEditTotalsLabel", { additions: 0, deletions: 0 }),
      "rollback updates the original turn summary after the delegate card moves to a resumed turn",
    );

    return { ok: true, checks: notes };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState(initialState, true);
    window.piDesktop = previousBridge;
    container.remove();
  }
}
