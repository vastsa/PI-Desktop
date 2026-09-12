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
  assert.match(main, /thinkingLevel: "off"/);
  assert.match(runtime, /completeOneShot\(/);
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
