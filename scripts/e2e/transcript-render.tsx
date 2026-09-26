import { transcriptEditProbe } from "./transcript-edit";
import { turnProcessProbe } from "./turn-process";
import { transcriptStatusProbe } from "./transcript-status";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { useSmoothText } from "../../apps/desktop/src/hooks/useSmoothText";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var __activityGroupRenders: string[];
  var transcriptRenderProbe: () => Promise<unknown>;
  var transcriptRuntimeSlotProbe: () => Promise<unknown>;
  var smoothTextThrottleProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function markdownLinkInteractionProbe(
  i18n: ReturnType<typeof createInstance>,
) {
  const destination = "https://github.com/vastsa/PI-Desktop/issues/1106";
  const initialState = useAppStore.getState();
  const openedUrls: string[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:24px;left:24px";
  document.body.append(host);
  const renderErrors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => renderErrors.push(error),
  });

  try {
    useAppStore.setState({
      activeSessionId: "markdown-link-probe",
      page: "chat",
      settings: { ...initialState.settings, linkOpenTarget: "workpanel" },
      openUrlInWorkPanel: (url) => openedUrls.push(url),
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Markdown
            source="[#1106](([github.com](https://github.com/vastsa/PI-Desktop/issues/1106)))"
          />
        </I18nextProvider>,
      ),
    );

    const anchor = host.querySelector<HTMLAnchorElement>("a");
    assert(anchor, "wrapped Markdown destination did not render an anchor");
    assert(
      anchor.getAttribute("href") === destination,
      `wrapped Markdown destination rendered the wrong href: ${anchor.getAttribute("href")}`,
    );

    let clickWasPrevented = false;
    flushSync(() => {
      clickWasPrevented = !anchor.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert(clickWasPrevented, "plain link click was not handled by Markdown");
    assert(
      openedUrls[0] === destination,
      `plain link click opened ${openedUrls[0] ?? "nothing"}`,
    );

    let contextMenuWasPrevented = false;
    flushSync(() => {
      contextMenuWasPrevented = !anchor.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 80,
          clientY: 80,
        }),
      );
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    assert(contextMenuWasPrevented, "link context menu did not suppress the native menu");

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    assert(menu, "link context menu was not rendered");
    for (const [id, label] of [
      ["open-external", "Open in default browser"],
      ["open-workpanel", "Open in work panel"],
    ]) {
      const item = menu.querySelector<HTMLElement>(`[data-context-menu-item="${id}"]`);
      assert(item?.textContent?.includes(label), `link menu is missing ${label}`);
    }
    assert(renderErrors.length === 0, `Markdown render failed: ${renderErrors.map(String).join("; ")}`);
    return { ok: true, href: anchor.href, clickedUrl: openedUrls[0], menuItems: 3 };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState({
      activeSessionId: initialState.activeSessionId,
      page: initialState.page,
      settings: initialState.settings,
      openUrlInWorkPanel: initialState.openUrlInWorkPanel,
    });
  }
}

const createdAt = "2026-09-13T00:00:00.000Z";
const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({ id, role, content, createdAt, ...extra });

