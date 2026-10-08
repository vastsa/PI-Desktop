import { readAppSource, readStoreSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [store, sidebarPreferences, api, app, main, protocol, runtime] = await Promise.all([
  readStoreSource(),
  read("../src/lib/sidebar-preferences.ts"),
  read("../src/lib/api.ts"),
  readAppSource(),
  readMainSource(),
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/agent-runtime/src/session-title-summarize.ts"),
]);

test("session title summarization is wired through the full desktop path", () => {
  assert.match(protocol, /sessionSummarizeTitle: "pi-desktop\/session\/summarizeTitle"/);
  assert.match(api, /summarizeSessionTitle: \(req: SessionSummarizeTitleRequest\)/);
  assert.match(api, /IPC\.invoke\.sessionSummarizeTitle/);
  assert.match(main, /handle\(IPC\.invoke\.sessionSummarizeTitle/);
  assert.match(main, /resolveAgentRuntimeLaunch\(/);
  assert.match(main, /summarizeSessionTitle\(/);
  assert.match(runtime, /completeOneShot\(/);
});

test("title generation reads its settings per request (ADR 0322)", () => {
  // Request model > settings pin > session model; a pin that cannot launch
  // falls back instead of failing the title.
  assert.match(main, /pinnedOneShotModel\(settings, "sessionTitleProviderId", "sessionTitleModelId"\)/);
  assert.match(main, /resolvePinnedOneShotLaunch\(/);
  assert.match(main, /session title model unavailable/);
  // Reasoning defaults to off, matching the pre-settings behavior.
  assert.match(main, /settings\.sessionTitleThinkingLevel/);
  assert.match(main, /\(titleThinkingLevel \|\| "off"\)/);
  // Bounded like prompt enhancement.
  assert.match(main, /withOneShotTimeout\(/);
  assert.match(main, /SESSION_TITLE_TIMEOUT_MS/);
  // Prompt and lengths are forwarded to the runtime.
  assert.match(main, /customPrompt: settings\?\.sessionTitleCustomPrompt === true/);
  assert.match(main, /settings\.sessionTitlePrompt/);
  assert.match(main, /settings\.sessionTitleIdealLength/);
  assert.match(main, /settings\.sessionTitleMaxLength/);
  assert.match(runtime, /resolveSessionTitleSystemPrompt/);
});

test("automatic title generation runs after the first turn and respects restart-safe custom titles", () => {
  assert.match(store, /event\.type === "agent_end"[\s\S]*triggerAutoTitleSummarization/);
  assert.match(store, /manualTitle/);
  assert.match(store, /!isDefaultSessionTitle\(session\.title\)/);
  assert.match(store, /promptFallbackSessionTitle\(firstUser\.content, ""\)/);
  assert.match(store, /initialSidebarPreferences\.sessionMeta/);
  assert.match(store, /manualTitle: true/);
  assert.match(sidebarPreferences, /manualTitle\?: boolean/);
  assert.match(sidebarPreferences, /raw\.manualTitle/);
  assert.match(store, /kind: "interactive"/);
  assert.match(app, /kind: "task"/);
  assert.match(main, /kind\?: "task" \| "interactive"/);
  assert.match(main, /shouldShowNativeNotification\(/);
});
