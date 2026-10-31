import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readTranscriptModule } from "./helpers/source-contracts.mjs";

const [transcript, assistantTurn] = await Promise.all([
  readTranscriptModule("ChatTranscript.tsx"),
  readTranscriptModule("AssistantTurn.tsx"),
]);

test("the history list keeps a non-tail live turn active", () => {
  // A steering message or system row can render after the running turn, so
  // tail position cannot decide liveness (#1949): the transcript resolves the
  // live turn from row state, and only while the live tail is in view, so the
  // reading window keeps #1900's semantics and hung rows keep #1965's
  // unsettled reading.
  assert.match(transcript, /liveTurnId = useMemo\(/);
  assert.match(
    transcript,
    /transcriptRunning \? liveHistoryTurnId\(historyEntries, tailEntry\) : undefined/,
  );
  assert.match(transcript, /liveTurnId=\{liveTurnId\}/);
  assert.match(
    assistantTurn,
    /isActive=\{entry\.kind === "assistant-turn" && entry\.id === liveTurnId\}/,
  );
  // The bail-out comparator must hear the same signal, or a settled list would
  // keep a turn that just went live frozen in its inactive rendering.
  assert.match(assistantTurn, /previous\.liveTurnId !== next\.liveTurnId/);
});

test("a non-tail live turn renders running and open until its rows settle", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TranscriptHistory } = await vite.ssrLoadModule("/src/features/chat/transcript/AssistantTurn.tsx");
    const { buildTranscriptEntries } = await vite.ssrLoadModule("/src/lib/assistant-turns.ts");
    const { liveHistoryTurnId } = await vite.ssrLoadModule("/src/lib/turn-process.ts");
    const { SlotSessionProvider } = await vite.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const message = (id, role, content, extra = {}) => ({
      id, role, content, createdAt: "2026-10-29T00:00:00.000Z", ...extra,
    });
    const { entries } = buildTranscriptEntries([
      message("user", "user", "Inspect"),
      message("intro", "assistant", "Checking", { status: "complete" }),
      message("read", "tool", "", { toolName: "Read", status: "streaming" }),
      message("steer", "user", "also check the config", { steering: true }),
    ]);
    const history = entries.slice(0, -1);
    const tail = entries.at(-1);
    const liveId = liveHistoryTurnId(history, tail);
    assert.equal(tail.kind, "message");
    assert.notEqual(liveId, undefined);
    const render = (liveTurnId) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(SlotSessionProvider, { sessionId: "fixture" },
        createElement(TranscriptHistory, { entries: history, isRunning: true, liveTurnId }))));
    const live = render(liveId);
    assert.match(live, /Running/);
    assert.match(live, /class="turn-process open active"/);
    assert.match(live, /aria-expanded="true"/);
    assert.doesNotMatch(live, /Outcome unknown/);
    // Without the id the same rows keep #1965's unsettled reading and the
    // untouched process closes, which is the collapse half of #1949.
    const idle = render(undefined);
    assert.match(idle, /Outcome unknown/);
    assert.match(idle, /class="turn-process"/);
    assert.doesNotMatch(idle, /turn-process open/);
    assert.match(idle, /aria-expanded="false"/);
    // Memo invalidation: identical entries with a changed liveTurnId must
    // re-render, and a fully equal props object must bail.
    const base = { entries: history, isRunning: true, liveDelegations: undefined, liveTurnId: liveId };
    assert.equal(TranscriptHistory.compare(base, base), true);
    assert.equal(
      TranscriptHistory.compare(base, { ...base, liveTurnId: undefined }),
      false,
    );
  } finally {
    await vite.close();
  }
});