/** Real React DOM + production transcript components; no component/hook mocks. */
globalThis.transcriptRenderProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  // This probe asserts synchronous transcript projection and memoization. Keep
  // the presentation animation out of that contract so rAF timing cannot hide
  // the latest streaming fragment from the DOM assertion.
  useAppStore.setState({
    settings: {
      defaultMode: "agent",
      theme: "dark",
      enterToSend: true,
      onboardingDismissed: false,
      smoothStreaming: false,
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const renderErrors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      renderErrors.push(error);
    },
  });
  const render = (messages: UiMessage[]) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    assert(entry?.kind === "assistant-turn", "assistant turn missing");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <AssistantTurn entry={entry} isActive />
        </I18nextProvider>,
      ),
    );
    assert(
      renderErrors.length === 0,
      `React render failed: ${renderErrors.map(String).join("; ")}`,
    );
  };
  try {
    const groups = 100;
    let messages = [message("user", "user", "Inspect the workspace")];
    for (let index = 0; index < groups; index++) {
      messages.push(
        message(`tool-${index}`, "tool", "done", {
          toolName: "Bash",
          toolCallId: `call-${index}`,
          toolStatus: "success",
          toolArgs: { command: `printf step-${index}` },
          toolResult: { details: { stdout: "done", exitCode: 0 } },
        }),
      );
      messages.push(
        message(`answer-${index}`, "assistant", `Finished step ${index}.`),
      );
    }
    render(messages);
    globalThis.__activityGroupRenders = [];
    const startedAt = performance.now();
    for (let update = 0; update < 20; update++) {
      messages = [...messages];
      messages[messages.length - 1] = {
        ...messages.at(-1)!,
        content: `Streaming fragment ${update}`,
        status: "streaming",
      };
      render(messages);
    }
    const textUpdateRenders = globalThis.__activityGroupRenders.length;
    const textUpdateDurationMs = performance.now() - startedAt;
    assert(
      container.textContent?.includes("Streaming fragment 19"),
      `streaming tail did not update: ${container.textContent?.slice(-500)}, renders=${textUpdateRenders}`,
    );
    assert(
      textUpdateRenders === 0,
      `${groups} unchanged activity groups rendered ${textUpdateRenders} times across 20 text updates`,
    );

    globalThis.__activityGroupRenders = [];
    messages = [...messages];
    messages[1] = {
      ...messages[1],
      toolArgs: { command: "printf changed-command" },
    };
    render(messages);
    assert(
      globalThis.__activityGroupRenders.join(",") === "tool-0",
      "changed tool group did not render exactly once",
    );
    assert(
      container.textContent?.includes("changed-command"),
      "changed tool row not visible",
    );

    // Keep Task's own message stable: a later lifecycle result must still
    // update its terminal status and timing (#238), unlike unrelated text.
    const start = Date.now() - 12_000;
    const task = message("task", "tool", "started", {
      toolName: "Task",
      toolCallId: "task-call",
      toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Inspect a module" },
      toolResult: {
        details: {
          delegationId: "delegate",
          status: "running",
          startedAt: start,
        },
      },
    });
    let lifecycle = message("wait", "tool", "running", {
      toolName: "TaskWait",
      toolCallId: "wait-call",
      toolStatus: "success",
      toolResult: {
        details: {
          delegations: [
            { delegationId: "delegate", status: "running", startedAt: start },
          ],
        },
      },
    });
    const taskMessages = () => [
      message("user", "user", "Delegate"),
      task,
      message("between", "assistant", "Waiting"),
      lifecycle,
      message("tail", "assistant", "Continuing"),
    ];
    render(taskMessages());
    assert(
      container.querySelector(".has-subagents")?.classList.contains("active"),
      "running Task group is not active",
    );
    globalThis.__activityGroupRenders = [];
    lifecycle = {
      ...lifecycle,
      content: "completed",
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: "delegate",
              status: "completed",
              startedAt: start,
              completedAt: start + 2_000,
            },
          ],
        },
      },
    };
    render(taskMessages());
    assert(
      globalThis.__activityGroupRenders.includes("task"),
      "Task group ignored a lifecycle status update",
    );
    const topology = container.querySelector(".has-subagents");
    const taskDuration = () => container
      .querySelector(".has-subagents .subagent-activity-metrics")
      ?.textContent?.split("·").at(-1)?.trim();
    assert(
      taskDuration() === "2s",
      "Task completion timing did not update to 2s",
    );
    assert(
      !topology?.classList.contains("active"),
      "completed Task group is still active",
    );

    globalThis.__activityGroupRenders = [];
    lifecycle = {
      ...lifecycle,
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: "delegate",
              status: "completed",
              startedAt: start,
              completedAt: start + 4_000,
            },
          ],
        },
      },
    };
    render(taskMessages());
    assert(
      globalThis.__activityGroupRenders.includes("task"),
      "Task group ignored a timing-only update",
    );
    assert(
      taskDuration() === "4s",
      "Task completion timing did not update to 4s",
    );

    const statusLifecycle = await transcriptStatusProbe();
    const markdownLinks = await markdownLinkInteractionProbe(i18n);
    return {
      ok: statusLifecycle.ok && markdownLinks.ok,
      statusLifecycle,
      markdownLinks,
      groups,
      textUpdates: 20,
      textUpdateRenders,
      changedToolRenders: 1,
      taskLifecycleUpdated: true,
      taskTimingUpdated: true,
      turnProcess: await turnProcessProbe(),
      messageEditing: await transcriptEditProbe(),
      textUpdateDurationMs,
    };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
};

