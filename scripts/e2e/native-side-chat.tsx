/**
 * Renderer half of the runnable native side-chat journey
 * (`pnpm test:e2e:native-side-chat`).
 *
 * Drives the real app store, real session/queue/events slices, the real
 * SideChatTab panel and the real SearchDialog over the real preload bridge.
 * The Electron main process hosts the real NativePiSessionService with the
 * real offline ModelRuntime and a bounded synthetic chunked stream; phase 2
 * runs after the main process rebuilds the service and the window reloads,
 * so a persisted child must be rediscovered from disk by a fresh renderer.
 */
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import {
  draftKeyForSession,
  readComposerDraft,
  writeComposerDraft,
} from "../../apps/desktop/src/lib/composer-draft-cache";
import { SideChatTab } from "../../apps/desktop/src/components/workpanel/SideChatTab";
import { SearchDialog } from "../../apps/desktop/src/components/SearchDialog";

// The production renderer initializes i18n in main.tsx; this probe renders the
// real components, so it must provide the same locale resources.
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: Object.fromEntries(
    Object.entries(catalogs).map(([lng, catalog]) => [
      lng,
      { translation: flattenCatalog(catalog as unknown as Record<string, unknown>) },
    ]),
  ),
  interpolation: { escapeValue: false },
});

type Check = { name: string; ok: boolean; detail?: string };
type ProbeResult = { ok: boolean; checks: Check[]; error?: string };

const bridge = (window as any).piDesktop;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  fn: () => T | undefined | false | null,
  timeout = 25_000,
  label = "probe",
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value as T;
    await sleep(40);
  }
  throw new Error(`${label} timeout after ${timeout}ms`);
}

function setValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function createChecks() {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
    if (!ok) throw new Error(name);
  };
  return { checks, check };
}

const panelHost = () => document.querySelector(".side-chat");
const composer = () => document.querySelector("form.side-chat-composer") as HTMLFormElement;
const textarea = () => document.querySelector("textarea.side-chat-input") as HTMLTextAreaElement;
const sideChatRow = (title: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(
    '.search-dialog button[role="option"][title]',
  )).find((row) => row.title === title);

type Phase2Input = {
  childId: string;
  parentId: string;
  projectPath: string;
  expectedIds: string[];
  abortedId: string;
  abortedPartial: string;
  parentHashBefore: string;
};

