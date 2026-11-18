import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { AskToolRequest, Result, SessionSummary, ToolPermissionRequest } from "@pi-desktop/shared";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { NotificationCenter } from "../../apps/desktop/src/components/NotificationCenter";
import { PermissionCard } from "../../apps/desktop/src/components/PermissionCard";
import { headAsk } from "../../apps/desktop/src/lib/pending-asks";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const createdAt = "2026-09-01T00:00:00Z";
const sessions: SessionSummary[] = ["A", "B", "C"].map((id) => ({
  id, title: `Chat ${id}`, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt,
  messageCount: 1, projectPath: id === "C" ? undefined : `C:/fixture/${id}`,
}));
const requests = new Map<string, AskToolRequest>();
const resolutions: unknown[] = [];
const history = new Map<string, import("@pi-desktop/shared").AppNotification>();
const permissions = new Map<string, ToolPermissionRequest[]>();
const approvals: unknown[] = [];
let rejectApproval = false;
const acknowledged: string[] = [];
const unexpected: string[] = [];
let rejectReads = false;
let readCount = 0;
let sequence = 0;
let notificationListGate: Promise<void> | undefined;

function pauseNotificationLists() {
  let resume = () => {};
  notificationListGate = new Promise<void>((resolve) => { resume = resolve; });
  return () => { notificationListGate = undefined; resume(); };
}
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
  const permissionQueues = useAppStore((state) => state.pendingPermissions);
  const permission = active ? permissionQueues[active]?.[0] : undefined;
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
    <NotificationCenter />
    {request && <AskToolCard key={request.requestId} request={request} />}
    {permission && <PermissionCard key={permission.requestId} permission={permission} />}
    <ToastHost anchorElement={toastAnchor} />
  </>;
}
function reset(page: "chat" | "settings" = "chat", activeSessionId?: string) {
  requests.clear();
  history.clear();
  permissions.clear();
  flushSync(() => useAppStore.setState({
    page, activeSessionId, selectingSessionId: undefined, messages: [],
    toasts: [], pendingAsks: {}, workspace: undefined, activeProjectPath: undefined,
    notifications: [], unreadNotificationCount: 0, dismissedNotificationRequests: {},
    pendingPermissions: {},
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
        data = { permissions: permissions.get(String(input.sessionId)) ?? [], asks: request ? [request] : [] };
      } else if (channel === IPC.invoke.notificationShowNative) data = { shown: false };
      else if (channel === IPC.invoke.appGetOnboarding) data = { showChecklist: false, steps: [] };
      else if (channel === IPC.invoke.askToolResolve) {
        resolutions.push(input);
        if (input && typeof input === "object" && "sessionId" in input) requests.delete(String(input.sessionId));
        data = { ok: true };
      } else if (channel === IPC.invoke.toolResolvePermission) {
        approvals.push(input);
        if (rejectApproval) return { ok: false, error: { code: "FIXTURE_APPROVAL", message: "Fixture approval unavailable" } };
        assert(input && typeof input === "object" && "requestId" in input, "Invalid approval response");
        for (const [id, queue] of permissions) permissions.set(id, queue.filter((item) => item.requestId !== input.requestId));
        data = { ok: true };
      } else if (channel === IPC.invoke.notificationList) {
        await notificationListGate;
        data = { notifications: [...history.values()],
          unreadCount: [...history.values()].filter((row) => !row.readAt).length };
      } else if (channel === IPC.invoke.notificationMarkRead) {
        if (input && typeof input === "object" && "id" in input) {
          const id = String(input.id);
          acknowledged.push(id);
          const row = history.get(id);
          if (row) history.set(id, { ...row, readAt: createdAt });
        }
        data = { ok: true };
      } else if (channel === IPC.invoke.notificationMarkAllRead) {
        for (const [id, row] of history) history.set(id, { ...row, readAt: createdAt });
        data = { ok: true };
      } else if (channel === IPC.invoke.notificationClear) {
        history.clear(); data = { ok: true };
      } else if (channel === IPC.invoke.projectClear) data = { ok: true };
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      return { ok: true, data: data as T };
    },
  };
  useAppStore.setState({
    sessions, notifications: [], runningSessions: {}, retainedSessionIds: [], retainedTranscripts: {},
    ready: true,
    projectMeta: { "C:/fixture/B": { name: "Research" } },
    pendingPlans: {}, pendingPermissions: {}, providers: [], providerModels: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface /></I18nextProvider>));
  await until(() => Boolean(document.querySelector(".toast-viewport")), "toast host");

  // Start at the empty New task surface, as in the reported screenshot.
  reset();
  ask("B");
  assert(document.querySelector(".notification-badge")?.textContent === "1", "Missing badge for an unread question");
  const resumeQuestionRefresh = pauseNotificationLists();
  try {
    flushSync(() => document.querySelector<HTMLButtonElement>(".notification-trigger")?.click());
    const question = document.querySelector<HTMLButtonElement>(".notification-question");
    assert(question && !question.disabled, "Question must be clickable before notification refresh completes");
    assert(question.textContent?.includes("Research"), "Owning project name is missing");
    question.click();
    await selected("B");
    assert(document.querySelector(".notification-badge")?.textContent === "1", "Opening chat incorrectly acknowledged its question");
  } finally { resumeQuestionRefresh(); }
  await frame();
  reset();
  const toastRequest = ask("B");
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
    requestId: toastRequest.requestId, sessionId: "B", answers: [["Continue"]],
  }), "Answer resolved the wrong request");
  await until(() => !document.querySelector(".notification-badge"), "submitted answer clears its unread badge contribution");

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
  const verifyApprovalNotifications = async () => {
    // Every real permission request stays actionable; navigation is never approval.
    reset();
    const permissionFor = (sessionId: string) => {
      const request: ToolPermissionRequest = { sessionId, requestId: `permission-${++sequence}`,
        toolCallId: `permission-tool-${sequence}`, toolName: "Bash", argsPreview: { command: "echo fixture" },
        risk: "high", reason: "Fixture approval" };
      permissions.set(sessionId, [...(permissions.get(sessionId) ?? []), request]);
      flushSync(() => useAppStore.getState().handleAgentEvent({ ts: Date.parse(createdAt), sessionId,
        turnId: `permission-turn-${sequence}`, event: { type: "tool_permission_request", request } }));
      return request;
    };
    const firstApproval = permissionFor("B");
    const nextApproval = permissionFor("B");
    const otherApproval = permissionFor("A");
    const resumeApprovalRefresh = pauseNotificationLists();
    try {
      flushSync(() => document.querySelector<HTMLButtonElement>(".notification-trigger")?.click());
      assert(document.querySelectorAll(".notification-permission").length === 3, "Permission notification items are missing");
      assert(document.querySelector(".notification-badge")?.textContent === "3", "Unread permission requests are missing from the total badge");
      const permission = document.querySelector<HTMLButtonElement>(`[data-permission-id="${firstApproval.requestId}"]`);
      assert(permission && !permission.disabled, "Permission must be clickable before notification refresh completes");
      document.querySelectorAll<HTMLButtonElement>(".notification-filter")[1]?.click();
      await until(() => document.querySelectorAll(".notification-permission").length === 3 &&
        !document.querySelector(".notification-empty"), "unread keeps approvals pending");
      permission.click();
      await until(() => useAppStore.getState().activeSessionId === "B" &&
        !useAppStore.getState().selectingSessionId && Boolean(document.querySelector(".permission-card")), "approval notification destination");
      assert(useAppStore.getState().activeProjectPath === "C:/fixture/B", "Approval notification opened the wrong project");
      assert(approvals.length === 0 && useAppStore.getState().pendingPermissions.B?.length === 2, "Opening a notification approved a permission");
      assert(document.querySelector(".notification-badge")?.textContent === "3", "Opening a permission notification removed its badge");
    } finally { resumeApprovalRefresh(); }
    document.querySelector<HTMLButtonElement>(".notification-trigger")!.click();
    await until(() => document.querySelectorAll(".notification-permission.unread").length === 3,
      "navigation retains every unresolved approval reminder and unread state");
    document.querySelector<HTMLButtonElement>(`[data-permission-id="${firstApproval.requestId}"]`)!.click();
    const decision = (label: string) => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".permission-card-actions button"))
        .find((item) => item.textContent?.trim() === label);
      assert(button, `Missing approval decision ${label}`);
      return button;
    };
    rejectApproval = true;
    decision(i18n.t("permission.allowOnce")).click();
    await until(() => useAppStore.getState().toasts.some((item) => item.message.includes("Fixture approval unavailable")), "approval failure feedback");
    assert(useAppStore.getState().pendingPermissions.B?.[0]?.requestId === firstApproval.requestId, "Failed approval discarded the request");
    assert(document.querySelector(".notification-badge")?.textContent === "3", "Failed approval removed its badge");
    rejectApproval = false;
    await until(() => Boolean(document.querySelector(".permission-card-actions .btn-primary:not(:disabled)")), "approval retry enabled");
    decision(i18n.t("permission.allowOnce")).click();
    await until(() => useAppStore.getState().pendingPermissions.B?.[0]?.requestId === nextApproval.requestId &&
      Boolean(document.querySelector(".permission-card-actions .btn-primary:not(:disabled)")), "first permission approved only once");
    await until(() => document.querySelector(".notification-badge")?.textContent === "2", "accepted approval removes only its own badge contribution");
    assert(useAppStore.getState().pendingPermissions.A?.[0]?.requestId === otherApproval.requestId, "Approving B discarded A's permission");
    decision(i18n.t("permission.deny")).click();
    await until(() => !useAppStore.getState().pendingPermissions.B, "denial resolves only the second permission");
    await until(() => document.querySelector(".notification-badge")?.textContent === "1", "denial removes only its own badge contribution");
    document.querySelector<HTMLButtonElement>(".notification-trigger")?.click();
    await until(() => document.querySelectorAll(".notification-permission").length === 1 &&
      Boolean(document.querySelector(".notification-permission:not(:disabled)")), "only the unprocessed approval remains in inbox");
    document.querySelector<HTMLButtonElement>(".notification-permission")?.click();
    await until(() => useAppStore.getState().activeSessionId === "A" && !useAppStore.getState().selectingSessionId &&
      Boolean(document.querySelector(".permission-card")), "other approval destination");
    decision(i18n.t("permission.allowOnce")).click();
    await until(() => Object.keys(useAppStore.getState().pendingPermissions).length === 0, "all explicit decisions completed");
    await until(() => !document.querySelector(".notification-badge"), "completed approvals clear their badge");

    // Bulk read removes reminders, never the underlying decision cards.
    reset();
    history.clear();
    flushSync(() => useAppStore.setState({ notifications: [], unreadNotificationCount: 0 }));
    const bulkApproval = permissionFor("B");
    const bulkQuestion = ask("B", "Bulk-read question");
    const approvalsBeforeBulk = approvals.length;
    const answersBeforeBulk = resolutions.length;
    document.querySelector<HTMLButtonElement>(".notification-trigger")!.click();
    await until(() => document.querySelectorAll(".notification-item").length === 2, "mixed decision reminders visible");
    document.querySelector<HTMLButtonElement>('[aria-label="Mark all as read"]')!.click();
    await until(() => !document.querySelector(".notification-item") && !document.querySelector(".notification-badge"),
      "bulk-read removes permission and question reminders together with the badge");
    assert(permissions.get("B")?.[0]?.requestId === bulkApproval.requestId && requests.get("B")?.requestId === bulkQuestion.requestId,
      "Bulk-read settled an underlying decision");
    assert(approvals.length === approvalsBeforeBulk && resolutions.length === answersBeforeBulk, "Bulk-read submitted an approval or answer");
    await useAppStore.getState().refreshNotificationAttention();
    for (const tab of document.querySelectorAll<HTMLButtonElement>(".notification-filter")) {
      flushSync(() => tab.click());
      assert(!document.querySelector(".notification-item") && !document.querySelector(".notification-badge"), "Read decision reminders reappeared in a filter");
    }
    flushSync(() => document.querySelector<HTMLButtonElement>(".notification-trigger")!.click());
    flushSync(() => document.querySelector<HTMLButtonElement>(".notification-trigger")!.click());
    await until(() => Boolean(document.querySelector(".notification-empty")), "bulk-read stays empty after reopening");
    const freshApproval = permissionFor("A");
    await until(() => document.querySelector(".notification-badge")?.textContent === "1" &&
      document.querySelectorAll(".notification-permission.unread").length === 1, "new approval is not hidden by an earlier bulk read");
    document.querySelector<HTMLButtonElement>(`[data-permission-id="${freshApproval.requestId}"]`)!.click();
    await until(() => useAppStore.getState().activeSessionId === "A" && !useAppStore.getState().selectingSessionId &&
      Boolean(document.querySelector(".permission-card")), "fresh approval destination");
    assert(document.querySelector(".notification-badge")?.textContent === "1", "Fresh approval navigation changed its unread state");
    decision(i18n.t("permission.allowOnce")).click();
    await until(() => !document.querySelector(".notification-badge"), "fresh approval completion removes its reminder contribution");
  };
  // Bulk acknowledgement settles reminders without answering asks or approving tools.
  reset();
  const unanswered = ask("B");
  let done: import("@pi-desktop/shared").AppNotification = {
    id: "completion-C", sessionId: "C", sessionTitle: "C", kind: "task.completed",
    turnId: "turn-C", createdAt,
  };
  const addCompletion = () => {
    done = { ...done, id: `completion-C-${++sequence}`, turnId: `turn-C-${sequence}`,
      createdAt: new Date(Date.now() + sequence).toISOString() };
    history.set(done.id, done);
    flushSync(() => useAppStore.getState().receiveNotification(done));
  };
  addCompletion();
  history.set("original-failure", { ...done, id: "original-failure", kind: "task.failed", errorCode: "ORIGINAL_ERROR" });
  flushSync(() => useAppStore.setState({ notifications: [...history.values()], unreadNotificationCount: 2 }));
  const openBell = async () => {
    if (!document.querySelector(".notification-popover")) document.querySelector<HTMLButtonElement>(".notification-trigger")?.click();
    await until(() => Boolean(document.querySelector(".notification-completion:not(:disabled)")), "completion inbox");
  };
  await openBell();
  assert(document.querySelector(".notification-completion")?.textContent?.includes("Chat C"), "Completion displays an ID instead of the current title");
  assert(document.querySelector(".notification-list")?.textContent?.includes("ORIGINAL_ERROR"), "Original failure text was lost");
  const icons = [".notification-question", ".notification-completion", ".notification-kind-icon.failed"]
    .map((selector) => document.querySelector(`${selector} svg`)?.innerHTML);
  assert(icons.every(Boolean) && new Set(icons).size === 3, "Question, completion, and failure icons must be distinct");
  assert(document.querySelectorAll(".notification-badge").length === 1 &&
    document.querySelector(".notification-badge")?.textContent === "3", "Questions, completions, and failures must share one deduplicated total badge");
  const badgeRect = document.querySelector(".notification-badge")!.getBoundingClientRect();
  const bellRect = document.querySelector(".notification-trigger")!.getBoundingClientRect();
  assert(badgeRect.top < bellRect.top && badgeRect.right >= bellRect.right, "Question badge is not at the top-right");
  const markAll = () => document.querySelector<HTMLButtonElement>('[aria-label="Mark all as read"]');
  assert(!markAll()?.disabled, "Unread completions must enable mark-all through ordinary history");
  markAll()!.click();
  await until(() => !useAppStore.getState().notifications.some((item) => item.kind === "task.completed" && !item.readAt) &&
    !document.querySelector(".notification-completion"), "bulk-read completion removed without navigation");
  await until(() => !document.querySelector(".notification-item") && !document.querySelector(".notification-badge"), "mark-all removes every notice, not just its unread styling");
  assert(requests.get("B")?.requestId === unanswered.requestId, "Mark-all must not answer the pending question");
  assert(!acknowledged.includes(done.id), "Bulk-read must not issue individual acknowledgements");
  assert(useAppStore.getState().notifications.some((item) => item.id === "original-failure" && item.readAt), "Bulk-read deleted durable task history");
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".notification-filter")) {
    flushSync(() => tab.click());
    assert(!document.querySelector(".notification-item"), "Read notifications remain visible in a filter");
  }
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Surface key="rebuilt-sidebar" /></I18nextProvider>));
  await useAppStore.getState().refreshNotificationAttention();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  assert(!document.querySelector(".notification-badge"), "Rebuilding the sidebar restored a dismissed reminder");
  flushSync(() => document.querySelector<HTMLButtonElement>(".notification-trigger")!.click());
  assert(!document.querySelector(".notification-item"), "Rebuilding the sidebar restored dismissed rows");
  const freshQuestion = ask("A", "New question after bulk read");
  await until(() => document.querySelector(".notification-badge")?.textContent === "1" &&
    Boolean(document.querySelector(`[data-request-id="${freshQuestion.requestId}"].unread:not(:disabled)`)), "new question restores its notice and badge after bulk read");
  document.querySelector<HTMLButtonElement>(`[data-request-id="${freshQuestion.requestId}"]`)!.click();
  await selected("A");
  assert(document.querySelector(".notification-badge")?.textContent === "1", "Question navigation changed its unread state after bulk read");
  document.querySelector<HTMLButtonElement>(".notification-trigger")!.click();
  await until(() => Boolean(document.querySelector(`[data-request-id="${freshQuestion.requestId}"].unread`)), "unanswered question remains in the notification list");
  flushSync(() => document.querySelector<HTMLButtonElement>(".asktool-option")!.click());
  document.querySelector<HTMLButtonElement>(".asktool-card-header-actions .btn-primary")!.click();
  await until(() => !document.querySelector(".notification-question") && !document.querySelector(".notification-badge"), "answering removes the question and badge together");
  addCompletion();
  await until(() => Boolean(document.querySelector(".notification-completion:not(:disabled)")) && !markAll()?.disabled &&
    document.querySelector(".notification-badge")?.textContent === "1", "new completion restores the total badge and re-enables mark-all");
  document.querySelector<HTMLButtonElement>('[aria-label="Clear all"]')!.click();
  await until(() => useAppStore.getState().notifications.length === 0 && !document.querySelector(".notification-question"), "clear removes all reminders");
  assert(requests.get("B")?.requestId === unanswered.requestId, "Clear must not cancel the pending question");
  await useAppStore.getState().refreshNotificationAttention();
  assert(!document.querySelector(".notification-completion"), "Cleared completion resurrected after refresh");
  const afterClearQuestion = ask("A", "New question after clear");
  await until(() => document.querySelector(".notification-badge")?.textContent === "1" &&
    Boolean(document.querySelector(`[data-request-id="${afterClearQuestion.requestId}"].unread:not(:disabled)`)), "clear does not hide a future question");
  document.querySelector<HTMLButtonElement>('[aria-label="Clear all"]')!.click();
  await until(() => !document.querySelector(".notification-item") && !document.querySelector(".notification-badge"), "clear removes the fresh question reminder without answering it");
  addCompletion();
  await openBell();
  rejectReads = true;
  document.querySelector<HTMLButtonElement>(".notification-completion")!.click();
  await until(() => useAppStore.getState().toasts.some((item) => item.variant === "error"), "failed completion navigation");
  assert(history.get(done.id)?.readAt === undefined, "Failed navigation confirmed the task result");
  await useAppStore.getState().refreshNotifications();
  assert(!acknowledged.includes(done.id), "Failed navigation acknowledged the completion before loading");
  assert(history.get(done.id)?.readAt === undefined, "Refreshing after failed navigation removed its reminder");
  rejectReads = false;
  await openBell();
  document.querySelector<HTMLButtonElement>(".notification-completion")!.click();
  await until(() => useAppStore.getState().activeSessionId === "C" &&
    !useAppStore.getState().selectingSessionId, "completion destination loaded");
  const focusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  try {
    window.dispatchEvent(new Event("focus"));
    await until(() => acknowledged.includes(done.id) && Boolean(useAppStore.getState().notifications.find((item) => item.id === done.id)?.readAt),
      "viewing a completion acknowledges its exact notification");
  } finally {
    if (focusDescriptor) Object.defineProperty(document, "hasFocus", focusDescriptor);
    else Reflect.deleteProperty(document, "hasFocus");
  }
  await verifyApprovalNotifications();
  assert(unexpected.length === 0, `Unexpected IPC: ${unexpected}`);

  // The runner delivers real Chromium keyboard events after focusing the action.
  globalThis.prepareQuestionNotificationKeyboard = async () => {
    reset("settings");
    ask("B", "Keyboard question");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
    errorFeedback: true, retry: true, persistentQuestionBadge: true, completionViewed: true, bulkAcknowledgement: true,
    topRightBadge: true, distinctNotificationIcons: true, notificationContextLabels: true,
    approvalNavigation: true, approvalFailureRetry: true, approvalLifecycle: true };
};
