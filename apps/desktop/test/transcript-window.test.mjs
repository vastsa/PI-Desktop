import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TRANSCRIPT_INITIAL_MOUNT,
  TRANSCRIPT_WINDOW_MIN,
  TRANSCRIPT_WINDOW_STEP,
  growTranscriptWindow,
  reduceTranscriptWindow,
} from "../src/lib/transcript-window.ts";
import {
  buildTranscriptEntries,
  transcriptEntryMessages,
} from "../src/lib/assistant-turns.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, minimap] = await Promise.all([
  read("../src/components/ChatTranscript.tsx"),
  read("../src/components/ConversationMinimap.tsx"),
]);

function window(overrides = {}) {
  return reduceTranscriptWindow({
    historyLength: 400,
    windowSize: TRANSCRIPT_WINDOW_MIN,
    initialCommit: false,
    ...overrides,
  });
}

/* ---------- the mounted-history budget ---------- */

test("a long history mounts only the trailing window", () => {
  const result = window();

  assert.equal(result.mounted, TRANSCRIPT_WINDOW_MIN);
  assert.equal(result.hiddenAbove, 400 - TRANSCRIPT_WINDOW_MIN);
  assert.equal(result.bounded, true);
});

test("a history that fits the window mounts completely", () => {
  const result = window({ historyLength: 12 });

  assert.equal(result.mounted, 12);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.bounded, false);
});

test("the first commit after a session switch mounts the initial budget", () => {
  const result = window({ initialCommit: true });

  assert.equal(result.mounted, TRANSCRIPT_INITIAL_MOUNT);
  assert.ok(
    TRANSCRIPT_INITIAL_MOUNT < TRANSCRIPT_WINDOW_MIN,
    "the first paint must be cheaper than the steady state",
  );
  assert.equal(result.bounded, true);
});

test("a short session switch is never bounded", () => {
  const result = window({ historyLength: 3, initialCommit: true });

  assert.equal(result.mounted, 3);
  assert.equal(result.bounded, false);
});

test("an empty history mounts nothing and reports no hidden rows", () => {
  const result = window({ historyLength: 0 });

  assert.equal(result.mounted, 0);
  assert.equal(result.hiddenAbove, 0);
  assert.equal(result.bounded, false);
});

test("a stale oversized window from a previous session cannot over-mount", () => {
  // `windowSize` is state, so a session switch can render one frame with the
  // previous session's grown budget before the reset effect runs.
  const result = window({ historyLength: 20, windowSize: 4_000 });

  assert.equal(result.mounted, 20);
  assert.equal(result.bounded, false);
});

test("the window budget never drops below the steady-state floor", () => {
  const result = window({ windowSize: 1 });

  assert.equal(result.mounted, TRANSCRIPT_WINDOW_MIN);
});

/* ---------- growing the window ---------- */

test("reaching the top grows the window by one step", () => {
  assert.equal(
    growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, 400),
    TRANSCRIPT_WINDOW_MIN + TRANSCRIPT_WINDOW_STEP,
  );
});

test("growth stops once the window covers the loaded history", () => {
  // This is the handoff to `loadOlder`: the transcript only fetches an older
  // page when mounting more of what it already has cannot help.
  assert.equal(growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, 30), TRANSCRIPT_WINDOW_MIN);
  assert.equal(growTranscriptWindow(200, 200), 200);
});

test("growth is clamped to the loaded history instead of overshooting", () => {
  const length = TRANSCRIPT_WINDOW_MIN + 5;

  assert.equal(growTranscriptWindow(TRANSCRIPT_WINDOW_MIN, length), length);
});

test("repeated growth reaches full history and then reports a fixed point", () => {
  let size = TRANSCRIPT_WINDOW_MIN;
  for (let step = 0; step < 50; step += 1) {
    size = growTranscriptWindow(size, 300);
  }

  assert.equal(size, 300);
  assert.equal(growTranscriptWindow(size, 300), size);
  assert.equal(reduceTranscriptWindow({
    historyLength: 300,
    windowSize: size,
    initialCommit: false,
  }).bounded, false);
});

/* ---------- what the mounted rows contain ---------- */

function assistant(id, content) {
  return { id, role: "assistant", content, createdAt: "2026-01-01T00:00:00Z" };
}

function user(id, content) {
  return { id, role: "user", content, createdAt: "2026-01-01T00:00:00Z" };
}

