import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/**
 * Real nested-disclosure state transitions: automatic folding, manual choices,
 * transient reading protection, `Show thinking`, and the activity issue counter.
 * Only transcript inputs and settings are fixtures.
 */
export async function transcriptAutoCollapseProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: {
      en: { translation: catalogs.en },
      "zh-CN": { translation: catalogs["zh-CN"] },
    },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  host.style.cssText = "width:800px;max-width:100%;padding:32px;box-sizing:border-box";
  const outside = document.createElement("button");
  outside.textContent = "Outside transcript";
  const container = document.createElement("div");
  host.append(container, outside);
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
  const initialSettings = useAppStore.getState().settings;
  const notes: string[] = [];
  const failures: string[] = [];
  const check = (value: unknown, name: string) => {
    (value ? notes : failures).push(name);
  };

  const message = (
    id: string,
    role: UiMessage["role"],
    content: string,
    extra: Partial<UiMessage> = {},
  ): UiMessage => ({ id, role, content, createdAt: "2026-09-17T00:00:00.000Z", ...extra });
  const thoughtLive = message("thought", "assistant", "", {
    thinking: "Reasoning stays available when Show thinking is enabled.",
    status: "streaming",
  });
  const thoughtDone: UiMessage = { ...thoughtLive, status: "complete" };
  const reads = Array.from({ length: 7 }, (_, index) =>
    message(`read-${index}`, "tool", "", {
      toolName: "Read",
      toolCallId: `call-read-${index}`,
      toolStatus: index === 0 ? "error" : "success",
      toolArgs: { path: `src/example-${index}.ts` },
      toolResult: { details: { stdout: "fixture output", exitCode: index === 0 ? 1 : 0 } },
    }),
  );
  const answer = message("answer", "assistant", "Final answer stays visible.", {
    status: "complete",
  });
  const settings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    showThinking: true,
    transcriptDisplayMode: "fully-folded",
    smoothStreaming: false,
  };
  const configure = (patch: Partial<AppSettings> = {}) =>
    flushSync(() => useAppStore.setState({ settings: { ...settings, ...patch } }));
  const render = (id: string, messages: UiMessage[], active: boolean) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    if (entry?.kind !== "assistant-turn") throw new Error("Missing assistant turn fixture");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisclosureProvider key={id}>
            <AssistantTurn entry={entry} isActive={active} />
          </TranscriptDisclosureProvider>
        </I18nextProvider>,
      ),
    );
  };
  const header = () => container.querySelector<HTMLButtonElement>(".turn-process > button");
  const thoughtHeader = () =>
    container.querySelector<HTMLButtonElement>(".tool-row.thinking .tool-row-header");
  const groupHeader = () =>
    container.querySelector<HTMLButtonElement>(".process-activity-group > .tool-activity-header");
  const expanded = (element: Element | null) =>
    element?.getAttribute("aria-expanded") === "true";
  const click = (element: HTMLElement | null) => {
    if (!element) throw new Error("Missing disclosure click target");
    flushSync(() => element.click());
  };
  const press = (element: HTMLElement) =>
    flushSync(() => {
      for (const type of ["pointerdown", "pointerup"] as const) {
        element.dispatchEvent(
          new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1 }),
        );
      }
    });
  const focusOutside = () =>
    flushSync(() => {
      // Leaving the transcript is a click elsewhere: press, move focus, release.
      outside.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      );
      outside.focus();
      outside.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }),
      );
    });
  const select = (element?: HTMLElement) =>
    flushSync(() => {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.addRange(range);
      }
      document.dispatchEvent(new Event("selectionchange"));
    });

  try {
    configure();

    // A mere press is not a disclosure choice: the automatic close at settle
    // still applies, and the answer stays outside the folded process.
    render("press", [thoughtLive], true);
    const prose = container.querySelector<HTMLElement>(".thinking-prose");
    if (!prose) throw new Error("Missing visible reasoning");
    press(prose);
    render("press", [thoughtDone, answer], false);
    check(
      !expanded(header()),
      "a plain body press does not disable automatic turn collapse",
    );
    check(
      Boolean(
        container.querySelector('[data-message-id="answer"]')?.getBoundingClientRect().height,
      ),
      "the final answer remains visible outside the collapsed process",
    );

    // Keyboard focus inside the process is protected while it is there, and the
    // automatic close resumes as soon as the reader leaves.
    render("focus", [thoughtLive, ...reads], true);
    const focusedRow = container.querySelector<HTMLButtonElement>(
      '[data-message-id="read-0"] .tool-row-header',
    );
    if (!focusedRow) throw new Error("Missing focus target");
    flushSync(() => focusedRow.focus());
    render("focus", [thoughtDone, ...reads, answer], false);
    check(
      expanded(header()) && document.activeElement === focusedRow,
      "completion does not hide keyboard focus inside the process",
    );
    focusOutside();
    check(
      !expanded(header()),
      "leaving the process releases the reading hold and applies automatic collapse",
    );

    // The same rule protects an active text selection, and only that selection.
    render("selection", [thoughtLive], true);
    const selectedProse = container.querySelector<HTMLElement>(".thinking-prose");
    if (!selectedProse) throw new Error("Missing selection target");
    press(selectedProse);
    select(selectedProse);
    render("selection", [thoughtDone, answer], false);
    check(
      expanded(header()) && window.getSelection()?.isCollapsed === false,
      "completion preserves an active reasoning selection",
    );
    select();
    check(
      !expanded(header()),
      "clearing the selection releases automatic collapse protection",
    );

    // Child choices stay local: they are restored, never used to pin ancestors.
    render("child", [thoughtLive], true);
    click(thoughtHeader());
    click(thoughtHeader());
    render("child", [thoughtDone, answer], false);
    focusOutside();
    check(
      !expanded(header()),
      "a child toggle does not permanently force its enclosing turn open",
    );
    click(header());
    check(
      expanded(thoughtHeader()),
      "reopening the turn restores the explicit reasoning choice",
    );
    click(thoughtHeader());
    click(header());
    click(header());
    check(
      !expanded(thoughtHeader()),
      "closing and reopening a parent preserves a manually collapsed child",
    );

    for (const mode of ["flat", "command-first", "fully-folded"] as const) {
      configure({ transcriptDisplayMode: mode });

      // Work the turn still owns never folds mid-run, however large the group.
      render(`live-${mode}`, [thoughtLive, ...reads], true);
      check(expanded(header()), `${mode}: a running turn stays open`);
      check(
        mode === "flat" || expanded(groupHeader()),
        `${mode}: the running activity group stays open beyond four items`,
      );
      check(
        [...container.querySelectorAll(".tool-row.thinking .tool-row-header")].every(expanded),
        `${mode}: Show thinking keeps reasoning expanded`,
      );

      // A manual close is authoritative while the turn keeps streaming.
      click(header());
      render(`live-${mode}`, [thoughtLive, ...reads, answer], true);
      check(
        !expanded(header()),
        `${mode}: streaming does not undo a manual turn close`,
      );
      click(header());
      focusOutside();

      // Settled: plain tool rows fall back to the size rule, while reasoning the
      // reader asked to see is never folded away.
      render(`settled-${mode}`, [...reads, answer], false);
      check(
        mode === "flat" || !expanded(groupHeader()),
        `${mode}: a settled group of plain tool rows folds when it is large`,
      );
      render(`reasoning-${mode}`, [thoughtDone, ...reads, answer], false);
      click(header());
      check(
        (mode === "flat" || expanded(groupHeader())) && expanded(thoughtHeader()),
        `${mode}: settled reasoning stays visible under Show thinking`,
      );

      configure({ transcriptDisplayMode: mode, showThinking: false });
      check(
        container.querySelector(".tool-row.thinking") === null,
        `${mode}: hidden completed reasoning leaves no empty row`,
      );
      configure({ transcriptDisplayMode: mode });
      check(
        expanded(thoughtHeader()),
        `${mode}: re-enabling Show thinking restores expanded reasoning`,
      );
      focusOutside();
    }

    configure();
    // The issue counter is real header metadata with the app stylesheet: icon
    // and localized count stay on one centered line at both locale widths.
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      render(`issues-${locale}`, [thoughtLive, ...reads], true);
      for (const width of [320, 800]) {
        host.style.width = `${width}px`;
        for (const zoom of [1, 1.5]) {
          host.style.zoom = String(zoom);
          const issue = container.querySelector<HTMLElement>(".activity-issue-count");
          const icon = issue?.querySelector("svg");
          if (!issue || !icon) throw new Error("Missing activity issue counter");
          const text = document.createRange();
          text.selectNodeContents(issue);
          text.setStartAfter(icon);
          const iconRect = icon.getBoundingClientRect();
          const textRect = text.getBoundingClientRect();
          const issueRect = issue.getBoundingClientRect();
          const parentRect = issue.parentElement?.getBoundingClientRect();
          check(
            textRect.width > 0 &&
              textRect.left >= iconRect.right &&
              Math.abs(
                (textRect.top + textRect.bottom - iconRect.top - iconRect.bottom) / 2,
              ) < 3 * zoom,
            `${locale}/${width}/${zoom}: issue icon and count share one centered line`,
          );
          check(
            Boolean(parentRect) &&
              issueRect.right <= (parentRect as DOMRect).right + 1 &&
              issueRect.height <= (parentRect as DOMRect).height + 1,
            `${locale}/${width}/${zoom}: the issue counter stays inside its header row`,
          );
        }
      }
    }
    check(
      errors.length === 0,
      `React rendering has no errors: ${errors.map(String).join("; ")}`,
    );
    if (failures.length) {
      throw new Error(`Automatic disclosure regressions: ${JSON.stringify(failures)}`);
    }
    return { ok: true, checks: notes.length, notes };
  } finally {
    select();
    flushSync(() => root.unmount());
    useAppStore.setState({ settings: initialSettings });
    host.remove();
  }
}
