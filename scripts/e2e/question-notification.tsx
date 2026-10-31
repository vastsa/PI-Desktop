import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { AskToolRequest, Result, SessionSummary } from "@pi-desktop/shared";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { headAsk } from "../../apps/desktop/src/lib/pending-asks";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const createdAt = "2026-09-01T00:00:00Z";
const sessions: SessionSummary[] = ["A", "B"].map((id) => ({
  id, title: `Chat ${id}`, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
  messageCount: 1, projectPath: `C:/fixture/${id}`,
}));
const requests = new Map<string, AskToolRequest>();
const resolutions: unknown[] = [];
const unexpected: string[] = [];
let rejectReads = false;
let readCount = 0;
let sequence = 0;
const frame = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function until(predicate: () => boolean, message: string): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    const unsubscribe = useAppStore.subscribe(check);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out: ${message}; active=${useAppStore.getState().activeSessionId}`));
    }, 8_000);
    const cleanup = () => { clearTimeout(timer); unsubscribe(); observer.disconnect(); };
    check();
  });
}
function Surface() {
  const [toastAnchor, setToastAnchor] = useState<HTMLDivElement | null>(null);
  const active = useAppStore((state) => state.activeSessionId);
  const page = useAppStore((state) => state.page);
  const pending = useAppStore((state) => state.pendingAsks);
  const request = active ? headAsk(pending, active) : undefined;
  return <>
    <div
      aria-hidden
      style={{ position: "fixed", inset: 0, display: "flex", pointerEvents: "none" }}
    >
      <div id="toast-left-rail" style={{ flex: "0 0 0" }} />
      <div ref={setToastAnchor} id="toast-safe-area" style={{ flex: "0 0 640px" }} />
      <div style={{ flex: 1 }} />
    </div>
    <output id="active-chat">{page}:{active ?? "home"}</output>
    {request && <AskToolCard key={request.requestId} request={request} />}
    <ToastHost anchorElement={toastAnchor} />
  </>;
}
function reset(page: "chat" | "settings" = "chat", activeSessionId?: string) {
  requests.clear();
  flushSync(() => useAppStore.setState({
    page, activeSessionId, selectingSessionId: undefined, messages: [],
    toasts: [], pendingAsks: {}, workspace: undefined, activeProjectPath: undefined,
  }));
}
function ask(sessionId: string, question = "Which path should we take?") {
  const request: AskToolRequest = {
    sessionId, requestId: `ask-${++sequence}`, toolCallId: `tool-${sequence}`,
    questions: [{ question, options: ["Continue", "Cancel"] }],
  };
  requests.set(sessionId, request);
  flushSync(() => useAppStore.getState().handleAgentEvent({
    ts: Date.parse(createdAt),
    sessionId, turnId: `turn-${sequence}`, event: { type: "asktool_request", request },
  }));
  return request;
}
function action(sessionId: string) {
  const toasts = useAppStore.getState().toasts;
  const index = toasts.findIndex((item) => item.sessionId === sessionId);
  assert(index >= 0, `Missing toast target for session ${sessionId}`);
  const button = document.querySelectorAll(".toast")[index]
    ?.querySelector<HTMLButtonElement>("button:not(.toast-dismiss)");
  assert(button, "Question toast must expose a navigable button");
  return button;
}
async function selected(sessionId: string) {
  await until(() => useAppStore.getState().activeSessionId === sessionId &&
    useAppStore.getState().selectingSessionId === undefined &&
    document.getElementById("active-chat")?.textContent === `chat:${sessionId}` &&
    Boolean(document.querySelector(".asktool-card")), `destination chat ${sessionId} and pending question`);
  assert(useAppStore.getState().activeProjectPath === `C:/fixture/${sessionId}`, "Project did not follow the chat");
  assert(useAppStore.getState().messages[0]?.content === `Transcript ${sessionId}`, "Wrong conversation transcript");
}
function toastFollowsSafeArea(): boolean {
  const safeArea = document.getElementById("toast-safe-area");
  const viewport = document.querySelector<HTMLElement>(".toast-viewport");
  if (!safeArea || !viewport) return false;
  const safeRect = safeArea.getBoundingClientRect();
  const toastRect = viewport.getBoundingClientRect();
  const safeCenter = safeRect.left + safeRect.width / 2;
  const toastCenter = toastRect.left + toastRect.width / 2;
  return toastRect.left >= safeRect.left - 0.5 &&
    toastRect.right <= safeRect.right + 0.5 &&
    Math.abs(toastCenter - safeCenter) <= 0.5;
}

declare global {
  var questionNotificationProbe: () => Promise<unknown>;
  var prepareQuestionNotificationKeyboard: () => void;
  var finishQuestionNotificationKeyboard: () => Promise<void>;
}

globalThis.questionNotificationProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  window.piDesktop = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      const input = args[0];
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        readCount++;
        if (rejectReads) return { ok: false, error: { code: "FIXTURE_READ", message: "Fixture history unavailable" } };
        assert(input && typeof input === "object" && "id" in input, "Invalid session read");
        const session = sessions.find((item) => item.id === input.id);
        assert(session, "Unexpected session read");
        data = { session: { ...session, messages: [{ id: `message-${session.id}`, role: "user",
          content: `Transcript ${session.id}`, createdAt, status: "complete" }] } };
      } else if (channel === IPC.invoke.projectSet) {
        assert(typeof input === "string", "Invalid project activation");
        data = { workspace: { path: input, name: input.split("/").at(-1), branch: "main" } };
      } else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) {
        assert(input && typeof input === "object" && "sessionId" in input, "Invalid pending request");
        const request = requests.get(String(input.sessionId));
        data = { permissions: [], asks: request ? [request] : [] };
      } else if (channel === IPC.invoke.notificationShowNative) data = { shown: false };
      else if (channel === IPC.invoke.askToolResolve) { resolutions.push(input); data = { ok: true }; }
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      return { ok: true, data: data as T };
    },
  };
  useAppStore.setState({
    sessions, notifications: [], runningSessions: {}, retainedSessionIds: [], retainedTranscripts: {},
    pendingPlans: {}, pendingPermissions: {}, providers: [], providerModels: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface /></I18nextProvider>));
  await until(() => Boolean(document.querySelector(".toast-viewport")), "toast host");

  // Start at the empty New task surface, as in the reported screenshot.
  reset();
  const request = ask("B");
  const originalToastId = useAppStore.getState().toasts[0]?.id;
  await until(toastFollowsSafeArea, "question toast stays inside the main-content safe area");
  const safeArea = document.getElementById("toast-safe-area");
  assert(safeArea, "Missing toast safe area");
  safeArea.style.flexBasis = "520px";
  await until(toastFollowsSafeArea, "question toast follows the resized main-content safe area");
  const leftRail = document.getElementById("toast-left-rail");
  assert(leftRail, "Missing toast safe-area left rail");
  leftRail.style.flexBasis = "120px";
  await until(toastFollowsSafeArea, "question toast follows a shifted main-content safe area");
  assert(useAppStore.getState().activeSessionId === undefined, "Receipt must not navigate automatically");
  action("B").click();
  assert(useAppStore.getState().toasts.some((item) => item.id === originalToastId),
    "Question toast disappeared before navigation succeeded");
  await selected("B");
  await until(() => !useAppStore.getState().toasts.some((item) => item.id === originalToastId),
    "successful navigation dismisses the original toast");
  const option = document.querySelector<HTMLButtonElement>(".asktool-option");
  assert(option, "Pending question is not answerable");
  flushSync(() => option.click());
  const submit = document.querySelector<HTMLButtonElement>(".asktool-card-header-actions .btn-primary");
  assert(submit, "Missing submit action");
  submit.click();
  await until(() => resolutions.length === 1, "answer reaches the host");
  assert(JSON.stringify(resolutions[0]) === JSON.stringify({
    requestId: request.requestId, sessionId: "B", answers: [["Continue"]],
  }), "Answer resolved the wrong request");

  // Same text in different chats must retain both destinations.
  reset("chat", "A");
  ask("A"); ask("B");
  assert(useAppStore.getState().toasts.length === 2, "Different sessions must not deduplicate each other");
  const previous = useAppStore.getState().toasts.find((item) => item.sessionId === "A")?.id;
  ask("A");
  assert(useAppStore.getState().toasts.length === 2 &&
    !useAppStore.getState().toasts.some((item) => item.id === previous), "Same-session repeat did not replace its toast");
  action("B").click();
  await selected("B");
  action("A").click();
  await selected("A");

  // Dismiss and text selection are not activation gestures.
  reset("settings");
  ask("B");
  const reads = readCount;
  const target = action("B");
  const message = target.querySelector(".toast-message");
  assert(message, "Missing selectable message");
  const range = document.createRange(); range.selectNodeContents(message);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  target.click();
  await frame();
  assert(readCount === reads, "Selecting toast text must not navigate");
  window.getSelection()?.removeAllRanges();
  const dismiss = document.querySelector<HTMLButtonElement>(".toast-dismiss");
  assert(dismiss, "Missing dismiss control");
  dismiss.click();
  await until(() => useAppStore.getState().toasts.length === 0, "dismiss animation");
  assert(readCount === reads && useAppStore.getState().page === "settings", "Dismiss unexpectedly navigated");

  // Controlled timers prove focus/hover transitions never duplicate the countdown.
  reset();
  const browser: Window = window;
  const originalSetTimeout = browser.setTimeout;
  const originalClearTimeout = browser.clearTimeout;
  const timers = new Map<number, TimerHandler>();
  let timerId = -1;
  const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement");
  let activeElement = document.activeElement;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
  browser.setTimeout = (handler) => { timers.set(--timerId, handler); return timerId; };
  browser.clearTimeout = (id) => {
    if (id === undefined || !timers.delete(id)) originalClearTimeout(id);
  };
  try {
    flushSync(() => useAppStore.getState().showToast("Focus timer", { sessionId: "B", sound: false }));
    assert(Array.from(timers).length === 1, "Toast should own one countdown");
    const focused = action("B");
    // Control DOM focus events here; the OS may keep the isolated Electron
    // window behind another app. Return and Space still use native input below.
    activeElement = focused;
    flushSync(() => focused.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body })));
    assert(Array.from(timers).length === 0, "Focus did not pause the countdown");
    focused.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    assert(Array.from(timers).length === 0, "Mouse leave restarted a keyboard-focused countdown");
    activeElement = document.body;
    flushSync(() => focused.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })));
    assert(Array.from(timers).length === 1, "Blur did not resume the countdown");
    reset();
    assert(Array.from(timers).length === 0, "Unmount left a countdown behind");
  } finally {
    browser.setTimeout = originalSetTimeout;
    browser.clearTimeout = originalClearTimeout;
    if (activeElementDescriptor) Object.defineProperty(document, "activeElement", activeElementDescriptor);
    else Reflect.deleteProperty(document, "activeElement");
  }

  reset();
  flushSync(() => useAppStore.getState().showToast("Ordinary information", { sound: false, duration: 0 }));
  assert(!document.querySelector(".toast button:not(.toast-dismiss)"), "Ordinary toast became interactive");

  // Failures remain visible and the question stays pending.
  reset();
  ask("B"); rejectReads = true;
  const failedToastId = useAppStore.getState().toasts[0]?.id;
  action("B").click();
  await until(() => useAppStore.getState().toasts.some((item) => item.variant === "error" &&
    item.message.includes("Fixture history unavailable")), "navigation failure feedback");
  rejectReads = false;
  assert(headAsk(useAppStore.getState().pendingAsks, "B"), "Navigation failure discarded the pending question");
  assert(useAppStore.getState().toasts.some((item) => item.id === failedToastId),
    "Navigation failure discarded the original question reminder");
  action("B").click();
  await selected("B");
  await until(() => !useAppStore.getState().toasts.some((item) => item.id === failedToastId),
    "successful retry dismisses the retained reminder");
  assert(unexpected.length === 0, `Unexpected IPC: ${unexpected}`);

  // The runner delivers real Chromium keyboard events after focusing the action.
  globalThis.prepareQuestionNotificationKeyboard = () => {
    reset("settings");
    ask("B", "Keyboard question");
    action("B").focus();
    assert(document.activeElement === action("B"), "Question action is not focusable");
  };
  globalThis.finishQuestionNotificationKeyboard = async () => {
    await selected("B");
    assert(unexpected.length === 0, `Unexpected IPC: ${unexpected}`);
  };
  return { ok: true, home: true, safeArea: true, safeAreaResize: true,
    safeAreaShift: true, crossProject: true, answered: true, distinctTargets: true,
    dismiss: true, textSelection: true, focusTimer: true, ordinaryToast: true,
    errorFeedback: true, retry: true };
};