test("mounted rows expose their user and assistant messages in order", () => {
  const { entries } = buildTranscriptEntries([
    user("u1", "first"),
    assistant("a1", "answer"),
    user("u2", "second"),
    assistant("a2", "answer two"),
  ]);

  const ids = transcriptEntryMessages(entries).map((message) => message.id);

  assert.deepEqual(ids, ["u1", "a1", "u2", "a2"]);
});

test("mounted rows exclude tool rows and delegate rows", () => {
  const { entries } = buildTranscriptEntries([
    user("u1", "go"),
    {
      id: "t1",
      role: "tool",
      content: "output",
      createdAt: "2026-01-01T00:00:00Z",
      toolCallId: "t1",
      toolName: "Bash",
    },
    {
      id: "d1",
      role: "assistant",
      content: "delegate said",
      createdAt: "2026-01-01T00:00:00Z",
      parentToolCallId: "t1",
    },
    assistant("a1", "done"),
  ]);

  const ids = transcriptEntryMessages(entries).map((message) => message.id);

  assert.deepEqual(ids, ["u1", "a1"]);
});

test("a windowed slice reports only the rows it mounts", () => {
  const messages = [];
  for (let index = 0; index < 10; index += 1) {
    messages.push(user(`u${index}`, `ask ${index}`));
    messages.push(assistant(`a${index}`, `answer ${index}`));
  }
  const { entries } = buildTranscriptEntries(messages);

  const mounted = transcriptEntryMessages(entries.slice(-4));
  const ids = mounted.map((message) => message.id);

  assert.ok(ids.length > 0);
  assert.ok(!ids.includes("u0"), "withheld rows must not be reported");
  assert.ok(ids.includes("a9"), "the newest row is always mounted");
});

/* ---------- renderer wiring ---------- */

test("the transcript bounds mounted history and escalates at the top", () => {
  assert.match(transcript, /reduceTranscriptWindow/);
  assert.match(transcript, /growTranscriptWindow/);
  assert.match(
    transcript,
    /const \[windowSize, setWindowSize\] = useState\(TRANSCRIPT_WINDOW_MIN\)/,
  );
  // Reaching the top mounts more of what is loaded first, and only fetches an
  // older page once the window already covers it.
  assert.match(transcript, /if \(el\.scrollTop <= 120\) reachTop\(\)/);
  const reachTop = transcript.match(
    /const reachTop = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[loadOlder, windowSize\]\);/,
  )?.[1];
  assert.ok(reachTop, "reachTop must exist with a stable identity");
  assert.match(reachTop, /growTranscriptWindow\(windowSize, historyLengthRef\.current\)/);
  assert.match(reachTop, /prependHeightRef\.current = el\.scrollHeight/);
  assert.match(reachTop, /setWindowSize\(grown\)/);
  assert.match(reachTop, /loadOlder\(\)/);
});

test("mounting rows above the viewport is anchored like a fetched page", () => {
  // Both add height above the reading position, so both take the same
  // pre-paint correction; without `windowSize` here, growing the window would
  // shove the rows the user is reading down the screen.
  assert.match(
    transcript,
    /const delta = el\.scrollHeight - previousHeight;[\s\S]*?\}, \[messages\.length, windowSize\]\)/,
  );
});

test("the window resets per session so a switch cannot inherit a budget", () => {
  assert.match(
    transcript,
    /prependHeightRef\.current = null;\s*setLoadingOlder\(false\);\s*setWindowSize\(TRANSCRIPT_WINDOW_MIN\);\s*\}, \[sessionId\]\)/,
  );
});

test("the minimap describes mounted rows so every dash is reachable", () => {
  // The minimap resolves a click by finding the marker's node in the scroller,
  // so a dash for a withheld row would jump nowhere.
  assert.match(minimap, /querySelectorAll<HTMLElement>\("\[data-minimap-id\]"\)/);
  assert.match(
    transcript,
    /<ConversationMinimap scrollRef=\{scrollRef\} messages=\{minimapMessages\} \/>/,
  );
  assert.match(
    transcript,
    /transcriptWindow\.bounded\s*\?\s*transcriptEntryMessages\(/,
  );
});

test("the hydration spacer stays scoped to the first commit", () => {
  // A permanent spacer under the steady-state window would make the user scroll
  // through a blank viewport before reaching the growth trigger.
  assert.match(
    transcript,
    /\{hydrationBounded \? \([\s\S]*?transcript-hydration-spacer/,
  );
  assert.doesNotMatch(
    transcript,
    /transcriptWindow\.bounded \? \([\s\S]{0,200}transcript-hydration-spacer/,
  );
});