/**
 * Real `ChatTranscript` in a real viewport: the tail runtime status (issue
 * #323) must come and go without changing the geometry of the transcript that
 * is already on screen. The width scale, the indicator box and the reserved
 * lane all come from the app's built stylesheet, which the runner links into
 * this page. `.thread-wrap` only bounds its scroller inside a flex parent with
 * a real height, and the regression needs a transcript taller than that
 * viewport: pinned follow is what turns a content-height change into rows
 * moving under the user.
 */
globalThis.transcriptRuntimeSlotProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  host.setAttribute(
    "style",
    "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0",
  );
  document.body.append(host);
  const renderErrors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => {
      renderErrors.push(error);
    },
  });
  const failures: string[] = [];
  const check = (passed: boolean, message: string) => {
    if (!passed) failures.push(message);
  };
  const sessionId = "runtime-slot";
  const messages: UiMessage[] = [message("user", "user", "Inspect the workspace")];
  for (let index = 0; index < 8; index++) {
    messages.push(
      message(`tool-${index}`, "tool", "done", {
        toolName: "Bash",
        toolCallId: `call-${index}`,
        toolStatus: "success",
        toolArgs: { command: `printf step-${index}` },
        toolResult: { details: { stdout: "done", exitCode: 0 } },
      }),
    );
    messages.push(
      message(`answer-${index}`, "assistant", `Finished step ${index}.`),
    );
  }
  // A completed tool row does not finish the turn: the fallback remains until
  // the runtime reports the next phase or the turn reaches a terminal state.
  messages.push(
    message("tool-tail", "tool", "done", {
      toolName: "Bash",
      toolCallId: "call-tail",
      toolStatus: "success",
      toolArgs: { command: "printf tail" },
      toolResult: { details: { stdout: "done", exitCode: 0 } },
    }),
  );

  const frame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const content = () => host.querySelector<HTMLElement>(".thread-content");
  const scroller = () => host.querySelector<HTMLElement>(".thread-scroll");
  const lane = () =>
    host.querySelector<HTMLElement>(".transcript-runtime-status");
  // Bounded first commits, late row heights and the follow scroll all settle
  // over frames, so every comparison is made against settled geometry only. The
  // key carries the measured rows and the scroll extent, not just the content
  // height: two frames can share the height while the rows or the offset are
  // still moving.
  const settle = async () => {
    let previous = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      await frame();
      const rows = host.querySelectorAll<HTMLElement>(".message-row");
      const geometry = [
        content()?.offsetHeight,
        scroller()?.scrollTop,
        scroller()?.scrollHeight,
        rows[0]?.getBoundingClientRect().top,
        rows[rows.length - 1]?.getBoundingClientRect().bottom,
      ].join(":");
      if (geometry === previous) return;
      previous = geometry;
    }
  };
  const snapshots: string[] = [];
  const snapshot = () => {
    const rows = [...host.querySelectorAll<HTMLElement>(".message-row")];
    const element = lane();
    const measured = {
      contentHeight: content()?.getBoundingClientRect().height ?? null,
      scrollHeight: scroller()?.scrollHeight ?? null,
      scrollTop: scroller()?.scrollTop ?? null,
      firstRowTop: rows[0]?.getBoundingClientRect().top ?? null,
      lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom ?? null,
      lastTextBottom: [...host.querySelectorAll(".assistant-turn-fragment")]
        .at(-1)?.getBoundingClientRect().bottom ?? null,
      laneHeight: element?.getBoundingClientRect().height ?? null,
      laneChildren: element?.childElementCount ?? null,
      laneText: element?.textContent ?? null,
    };
    snapshots.push(JSON.stringify(measured));
    return measured;
  };
  type Snap = ReturnType<typeof snapshot>;
  const compare = (label: string, state: Snap, baseline: Snap) => {
    const fields = [
      "contentHeight",
      "scrollHeight",
      "scrollTop",
      "firstRowTop",
      "lastRowBottom",
    ] as const;
    for (const field of fields) {
      const before = baseline[field];
      const after = state[field];
      const moved =
        before === null || after === null ? Number.NaN : after - before;
      check(
        Math.abs(moved) <= 0.01,
        `${label}: ${field} moved by ${moved}px (${after} vs ${before})`,
      );
    }
  };
  let running = true;
  const paint = () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChatTranscript
          sessionId={sessionId}
          messages={messages}
          isRunning={running}
        />
      </I18nextProvider>,
    );
  const update = (activity: AgentActivity | undefined) =>
    flushSync(() => {
      useAppStore.setState({
        agentStatuses: {
          [sessionId]: {
            sessionId,
            isRunning: true,
            pendingToolConfirmations: 0,
            activity,
          },
        },
      });
      paint();
    });

  try {
    update(undefined);
    await settle();
    // The webfonts are only requested once application text is rendered, so the
    // baseline is taken after the swap: font metrics decide the row heights.
    await document.fonts.ready;
    await settle();
    const atRest = snapshot();
    check(
      atRest.laneChildren === 1,
      `the fallback status was missing: ${JSON.stringify(atRest)}`,
    );
    check(
      Boolean(host.querySelector('[data-testid="working-indicator"]')),
      "the running turn did not show the fallback status",
    );
    check(
      (atRest.laneHeight ?? 0) > 0,
      "the status lane did not reserve a slot at rest",
    );
    // A transcript that never scrolled would hide the shift this scenario is
    // about, because pinned follow moves the rows only through `scrollTop`.
    check(
      atRest.firstRowTop !== null && atRest.lastRowBottom !== null,
      "the fixture rendered no message row to measure",
    );
    check(
      (atRest.scrollTop ?? 0) > 0,
      `the fixture transcript is not scrolled to its own bottom: ${JSON.stringify(atRest)}`,
    );

    // The lane itself stays transparent in either theme; only its status
    // content is painted.
    for (const theme of ["dark", "light"]) {
      document.documentElement.dataset.theme = theme;
      await frame();
      const element = lane();
      if (!element) {
        check(false, `${theme}: the status lane is missing`);
        continue;
      }
      const style = getComputedStyle(element);
      check(
        style.backgroundColor === "rgba(0, 0, 0, 0)",
        `${theme}: the empty status lane painted a background (${style.backgroundColor})`,
      );
      check(
        style.borderTopWidth === "0px" && style.borderBottomWidth === "0px",
        `${theme}: the empty status lane drew a border`,
      );
      check(
        style.boxShadow === "none",
        `${theme}: the empty status lane drew a shadow`,
      );
      check(
        element.getBoundingClientRect().height > 0,
        `${theme}: the empty status lane lost its reserve`,
      );
    }
    document.documentElement.dataset.theme = "dark";

    update({ phase: "waiting-model", since: Date.now() });
    await settle();
    const waiting = snapshot();
    const activityIndicator = host.querySelector(
      '[data-testid="run-activity-indicator"]',
    );
    check(
      waiting.laneChildren === 1,
      `the waiting status did not take the reserved slot: ${JSON.stringify(waiting)}`,
    );
    check(Boolean(activityIndicator), "the waiting status row is missing");
    check(
      activityIndicator?.getAttribute("role") === "status" &&
        activityIndicator?.getAttribute("aria-live") === "polite",
      "the waiting status row lost its live-region semantics",
    );
    check(
      (waiting.laneText ?? "").trim().length > 0,
      "the waiting status row rendered no label",
    );
    compare("waiting for the model", waiting, atRest);

    update(undefined);
    await settle();
    const cleared = snapshot();
    check(
      cleared.laneChildren === 1,
      "clearing the phase removed the running indicator",
    );
    check(
      Boolean(host.querySelector('[data-testid="working-indicator"]')),
      "clearing the phase did not restore the fallback",
    );
    compare("status cleared", cleared, atRest);

    running = false;
    flushSync(paint);
    await settle();
    check(
      lane() === null,
      "an idle transcript still reserved the runtime status lane",
    );
    const compareEnd = (label: string, ended: Snap, active: Snap, pinned: boolean) => {
      // Ending restores the real toolbar; its height need not match the lane.
      // Unpinned readers must keep their text position despite that change.
      if (!pinned) {
        for (const field of ["scrollTop", "firstRowTop", "lastTextBottom"] as const) {
          const before = active[field];
          const after = ended[field];
          check(before !== null && after !== null && Math.abs(after - before) <= 0.01,
            `${label}: ${field} changed (${after} vs ${before})`);
        }
      }
      const element = scroller();
      if (pinned && element) {
        check(Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
          `${label}: lost pinned follow`);
      }
    };
    compareEnd("pinned turn ends", snapshot(), cleared, true);

    running = true;
    flushSync(paint);
    await settle();
    const scrollElement = scroller();
    if (scrollElement) {
      scrollElement.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scrollElement.scrollTop = Math.max(0, scrollElement.scrollTop - 120);
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    await settle();
    const reading = snapshot();
    check((reading.scrollTop ?? 0) < (cleared.scrollTop ?? 0), "fixture did not scroll up before stopping");
    running = false;
    flushSync(paint);
    await settle();
    compareEnd("scrolled-up turn ends", snapshot(), reading, false);
    check(
      renderErrors.length === 0,
      `React render failed: ${renderErrors.map(String).join("; ")}`,
    );

    return {
      ok: failures.length === 0,
      snapshots,
      idleLaneMounted: lane() !== null,
      failures,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState({ agentStatuses: {} });
  }
};

/** The real streaming hook must not commit above 60 Hz on a 120 Hz display. */
globalThis.smoothTextThrottleProbe = async () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  const commits: number[] = [];
  const sourceText = "streaming-fragment-".repeat(16);
  let nextFrameId = 0;
  let frameTime = performance.now();
  let updateSource: (value: string) => void = () => undefined;
  let lastText: string | null = null;

  window.requestAnimationFrame = (callback) => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
  };

  function SmoothTextFixture() {
    const [source, setSource] = useState("");
    updateSource = setSource;
    const visible = useSmoothText(source, source.length > 0, true);
    if (visible !== lastText) {
      lastText = visible;
      commits.push(frameTime);
    }
    return <div id="smooth-text-probe">{visible}</div>;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const yieldToEffects = () =>
    new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const flushFrame = (now: number) => {
    frameTime = now;
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    flushSync(() => {
      for (const callback of scheduled) callback(now);
    });
  };

  try {
    flushSync(() => root.render(<SmoothTextFixture />));
    await yieldToEffects();
    commits.length = 0;
    flushSync(() => updateSource(sourceText));
    await yieldToEffects();
    assert(callbacks.size > 0, "smooth text did not schedule its first frame");

    const start = performance.now();
    const frameInterval = 1000 / 120;
    for (let frame = 1; frame <= 360; frame += 1) {
      flushFrame(start + frame * frameInterval);
    }
    assert(
      host.textContent === sourceText,
      "smooth text did not reveal the complete streamed source",
    );
    assert(commits.length > 1, "smooth text did not reveal progressively");
    const gaps = commits.slice(1).map((time, index) => time - commits[index]);
    const minimumGapMs = Math.min(...gaps);
    assert(
      minimumGapMs >= 16.5,
      `smooth text committed faster than 60 Hz (${minimumGapMs.toFixed(2)}ms)`,
    );
    flushFrame(start + 361 * frameInterval);
    assert(callbacks.size === 0, "smooth text kept scheduling frames after catching up");
    return {
      ok: true,
      commits: commits.length,
      minimumGapMs,
      idleFramesAfterCatchUp: callbacks.size,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  }
};
