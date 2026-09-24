import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ThinkingDisplayModeRow } from "../../apps/desktop/src/components/settings/ThinkingDisplayModeRow";
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
  const initialSettings = useAppStore.getState().settings;
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
          <TranscriptSearchContext.Provider value={search}>
            <AssistantTurn key={key} entry={entry} isActive={active} />
          </TranscriptSearchContext.Provider>
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
  try {
    render(messages);
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "detailed wraps one process per turn",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "detailed starts the process open",
    );
    check(
      visible(container.querySelector('[data-message-id="answer"]')),
      "final answer stays visible",
    );
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "detailed keeps intermediate progress visible",
    );
    check(
      container.querySelector('[data-message-id="edit"]')?.classList.contains("open") === true,
      "detailed opens the last tool",
    );
    check(
      container.querySelector('[data-message-id="read"]')?.classList.contains("open") !== true,
      "detailed keeps earlier tools collapsed",
    );
    check(
      container.querySelectorAll(".tool-row").length === 3,
      "detailed shows thinking and both tools in place",
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
      "detailed keeps streamed text visible after later tools",
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

    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, thinkingDisplayMode: "compact" },
      }),
    );
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
    render(messages, true, null, "compact-group");
    render(messages, false, null, "compact-group");
    check(
      header()?.getAttribute("aria-expanded") === "true",
      "manual disclosure survives active-to-complete transition",
    );

    render([intro, read], true, null, "live");
    check(
      header()?.getAttribute("aria-expanded") === "false",
      "compact live process stays collapsed without a tool failure",
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
      true,
      null,
      "tool-error",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "an active tool failure opens an unclaimed process",
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
    click(container.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]'));
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
    click(header());
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
      messages[0].thinking === "reasoning detail",
      "presentation never deletes reasoning data",
    );
    return { ok: true, checks: notes };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState({ settings: initialSettings });
    container.remove();
  }
}
