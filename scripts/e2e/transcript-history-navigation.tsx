import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@pi-desktop/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { getTranscriptReadingPosition } from "../../apps/desktop/src/lib/transcript-reading-position";

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 8000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Real history navigation: ${label}`);
    await frame();
  }
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Real history navigation: ${label}`);
}

declare global { var transcriptHistoryNavigationProbe: (reducedOnly?: boolean) => Promise<unknown>; }
globalThis.transcriptHistoryNavigationProbe = async (reducedOnly = false) => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const originalState = useAppStore.getState();
  const originalBridge = window.piDesktop;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ds-bg-primary)";
  document.body.append(host);
  const root = createRoot(host);
  const createdAt = "2026-11-04T00:00:00Z";
  let id = "";
  let data: UiMessage[] = [];
  let summary: SessionSummary;
  let pending: { resolve: (value: unknown) => void; response: unknown }[] = [];
  const reads: number[] = [];
  const unexpected: string[] = [];
  let deferSearch = false;
  let searchRead: { resolve: (value: unknown) => void } | undefined;
  window.piDesktop = { channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let value: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0];
        assert(input && typeof input === "object" && "id" in input && input.id === id, "unexpected session request");
        const before = "messageBefore" in input && typeof input.messageBefore === "number" ? input.messageBefore : undefined;
        const end = before === undefined ? data.length : Math.min(data.length, before);
        const limit = before === undefined ? 35 : "messageLimit" in input ? Number(input.messageLimit) : 100;
        const start = Math.max(0, end - limit);
        const response = { session: { ...summary, messages: data.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < data.length } };
        if ("messageAround" in input && deferSearch) {
          value = await new Promise(resolve => { searchRead = { resolve }; });
        } else if (before !== undefined && before < data.length) {
          reads.push(before);
          value = await new Promise(resolve => pending.push({ resolve, response }));
        } else value = response;
      } else if (channel === IPC.invoke.sessionList) value = { sessions: [summary] };
      else if (channel === IPC.invoke.plansPending) value = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) value = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) value = { entries: [] };
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) value = { ok: true };
      else { unexpected.push(channel); return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: channel } }; }
      return { ok: true, data: value as T };
    },
  };
  const scroller = () => host.querySelector<HTMLDivElement>(".thread-scroll")!;
  const busy = () => host.querySelector('.transcript-history-loading[aria-hidden="false"]') !== null;
  const bottom = () => Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) <= 2;
  // Arrival replaces the prepared identity; connected history data may survive.
  const latestArrival = () => {
    const prepared = useAppStore.getState().transcriptViews[id];
    return () => !prepared || useAppStore.getState().transcriptViews[id] !== prepared ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
  };
  const render = (visible = true) => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <div className="session-panes"><SessionPane key={id} sessionId={id} visible={visible} /></div>
  </I18nextProvider>));
  const reset = async (name: string, role: "user" | "mixed" = "user", running = false, tailOnly = false) => {
    flushSync(() => root.render(null));
    for (const item of pending.splice(0)) item.resolve(item.response);
    searchRead?.resolve({ session: null }); searchRead = undefined; deferSearch = false;
    id = `navigation-${name}`;
    const count = tailOnly ? 35 : name === "continuous-pages" ? 1035 : 280;
    data = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`,
      role: role === "user" || index % (name.startsWith("motion-") && !tailOnly ? 100 : 30) === 0 ? "user" : "assistant",
      content: name === "content-window-long" && index === count - 1
        ? `Message ${index}\n\n${Array.from({ length: 1600 }, (_, paragraph) => `Long answer paragraph ${paragraph}. ${"Readable long-answer content. ".repeat(3)}`).join("\n\n")}`
        : `Message ${index}\n\n${"Stationary visible reading paragraph. ".repeat(80)}`,
      createdAt, status: running && index === count - 1 ? "streaming" : "complete" }));
    summary = { id, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
      providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt, messageCount: data.length };
    useAppStore.setState({ sessions: [summary], messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {}, sessionCompactions: {},
      providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {}, pendingPermissions: {}, planningStates: {},
      runningSessions: running ? { [id]: true } : {}, isRunning: running, workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      settings: { ...originalState.settings, smoothStreaming: false } });
    await useAppStore.getState().selectSession(id);
    render();
    await until(() => Boolean(scroller()) && !host.querySelector('[data-transcript-settling="true"]') && bottom(), "cold pane follows latest");
    await frame();
  };
  const begin = (top = 80) => {
    const el = scroller();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
    el.scrollTo({ top, behavior: "instant" });
    const viewport = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => {
      const r = node.getBoundingClientRect(); return r.height > 0 && r.bottom > viewport.top + 20 && r.top < viewport.bottom;
    });
    assert(row?.dataset.messageId, "visible message missing before loading");
    const messageId = row.dataset.messageId;
    const measure = () => {
      const node = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      return node?.isConnected ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : Infinity;
    };
    const offset = measure();
    const samples: number[] = [];
    let handle = 0;
    const sample = () => { samples.push(measure()); handle = requestAnimationFrame(sample); };
    handle = requestAnimationFrame(sample);
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { messageId, offset, measure, samples, stop: () => cancelAnimationFrame(handle) };
  };
  const finish = async () => {
    assert(pending.length === 1, `expected one held physical page, got ${pending.length}`);
    const item = pending.shift()!;
    item.resolve(item.response);
    await until(() => !busy() && !useAppStore.getState().transcriptViews[id]?.loading, "page did not settle");
    for (let n = 0; n < 8; n++) await frame();
  };
  const results: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const variant of reducedOnly ? [] : ["collapsed", "expanded", "long"]) {
      const expanded = variant !== "collapsed";
      await reset(`content-window-${variant}`, "mixed", false, true);
      const el = scroller();
      if (expanded) {
        const toggles = [...el.querySelectorAll<HTMLButtonElement>('.turn-process > button[aria-expanded="false"]')];
        assert(toggles.length > 0, "expanded resource fixture needs collapsed process groups");
        flushSync(() => { for (const toggle of toggles) toggle.click(); });
        await until(() => toggles.every(toggle => toggle.getAttribute("aria-expanded") === "true"), "process groups did not expand");
        await frame();
      }
      const shells = () => [...el.querySelectorAll<HTMLElement>(".assistant-turn-fragment .prose-chat")];
      const resources = () => shells().filter(node => node.childElementCount > 0).length;
      const visibleReady = () => {
        const viewport = el.getBoundingClientRect();
        return shells().every(node => {
          const rect = node.getBoundingClientRect();
          return rect.bottom <= viewport.top || rect.top >= viewport.bottom || node.childElementCount > 0;
        });
      };
      assert(shells().length > 20, "resource fixture must contain enough assistant content");
      const readsBefore = reads.length;
      const counts: number[] = [];
      for (const fraction of [1, 0, 0.5, 1, 0]) {
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: fraction === 1 ? 400 : -400 }));
        el.scrollTo({ top: (el.scrollHeight - el.clientHeight) * fraction, behavior: "instant" });
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        // Let scroll delivery, shared observation, and React layout commit run
        // before accepting a result from the destination viewport.
        for (let n = 0; n < 3; n++) await frame();
        try {
          await until(() => resources() <= 20 && visibleReady(), "content window did not recycle and restore visible prose");
        } catch (error) {
          console.log("CONTENT_WINDOW_FAILURE", JSON.stringify({ fraction, resources: resources(), visibleReady: visibleReady(),
            height: el.clientHeight, top: el.scrollTop, shells: shells().map(node => ({
              state: node.dataset.transcriptContent, height: node.getBoundingClientRect().height,
              width: node.getBoundingClientRect().width, top: node.getBoundingClientRect().top,
            })) }));
          throw error;
        }
        counts.push(resources());
      }
      assert(reads.length === readsBefore, "content recycling initiated a history request");
      console.log("CONTENT_WINDOW_RESOURCES", JSON.stringify({ variant, expanded, total: shells().length, counts }));
      results.push({ contentWindow: counts });
    }
    for (const tailOnly of [true, false]) for (const running of [false, true]) {
      await reset(`motion-${tailOnly ? "tail" : "history"}-${running ? "running" : "idle"}`, "mixed", running, tailOnly);
      const el = scroller();
      const anchor = begin(tailOnly ? Math.max(121, (el.scrollHeight - el.clientHeight) / 2) : 80);
      try {
        if (!tailOnly) {
          await until(() => pending.length === 1, "motion setup did not page");
          await finish();
        }
        await until(() => Boolean(host.querySelector(".jump-latest-btn")), "latest control did not appear");
        let blankFrames = 0;
        const textOffsets: number[] = [];
        const bottomOffsets: number[] = [];
        const arrivalSamples: { distance: number; history: boolean; rowTop: number; textTop: number | null; sameNode: boolean }[] = [];
        let previousLatest: HTMLElement | null = null;
        const latestMessageId = data.at(-1)!.id;
        const distance = () => Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
        const start = distance();
        const samples: number[] = [start];
        let sampling = true;
        let arrived = () => false;
        const observers = new Set<ResizeObserver>();
        const sample = () => {
          if (!sampling) return;
          samples.push(distance());
          // rAF runs before auto content-visibility has laid out the new viewport.
          // Inspect eligibility after that layout, still before this frame paints.
          const observer = new ResizeObserver(() => {
            observer.disconnect(); observers.delete(observer);
            if (!sampling) return;
            const viewport = el.getBoundingClientRect();
            const latest = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(latestMessageId)}"]`);
            if (latest) {
              const rect = latest.getBoundingClientRect();
              if (rect.top < viewport.bottom && rect.bottom > viewport.top) {
                textOffsets.push(rect.top - viewport.top);
                // Near-bottom is not arrival: the last animation frames still
                // travel legitimately. Historical arrival commits the live view.
                if (bottom() && arrived()) {
                  bottomOffsets.push(rect.top - viewport.top);
                }
                if (bottom()) {
                  const walker = document.createTreeWalker(latest, NodeFilter.SHOW_TEXT);
                  let text = walker.nextNode();
                  while (text && !text.textContent?.trim()) text = walker.nextNode();
                  const range = document.createRange();
                  if (text) range.selectNodeContents(text);
                  arrivalSamples.push({ distance: distance(), history: !arrived(),
                    rowTop: rect.top - viewport.top, textTop: text ? range.getBoundingClientRect().top - viewport.top : null,
                    sameNode: latest === previousLatest });
                }
                previousLatest = latest;
              }
            }
            const painted = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].some(node => {
              const rect = node.getBoundingClientRect();
              return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom &&
                node.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
            });
            if (!painted) blankFrames++;
          });
          observers.add(observer); observer.observe(el);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        host.querySelector<HTMLButtonElement>(".jump-latest-btn")!.click();
        arrived = latestArrival();
        try {
          await until(() => arrived() && bottom(), "smooth latest did not finish");
          if (!tailOnly) assert((useAppStore.getState().transcriptViews[id]?.messages.length ?? 0) >= 135,
            "latest arrival discarded the previously loaded page");
          for (let n = 0; n < 30; n++) await frame();
        } finally { sampling = false; for (const observer of observers) observer.disconnect(); }
        const intermediateFrames = samples.filter(value => value > 2 && value < start - 2).length;
        const reversal = Math.max(0, ...samples.slice(1).map((value, i) => value - samples[i]));
        const result = { tailOnly, running, start, intermediateFrames, reversal, blankFrames, firstDistances: samples.slice(0, 8) };
        const textReversal = Math.max(0, ...textOffsets.slice(1).map((value, i) => value - textOffsets[i]));
        const settledTextDrift = bottomOffsets.length ? Math.max(...bottomOffsets) - Math.min(...bottomOffsets) : 0;
        console.log("LATEST_TEXT_TRAJECTORY " + JSON.stringify({ tailOnly, running, textReversal, settledTextDrift, bottomOffsets }));
        console.log("LATEST_ARRIVAL_PHASES " + JSON.stringify({ tailOnly, running, arrivalSamples }));
        console.log("LATEST_MOTION " + JSON.stringify(result));
        assert(matchMedia("(prefers-reduced-motion: reduce)").matches || intermediateFrames >= 3,
          `latest snapped instead of scrolling: ${JSON.stringify(result)}`);
        assert(reversal <= 2, `latest moved away from bottom: ${JSON.stringify(result)}`);
        assert(textReversal <= 2 && settledTextDrift <= 2,
          `latest text bounced despite bottom distance: ${JSON.stringify({ tailOnly, running, textReversal, settledTextDrift })}`);
        assert(blankFrames === 0, `latest painted an empty viewport: ${JSON.stringify(result)}`);
        results.push(result);
      } catch (error) { failures.push(String(error)); console.log("LATEST_MOTION_ERROR " + String(error)); }
      finally { anchor.stop(); }
    }
    if (reducedOnly) {
      assert(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion emulation missing");
      assert(failures.length === 0 && unexpected.length === 0, failures.join("\n"));
      return { ok: true, reducedMotion: true, cases: results };
    }
    for (const action of ["interrupt", "press", "growth", "layout-above", "complete", "hide", "unmount", "new-search", "failed-search"] as const) {
      await reset(`lifecycle-${action}`, "mixed", action === "growth" || action === "complete");
      const anchor = begin();
      try {
        await until(() => pending.length === 1, "lifecycle setup did not page");
        await finish();
        const el = scroller();
        const oldTop = el.scrollTop;
        host.querySelector<HTMLButtonElement>(".jump-latest-btn")!.click();
        const arrived = latestArrival();
        await until(() => el.scrollTop > oldTop + 20 && !bottom(), "trip did not enter an intermediate position");
        if (action === "failed-search") {
          deferSearch = true;
          const request = useAppStore.getState().navigateTranscript({ sessionId: id, messageId: data[270].id, query: "Message 270" });
          await until(() => Boolean(searchRead), "delayed search did not start");
          await frame();
          const stopped = el.scrollTop;
          for (let n = 0; n < 70; n++) await frame();
          assert(Math.abs(el.scrollTop - stopped) <= 2 && !bottom(), "pending search did not cancel latest motion");
          searchRead!.resolve({ session: null }); searchRead = undefined;
          await request;
          assert(Boolean(host.querySelector(".jump-latest-btn")), "failed search stranded history with no navigation control");
          deferSearch = false;
        } else if (action === "press") {
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          const bookmark = getTranscriptReadingPosition(id);
          assert(bookmark?.pinned === false && bookmark.messageId, "press-only interruption left a pinned bookmark");
          const stopped = el.scrollTop;
          flushSync(() => root.render(null)); render();
          await until(() => Boolean(scroller().querySelector(`[data-message-id="${CSS.escape(bookmark.messageId!)}"]`)), "interrupted reading row did not remount");
          await frame();
          const restoredOffset = () => scroller().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(bookmark.messageId!)}"]`)!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
          await until(() => Math.abs(restoredOffset() - bookmark.offset) <= 2,
            `press-only interruption lost reading row on remount: expected=${bookmark.offset}, now=${restoredOffset()}, oldTop=${stopped}`);
          assert(!bottom(), "press-only interruption repinned on remount");
        } else if (action === "new-search") {
          await useAppStore.getState().navigateTranscript({ sessionId: id, messageId: data[270].id, query: "Message 270" });
          await until(() => useAppStore.getState().transcriptViews[id]?.focus?.messageId === data[270].id,
            "new search did not replace latest intent");
          for (let n = 0; n < 50; n++) await frame();
          assert(useAppStore.getState().transcriptViews[id]?.focus?.messageId === data[270].id && !bottom(),
            "obsolete latest arrival overrode the new search");
        } else if (action === "interrupt") {
          el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
          el.scrollTo({ top: el.scrollTop - 100, behavior: "instant" });
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          const stopped = el.scrollTop;
          for (let n = 0; n < 50; n++) await frame();
          assert(Math.abs(el.scrollTop - stopped) <= 2 && !bottom(), "reader input did not retire the trip");
          assert(Boolean(useAppStore.getState().transcriptViews[id]), "interruption committed latest");
        } else {
          if (action === "layout-above") {
            const content = el.querySelector<HTMLElement>(".thread-content")!;
            const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
            const previousPadding = content.style.paddingTop;
            content.style.paddingTop = "2400px";
            await frame();
            const afterLayout = el.scrollHeight - el.clientHeight - el.scrollTop;
            content.style.paddingTop = previousPadding;
            assert(afterLayout <= remaining + 2,
              `layout above reversed latest travel: before=${remaining}, after=${afterLayout}`);
          } else if (action === "growth") {
            const live = useAppStore.getState().messages.map(message => ({ ...message, status: "complete" as const }));
            useAppStore.setState({ messages: [...live, { ...data.at(-1)!, id: `${id}-new`,
              content: "New live output. ".repeat(300), status: "streaming" }] });
          } else if (action === "complete") {
            useAppStore.setState({ isRunning: false, runningSessions: {},
              messages: useAppStore.getState().messages.map(message => ({ ...message, status: "complete" })) });
          } else if (action === "hide") {
            render(false);
            await until(arrived, "hide did not commit accepted latest intent");
            render();
          } else if (action === "unmount") {
            flushSync(() => root.render(null));
            assert(arrived(), "unmount did not commit accepted latest intent");
            render();
          }
          await until(() => arrived() && bottom(), `${action} lost latest`);
          for (let n = 0; n < 15; n++) { await frame(); assert(bottom(), `${action} reversed accepted latest`); }
        }
        results.push({ lifecycle: action, ok: true });
        console.log("LATEST_LIFECYCLE " + JSON.stringify({ action, ok: true }));
      } catch (error) { failures.push(String(error)); console.log("LATEST_LIFECYCLE_ERROR " + action + " " + String(error)); }
      finally { anchor.stop(); }
    }
    for (const kind of ["focused", "restored"] as const) {
      await reset(`${kind}-disjoint`, "mixed");
      useAppStore.setState({ transcriptViews: { [id]: { messages: data.slice(0, 35), messageStart: 0,
        messageEnd: 35, hasMoreBefore: false, hasMoreAfter: true, loading: null,
        focus: { sessionId: id, messageId: data[0].id, query: "Message 0", requestId: 991 } } } });
      await until(() => Boolean(host.querySelector(".transcript-search-target")), "search target did not mount");
      if (kind === "restored") {
        const view = useAppStore.getState().transcriptViews[id]!;
        useAppStore.setState({ transcriptViews: { [id]: { ...view, focus: null, restored: true } } });
        await until(() => !host.querySelector(".transcript-search-target"), "restored view did not leave search");
      }
      const el = scroller();
      const positions: number[] = [];
      let sampling = true;
      const sample = () => {
        if (!sampling || !useAppStore.getState().transcriptViews[id]) return;
        positions.push(el.scrollTop); requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const beforeReads = reads.length;
      host.querySelector<HTMLButtonElement>(".jump-latest-btn")!.click();
      try {
        await until(() => !useAppStore.getState().transcriptViews[id] && bottom(), `${kind} disjoint range failed to join live tail`);
        const reversal = Math.max(0, ...positions.slice(1).map((top, n) => positions[n] - top));
        assert(reversal <= 2, `old search alignment reversed latest: ${reversal}`);
        assert(reads.length === beforeReads, "explicit latest read unloaded intermediate history");
        results.push({ disjoint: kind, reversal });
        console.log("LATEST_DISJOINT " + JSON.stringify({ kind, reversal }));
      } catch (error) { failures.push(String(error)); console.log("LATEST_DISJOINT_ERROR " + kind + " " + String(error)); }
      finally { sampling = false; }
    }
    await reset("prefetch-repin", "mixed", true);
    {
      const anchor = begin(scroller().clientHeight * 2);
      try {
        await until(() => pending.length === 1, "repin setup did not prefetch");
        const el = scroller();
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
        el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: "instant" });
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        await frame();
        const live = useAppStore.getState().messages.map(message => ({ ...message, status: "complete" as const }));
        useAppStore.setState({ messages: [...live, { ...data.at(-1)!, id: `${id}-new`,
          content: "New live output. ".repeat(400), status: "streaming" }] });
        for (let n = 0; n < 8; n++) await frame();
        assert(bottom() && !host.querySelector(".jump-latest-btn"), "repinned prefetch did not follow new output");
        await finish();
        assert(bottom(), "late prefetched page stole resumed follow");
        results.push({ prefetchRepin: true });
        console.log("PREFETCH_REPIN " + JSON.stringify({ ok: true }));
      } catch (error) { failures.push(String(error)); console.log("PREFETCH_REPIN_ERROR " + String(error)); }
      finally { anchor.stop(); }
    }
    for (const { role, lateEntry, fast } of [
      { role: "user", lateEntry: false, fast: false }, { role: "mixed", lateEntry: false, fast: false },
      { role: "user", lateEntry: true, fast: false }, { role: "user", lateEntry: false, fast: true },
    ] as const) {
      await reset(`prefetch-${role}${lateEntry ? "-late-entry" : ""}${fast ? "-fast" : ""}`, role);
      const anchor = begin(fast ? 4000 : scroller().clientHeight * 2);
      try {
        await until(() => pending.length === 1, "history was not requested before reaching the top");
        assert(scroller().scrollTop > scroller().clientHeight, "prefetch started too close to the edge");
        if (fast) assert(scroller().scrollTop > 2400, "fast prefetch fell back to the old fixed band");
        assert(scroller().style.overflowY !== "hidden", "background prefetch locked scrolling");
        let previous: HTMLElement | undefined;
        if (lateEntry) {
          const row = scroller().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.messageId)}"]`);
          const sibling = row?.previousElementSibling;
          assert(sibling instanceof HTMLElement, "preceding lazy message missing");
          previous = sibling;
          previous.style.contentVisibility = "visible";
          await frame(); await frame();
          const el = scroller();
          el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
          el.scrollTo({ top: el.scrollTop + anchor.measure() + 20, behavior: "instant" });
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          await frame(); await frame();
        }
        const before = scroller().scrollTop;
        const offsetBeforeScroll = anchor.measure();
        scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
        scroller().scrollTo({ top: before - 100, behavior: "instant" });
        await frame();
        if (previous) previous.style.paddingBottom = "400px";
        await frame();
        assert(Math.abs(anchor.measure() - offsetBeforeScroll - 100) <= 2,
          `prefetch undid a newer reading point: before=${offsetBeforeScroll}, now=${anchor.measure()}`);
        anchor.stop();
        const offset = anchor.measure();
        await finish();
        const drift = Math.abs(anchor.measure() - offset);
        const result = { role, lateEntry, fast, prefetch: true, drift, top: scroller().scrollTop };
        console.log("EARLY_HISTORY " + JSON.stringify(result));
        assert(drift <= 2, `prefetched page moved the reading point: ${JSON.stringify(result)}`);
        results.push(result);
      } catch (error) { failures.push(String(error)); console.log("EARLY_HISTORY_ERROR " + String(error)); }
      finally { anchor.stop(); }
    }
    await reset("continuous-pages");
    {
      const firstRead = reads.length;
      const pages: { cursor: number; drift: number; mounted: number }[] = [];
      for (let page = 0; page < 3; page++) {
        // Cached window expansion may precede the physical read. Each attempt
        // is a new upward gesture, never an observer-driven idle drain.
        for (let attempt = 0; pending.length === 0 && attempt < 12; attempt++) {
          const mounted = begin(scroller().clientHeight * 2);
          mounted.stop();
          await frame();
          await until(() => pending.length > 0 || !busy(), "cached expansion did not settle");
          let previousGeometry = "";
          let stableFrames = 0;
          await until(() => {
            if (pending.length > 0) return true;
            const el = scroller();
            const geometry = `${el.scrollTop}:${el.scrollHeight}:${el.querySelectorAll("[data-message-id]").length}`;
            stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
            previousGeometry = geometry;
            return stableFrames >= 3 && !busy();
          }, "cached expansion geometry did not stabilize");
        }
        assert(pending.length === 1, "continuous history lost single-flight paging");
        const anchor = begin(scroller().clientHeight * 2);
        try {
          await frame(); await frame();
          const before = anchor.measure();
          const el = scroller();
          el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
          el.scrollTo({ top: el.scrollTop - 100, behavior: "instant" });
          await frame(); await frame();
          assert(Math.abs(anchor.measure() - before - 100) <= 2, "continuous read swallowed movement");
          const offset = anchor.measure();
          await finish();
          const drift = Math.abs(anchor.measure() - offset);
          assert(drift <= 2, `continuous prepend drifted by ${drift}`);
          assert(reads.length === firstRead + page + 1, "page settlement eagerly requested more history");
          pages.push({ cursor: reads.at(-1)!, drift,
            mounted: el.querySelectorAll("[data-message-id]").length });
        } finally { anchor.stop(); }
      }
      assert(pages.every((page, index) => index === 0 || page.cursor === pages[index - 1].cursor - 100),
        `continuous history skipped or duplicated a page: ${JSON.stringify(pages)}`);
      assert(useAppStore.getState().transcriptViews[id]?.hasMoreBefore, "fixture drained all history");
      console.log("CONTINUOUS_HISTORY " + JSON.stringify(pages));
      results.push({ continuousPages: pages });
    }
    for (const role of ["user", "mixed"] as const) {
      await reset(`quiet-${role}`, role);
      const anchor = begin();
      await until(() => pending.length === 1, "ordinary paging did not reach Host boundary");
      for (let n = 0; n < 6; n++) await frame();
      const during = anchor.measure();
      await finish();
      anchor.stop();
      const result = { role, duringDrift: Math.abs(during - anchor.offset),
        finalDrift: Math.abs(anchor.measure() - anchor.offset), maxDrift: Math.max(...anchor.samples.map(x => Math.abs(x - anchor.offset))),
        historical: Boolean(useAppStore.getState().transcriptViews[id]), top: scroller().scrollTop };
      console.log("REAL_HISTORY_QUIET " + JSON.stringify(result));
      if (result.maxDrift > 2) failures.push(`loading moved visible ${role} message: ${JSON.stringify(result)}`);
      results.push(result);
    }
    for (const scenario of [
      { timing: "pending", role: "user" }, { timing: "settled", role: "user" },
      { timing: "pending", role: "mixed" }, { timing: "settled", role: "mixed" },
    ] as const) {
      const { timing, role } = scenario;
      await reset(`latest-${timing}-${role}`, role);
      const anchor = begin();
      try {
        await until(() => pending.length === 1, "pending page for latest navigation");
        if (timing === "settled") await finish();
        const button = host.querySelector<HTMLButtonElement>(".jump-latest-btn");
        assert(button, "actual return-to-latest button missing");
        const readsBeforeJump = reads.length;
        button.click();
        const arrived = latestArrival();
        if (timing === "pending") { const item = pending.shift()!; item.resolve(item.response); }
        await until(() => arrived() && bottom(), `latest button failed after ${timing} page`);
        for (let n = 0; n < 15; n++) { await frame(); assert(bottom(), "latest navigation was reversed after reaching bottom"); }
        assert(pending.length === 0 && reads.length === readsBeforeJump, "latest navigation started another history page");
        const result = { timing, role, top: scroller().scrollTop, height: scroller().scrollHeight,
          historical: !arrived(), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches };
        console.log("REAL_HISTORY_LATEST " + JSON.stringify(result));
        results.push(result);
      } catch (error) {
        const result = { timing, role, error: String(error), top: scroller().scrollTop, height: scroller().scrollHeight,
          historical: Boolean(useAppStore.getState().transcriptViews[id]), pending: pending.length };
        console.log("REAL_HISTORY_LATEST " + JSON.stringify(result));
        failures.push(JSON.stringify(result));
      } finally { anchor.stop(); }
    }
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected.join(",")}`);
    assert(failures.length === 0, failures.join("\n"));
    return { ok: true, cases: results, reads };
  } finally {
    for (const item of pending.splice(0)) item.resolve(item.response);
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState(originalState);
    window.piDesktop = originalBridge;
  }
};