(globalThis as any).nativeSideChatProbePhase1 = async (): Promise<ProbeResult> => {
  const { checks, check } = createChecks();
  const rootElements: HTMLElement[] = [];
  const offAgentEvents = api.onAgentEvent((envelope) =>
    useAppStore.getState().handleAgentEvent(envelope),
  );
  try {
    const { sessions } = await api.listSessions();
    const parent = sessions.find(
      (session) => session.source === "pi-native" && String(session.title) === "hello",
    );
    check("native parent listed", Boolean(parent), JSON.stringify(sessions.map((s) => s.title)));
    const parentDetail = await api.getSession(parent!.id);
    check(
      "parent transcript loaded",
      (parentDetail.session?.messages?.length ?? 0) >= 2,
      String(parentDetail.session?.messages?.length),
    );
    useAppStore.setState({
      sessions,
      activeSessionId: parent!.id,
      activeProjectPath: parent!.projectPath,
      workspace: parent!.projectPath
        ? { path: parent!.projectPath, name: "fixture-project" }
        : null,
      messages: parentDetail.session!.messages!,
      page: "chat",
      runningSessions: {},
      sideChats: {},
      sideChatTranscripts: {},
      toasts: [],
      queuedPrompts: {},
    } as any);

    // The main conversation must survive every child operation untouched.
    const mainMessages = useAppStore.getState().messages;
    const mainNav = {
      page: useAppStore.getState().page,
      index: useAppStore.getState().navIndex,
      stack: JSON.stringify(useAppStore.getState().navStack),
    };
    const mainDraftKey = draftKeyForSession(parent!.id);
    writeComposerDraft(mainDraftKey, {
      text: "main draft sentinel",
      fileReferences: [],
    });

    const queueCalls: unknown[] = [];
    const originalQueuePrompt = api.queuePrompt;
    api.queuePrompt = (async (...args: unknown[]) => {
      queueCalls.push(args);
      throw new Error("native child must not use the Desktop queue");
    }) as typeof api.queuePrompt;

    // Concurrent clicks on one anchor share one open through the real slice.
    const sessionCountBefore = (await bridge.invoke("probe.sessionCount")).data.count;
    const [childId, secondChildId] = await Promise.all([
      useAppStore.getState().openSideChat("a1"),
      useAppStore.getState().openSideChat("a1"),
    ]);
    check("concurrent open shares one child", Boolean(childId) && childId === secondChildId, String(childId));
    const sessionCountAfter = (await bridge.invoke("probe.sessionCount")).data.count;
    check(
      "concurrent open publishes exactly one child file",
      sessionCountAfter === sessionCountBefore + 1,
      `${sessionCountBefore} -> ${sessionCountAfter}`,
    );
    const rows = () =>
      useAppStore.getState().sideChatTranscripts[childId!] ?? [];
    check("anchored history seeded whole", rows().length === 2, JSON.stringify(rows().map((r) => r.id)));
    const childSummary = () =>
      useAppStore.getState().sessions.find((session) => session.id === childId);
    check("child title is the side-chat title", String(childSummary()?.title).startsWith("Side chat"), String(childSummary()?.title));

    // First-user anchor: durable immediately, one user row, no assistant, and
    // no model request while the provider context comes from the parent.
    const promptCountBeforeFirstUser =
      (await bridge.invoke("probe.promptCount")).data.count;
    const firstUserId = await useAppStore.getState().openSideChat("u1");
    check("first-user side chat opened", Boolean(firstUserId) && firstUserId !== childId);
    const firstUserDetail = (await bridge.invoke("probe.detail", { id: firstUserId })).data.session;
    check(
      "first-user child is durable with only the user row",
      firstUserDetail.messageCount === 1 &&
        firstUserDetail.messages.filter((row: any) => row.role === "assistant").length === 0,
      JSON.stringify(firstUserDetail.messages.map((row: any) => [row.role, row.id])),
    );
    check(
      "first-user child inherits the parent saved model",
      firstUserDetail.providerId === "test-provider" && firstUserDetail.modelId === "test-model",
      JSON.stringify([firstUserDetail.providerId, firstUserDetail.modelId]),
    );
    const promptCountAfterFirstUser =
      (await bridge.invoke("probe.promptCount")).data.count;
    check(
      "first-user fork made no model request",
      promptCountAfterFirstUser === promptCountBeforeFirstUser,
      `${promptCountBeforeFirstUser} -> ${promptCountAfterFirstUser}`,
    );
    useAppStore.getState().closeSideChat(firstUserId!);
    await useAppStore.getState().refreshSessions();
    check(
      "first-user child stays listed after close",
      Boolean(useAppStore.getState().sessions.find((session) => session.id === firstUserId)),
    );

    const searchTitle = childSummary()!.title;

    const host = document.createElement("div");
    document.body.appendChild(host);
    rootElements.push(host);
    createRoot(host).render(<SideChatTab sessionId={childId!} />);
    await until(() => panelHost(), 25_000, "panel");
    await until(
      () => document.querySelector('.side-chat-thread')?.textContent?.includes('first answer'),
      25_000,
      "panel history",
    );
    check("panel paints the anchored answer", Boolean(
      document.querySelector('.side-chat-thread')?.textContent?.includes('first answer'),
    ));

    setValue(textarea(), "probe question");
    composer().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const sendOutcome = await until(() => {
      if (rows().some((row) => row.status === "streaming" && String(row.content).length > 0)) {
        return "streaming";
      }
      const failed =
        rows().some((row) => row.status === "error") ||
        useAppStore.getState().toasts.length > 0;
      return failed
        ? `failed:${JSON.stringify({
            rows: rows().map((row) => [row.role, row.status, row.error?.message]),
            toasts: useAppStore.getState().toasts.map((toast) => toast.message),
          })}`
        : false;
    }, 25_000, "send");
    check("reply streams progressively into the panel", sendOutcome === "streaming", sendOutcome);
    const streamingId = rows().find((row) => row.status === "streaming")!.id;
    const paintedWhileStreaming = await until(
      () => rows().some((row) => row.id === streamingId && row.status === 'streaming') &&
        Boolean(document.querySelector('.side-chat-thread')?.textContent?.includes('fixtu')),
      10_000,
      'partial reply DOM',
    );
    check('partial reply paints before settlement', paintedWhileStreaming);

    // A send while the child is running is rejected before the Desktop queue
    // and never overwrites text typed after the failed submission.
    setValue(textarea(), "typed while running");
    composer().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(
      () => useAppStore.getState().toasts.some((toast) => /still replying/.test(toast.message)),
      10_000,
      "busy toast",
    );
    await sleep(120);
    check("busy send keeps the newer draft", textarea().value === "typed while running", textarea().value);
    check("native send never used the Desktop queue", queueCalls.length === 0);

    await until(
      () => rows().some((row) => row.role === "assistant" && row.status === "complete" && row.id !== streamingId),
      25_000,
      "reply completion",
    );
    await until(() => !rows().some((row) => row.status === "streaming"), 10_000, "streaming settle");
    const assistantRows = rows().filter((row) => row.role === "assistant");
    check(
      "provisional row re-keyed to exactly one durable row",
      assistantRows.length === 2 && !assistantRows.some((row) => row.id === streamingId),
      JSON.stringify(rows().map((row) => [row.role, row.id, row.status])),
    );
    check(
      "durable user acknowledgement",
      rows().filter((row) => row.role === "user").length === 2,
      JSON.stringify(rows().map((row) => [row.role, row.id])),
    );
    const replyRow = assistantRows.at(-1)!;
    const questionRow = rows().find((row) => row.role === "user" && String(row.content).includes("probe question"))!;
    const parentBytes = await bridge.invoke("probe.parentBytes");
    check(
      "parent bytes unchanged after fork and turn",
      parentBytes.ok && parentBytes.data.hash === parentBytes.data.initial,
      JSON.stringify(parentBytes),
    );

    // Stop: the synthetic stream keeps the partial text it already produced,
    // so the aborted durable row must persist that text exactly once.
    setValue(textarea(), "probe stop");
    composer().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(
      () => rows().some((row) => row.status === "streaming" && String(row.content).length > 0),
      25_000,
      "stop stream",
    );
    await useAppStore.getState().abortSession(childId!);
    await until(() => !rows().some((row) => row.status === "streaming"), 15_000, "stop settle");
    check(
      "stop keeps the durable user row",
      rows().some((row) => row.role === "user" && String(row.content).includes("probe stop")),
      JSON.stringify(rows().map((row) => [row.role, row.content])),
    );
    const abortedRow = rows().find((row) => row.status === "aborted");
    check(
      "abort keeps the generated partial text",
      Boolean(abortedRow) && String(abortedRow!.content).trim().length > 0,
      JSON.stringify(rows().map((row) => [row.role, row.status, row.content])),
    );
    check(
      "aborted partial appears exactly once",
      rows().filter((row) => row.id === abortedRow!.id).length === 1,
      String(abortedRow!.id),
    );
    const stopRow = rows().find(
      (row) => row.role === "user" && String(row.content).includes("probe stop"),
    )!;

    // Delayed preflight failure: newer text typed while the send is awaiting
    // the transport must survive the failure restore.
    const originalPrompt = api.prompt;
    useAppStore.setState({ toasts: [] });
    let rejectionFinished = false;
    api.prompt = (async () => {
      await sleep(400);
      rejectionFinished = true;
      throw Object.assign(new Error("delayed preflight failure"), {
        code: "NATIVE_PI_PROVIDER_UNAVAILABLE",
      });
    }) as typeof api.prompt;
    setValue(textarea(), "first attempt");
    composer().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(120);
    setValue(textarea(), "typed during await");
    await until(
      () => rejectionFinished &&
        useAppStore.getState().toasts.some((toast) => toast.message === 'delayed preflight failure'),
      10_000,
      "delayed failure",
    );
    await sleep(120);
    check(
      "newer text typed during the await survives the failure",
      textarea().value === "typed during await",
      textarea().value,
    );
    api.prompt = originalPrompt;

    // Scoped global search: the child's own row, a negative query, and the
    // project label, not a document-wide substring.
    const searchHost = document.createElement("div");
    document.body.appendChild(searchHost);
    rootElements.push(searchHost);
    createRoot(searchHost).render(<SearchDialog open onClose={() => undefined} />);
    const searchInput = await until(
      () => document.querySelector("input.search-input") as HTMLInputElement | null,
      10_000,
      "search input",
    );
    setValue(searchInput!, "zzz");
    await until(() => searchInput.value === 'zzz' && !sideChatRow(searchTitle), 10_000, "negative query");
    check("negative query removes the child row", !sideChatRow(searchTitle));
    setValue(searchInput!, "side chat");
    await until(() => sideChatRow(searchTitle), 10_000, "title search");
    check("title search finds the scoped child row", Boolean(sideChatRow(searchTitle)));
    setValue(searchInput!, "zzz-again");
    await until(() => !sideChatRow(searchTitle), 10_000, "second negative query");
    setValue(searchInput!, "fixture-project");
    await until(() => sideChatRow(searchTitle), 10_000, "project search");
    check("project search finds the scoped child row", Boolean(sideChatRow(searchTitle)));

    // Main conversation, navigation and draft are untouched by child activity,
    // and close only drops the panel registration.
    check("main session still active", useAppStore.getState().activeSessionId === parent!.id);
    check("main transcript untouched", useAppStore.getState().messages === mainMessages);
    check(
      "main navigation untouched",
      useAppStore.getState().page === mainNav.page &&
        useAppStore.getState().navIndex === mainNav.index &&
        JSON.stringify(useAppStore.getState().navStack) === mainNav.stack,
      JSON.stringify(mainNav),
    );
    check(
      "main composer draft untouched",
      readComposerDraft(mainDraftKey)?.text === "main draft sentinel",
      JSON.stringify(readComposerDraft(mainDraftKey)),
    );

    useAppStore.getState().closeSideChat(childId!);
    check("close removes the panel registration", !useAppStore.getState().sideChats[childId!]);
    await useAppStore.getState().refreshSessions();
    const listedChild = () =>
      useAppStore.getState().sessions.find((session) => session.id === childId);
    check("child stays in the session list after close", Boolean(listedChild()));
    check(
      "child keeps its project label",
      listedChild()?.projectPath === parent!.projectPath,
      String(listedChild()?.projectPath),
    );

    // Wrong cases against the real service: foreign lease and long branch.
    const busy = await bridge.invoke("probe.forkBusy");
    check(
      "foreign lease blocks fork",
      busy.ok && busy.data.code === "NATIVE_PI_SESSION_BUSY",
      JSON.stringify(busy),
    );
    const long = await bridge.invoke("probe.forkLong");
    check(
      "long branch child returns the whole transcript",
      long.ok &&
        long.data.count === 520 &&
        long.data.hasMoreBefore === false &&
        long.data.messageStart === 0,
      JSON.stringify(long),
    );

    const freshParentBytes = await bridge.invoke("probe.parentBytes");
    check('parent bytes unchanged after every phase-one operation',
      freshParentBytes.ok && freshParentBytes.data.hash === parentBytes.data.initial,
    );
    const expectedIds = [
      "u1",
      "a1",
      questionRow.id,
      replyRow.id,
      stopRow.id,
      abortedRow!.id,
    ];
    api.queuePrompt = originalQueuePrompt;
    return {
      ok: true,
      checks,
      phase2: {
        childId: childId!,
        parentId: parent!.id,
        projectPath: parent!.projectPath,
        expectedIds,
        abortedId: abortedRow!.id,
        abortedPartial: String(abortedRow!.content),
        parentHashBefore: parentBytes.data.initial,
      },
    } as ProbeResult & { phase2: Phase2Input };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      checks,
    };
  } finally {
    offAgentEvents();
    for (const element of rootElements) element.remove();
  }
};

(globalThis as any).nativeSideChatProbePhase2 = async (
  input: Phase2Input,
): Promise<ProbeResult> => {
  const { checks, check } = createChecks();
  const offAgentEvents = api.onAgentEvent((envelope) =>
    useAppStore.getState().handleAgentEvent(envelope),
  );
  try {
    // A fresh renderer after a service restart and a window reload: the child
    // must be rediscovered from disk, not from any in-memory copy.
    const { sessions } = await api.listSessions();
    const child = sessions.find((session) => session.id === input.childId);
    check(
      "fresh renderer lists the durable child after service restart",
      Boolean(child),
      JSON.stringify(sessions.map((session) => [session.id, session.title]).slice(0, 6)),
    );
    check(
      "fresh child keeps title and project",
      String(child!.title).startsWith("Side chat") && child!.projectPath === input.projectPath,
      JSON.stringify([child!.title, child!.projectPath]),
    );
    useAppStore.setState({
      sessions,
      activeSessionId: input.parentId,
      activeProjectPath: input.projectPath,
      workspace: { path: input.projectPath, name: "fixture-project" },
      messages: [],
      retainedTranscripts: {},
      sideChatTranscripts: {},
      sideChats: {},
      toasts: [],
      runningSessions: {},
    } as any);
    await useAppStore.getState().selectSession(input.childId);
    await until(
      () =>
        useAppStore.getState().activeSessionId === input.childId &&
        !useAppStore.getState().selectingSessionId,
      25_000,
      "reopen selection",
    );
    const messages = useAppStore.getState().messages;
    check('fresh history has exactly the durable rows in order',
      JSON.stringify(messages.map((message) => message.id)) === JSON.stringify(input.expectedIds),
    );
    for (const id of input.expectedIds) {
      check(
        `durable row ${id} loads exactly once`,
        messages.filter((message) => message.id === id).length === 1,
        JSON.stringify(messages.map((message) => [message.role, message.id, message.status])),
      );
    }
    check("reopen has no provisional row", !messages.some((message) => message.status === "streaming"));
    const aborted = messages.filter((message) => message.id === input.abortedId);
    check(
      "aborted partial persisted once after reopen",
      aborted.length === 1 && String(aborted[0].content) === input.abortedPartial,
      JSON.stringify(aborted.map((message) => message.content)),
    );

    // Continue the reopened child through the real prompt path.
    const before = await api.getSession(input.childId);
    const accepted = await useAppStore.getState().sendPrompt(
      "post-restart continue",
      { text: "post-restart continue", fileReferences: [] },
      input.childId,
    );
    check("continue accepted after restart", accepted === true, String(accepted));
    const assistantBefore =
      before.session?.messages?.filter((row: any) => row.role === "assistant") ?? [];
    await until(() => {
      const state = useAppStore.getState();
      const running = state.runningSessions[input.childId] === true;
      const assistantCount = state.messages.filter((row) => row.role === "assistant").length;
      const failed =
        state.messages.some((row) => row.status === "error") || state.toasts.length > 0;
      return !running && (assistantCount > assistantBefore.length || failed);
    }, 25_000, "continued reply");
    await until(
      () => !useAppStore.getState().messages.some((row) => row.status === "streaming"),
      10_000,
      "continue settle",
    );
    const continued = useAppStore.getState().messages;
    const assistantAfter = continued.filter((row) => row.role === "assistant");
    check(
      "continued reply is one new durable assistant row",
      assistantAfter.length === assistantBefore.length + 1 &&
        !continued.some((row) => row.status === "streaming" || row.status === "error"),
      JSON.stringify(continued.map((row) => [row.role, row.id, row.status])),
    );
    const parentBytes = await bridge.invoke("probe.parentBytes");
    check(
      "parent bytes still unchanged after restart and continue",
      parentBytes.ok && parentBytes.data.hash === input.parentHashBefore,
      JSON.stringify(parentBytes),
    );
    return { ok: true, checks };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      checks,
    };
  } finally {
    offAgentEvents();
  }
};
