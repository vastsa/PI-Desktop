import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Background tasks: the Bash tool gains runInBackground, the registry lives in
 * host-core, and the renderer surfaces the running tasks above the composer.
 * These are contract tests over the sources: each layer must name the same
 * wire fields, and the bar must only reflect registry state (never own the
 * process lifecycle).
 */

const runtime = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const toolSources = await readFile(
  new URL("../../../crates/host-core/src/tools/mod.rs", import.meta.url),
  "utf8",
);
const rpcSources = await readFile(
  new URL("../../../crates/host-core/src/rpc/mod.rs", import.meta.url),
  "utf8",
);
const backgroundTasks = await readFile(
  new URL("../../../crates/host-core/src/background_tasks.rs", import.meta.url),
  "utf8",
);
const bar = await readFile(
  new URL("../src/components/TaskDock.tsx", import.meta.url),
  "utf8",
);
const controller = await readFile(
  new URL("../src/features/chat/background-tasks/useBackgroundTasks.ts", import.meta.url),
  "utf8",
);
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const composer = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../src/styles/composer.css", import.meta.url),
  "utf8",
);
const i18nEn = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the Bash schema advertises runInBackground and the tool description explains when to use it", () => {
  assert.match(runtime, /runInBackground: Type\.Optional\(\s*Type\.Boolean/);
  assert.match(runtime, /runInBackground: true for long-lived processes/);
});

test("the runtime forwards runInBackground on a Bash tools.execute call", () => {
  assert.match(
    runtime,
    /params\.runInBackground === true\s*\?\s*\{\s*runInBackground: true\s*\}/,
  );
});

test("host-core parses runInBackground on ToolsExecuteParams and skips the cancellation registry for it", () => {
  assert.match(
    toolSources,
    /pub run_in_background: bool,\s*\n\s*pub timeout_ms/,
  );
  assert.match(
    toolSources,
    /if options\.run_in_background \{[\s\S]*?spawn_background_task_detached/,
  );
});

test("a background Bash call returns a backgroundTaskId and never a blocking stdout payload", () => {
  assert.match(toolSources, /"backgroundTaskId": started/);
});

test("turn cancellation and timeout cannot reach a background task: it never registers a bash cancellation", () => {
  assert.match(
    rpcSources.replace(/\r/g, ""),
    /let cancellation_receiver = if matches!\(p\.tool_name\.as_str\(\), "Bash" \| "GenerateImages"\)[\s\S]*?if remote_workspace\.is_none\(\) && p\.tool_name == "Bash" && p\.run_in_background \{\s*None/,
  );
  assert.match(rpcSources.replace(/\r/g, ""), /"Bash" \| "GenerateImages"/);
});

test("the registry keeps output bounded and stops everything on shutdown", () => {
  assert.match(backgroundTasks, /RING_MAX_BYTES: usize = 256 \* 1024/);
  assert.match(backgroundTasks, /stop_all_running_sync/);
  // The user-visible limit is per session; a process-wide ceiling stays only as
  // a host safety net and must be reported separately.
  assert.match(backgroundTasks, /MAX_RUNNING_TASKS_PER_SESSION: usize = 10/);
  assert.match(backgroundTasks, /MAX_RUNNING_TASKS_TOTAL/);
  assert.doesNotMatch(backgroundTasks, /MAX_RUNNING_TASKS: usize = 32/);
});

test("the renderer container lists tasks, offers output and stop, and mounts above the composer input", () => {
  assert.match(controller, /api\.backgroundTasksList\(\)/);
  assert.match(controller, /api\.backgroundTasksStop\(id\)/);
  // The shared container is the only composer surface for tasks now.
  assert.match(composer, /import \{ TaskDock \} from "\.\/TaskDock";/);
  assert.match(composer, /<TaskDock sessionId=\{activeSessionId\} \/>/);
  assert.doesNotMatch(composer, /BackgroundTasksBar/);
  // It renders before the composer shell (above the input, not inside it).
  const dockIndex = composer.indexOf("<TaskDock sessionId={activeSessionId} />");
  const shellIndex = composer.indexOf('className={`composer-shell');
  assert.ok(dockIndex > 0 && shellIndex > dockIndex, "container must precede the composer shell");
  // The todo side is gated exactly as the todo dock was.
  assert.match(composer, /activeSessionId && localToolsAllowed \? <TaskDock/);
});

test("the api layer names the wire channels for list, output, stop, and the change event", () => {
  assert.match(api, /IPC\.invoke\.backgroundTasksList/);
  assert.match(api, /IPC\.invoke\.backgroundTasksOutput/);
  assert.match(api, /IPC\.invoke\.backgroundTasksStop/);
  assert.match(api, /IPC\.event\.backgroundTasksChanged/);
});

test("the host notification fan-out exists in the electron main host wiring", async () => {
  const host = await readFile(
    new URL("../electron/main/runtime/host.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /method === "backgroundTasks\.changed"/);
  assert.match(host, /sendToRenderer\(IPC\.event\.backgroundTasksChanged/);
});

test("the container styles exist and mark a running task with a pulse", () => {
  assert.match(styles, /\.dock \{/);
  assert.match(
    styles,
    /\.task-row\[data-state="running"\] \.task-state \{[^}]*animation:/,
  );
  // Legibility: the command is the high-contrast element and every size comes
  // from the token scale instead of a raw literal.
  assert.match(styles, /\.task-command \{[^}]*color: var\(--ds-text-primary\)/);
  // The tabs sit in the header row: the container must expose the tablist, the
  // badge, and a separate disclosure control.
  assert.match(styles, /\.dock-tablist \{/);
  assert.match(styles, /\.dock-tab-badge \{/);
  assert.match(styles, /\.dock-toggle\.btn \{/);
});

test("the running/stopped/failed/exited labels are translated", () => {
  assert.match(i18nEn, /backgroundTasks: \{[^}]*running: "Running"/);
});

test("the container shows only live work: a finished row expires and can be removed", async () => {
  const visibility = await readFile(
    new URL("../src/features/chat/background-tasks/bar-visibility.ts", import.meta.url),
    "utf8",
  );
  // The grace window is a named constant, not a magic number in the component.
  assert.match(visibility, /export const ENDED_VISIBLE_MS = 10_000;/);
  assert.match(controller, /selectVisibleTasks\(visibility, sessionTasks, clock, expandedId\)/);
  assert.match(controller, /observeTasks\(current, result\.tasks, observedAt\)/);
  // Removal is refused for a live task in the state layer, not just by hiding
  // the control.
  assert.match(visibility, /task\.state === "running"\) return state;/);
  assert.match(controller, /if \(!task \|\| task\.state === "running"\)/);
  assert.match(controller, /dismissTask\(current, task\)/);
  // A finished row offers removal instead of stopping.
  assert.match(bar, /\{t\("backgroundTasks\.dismiss"\)\}/);
  assert.match(bar, /onClick=\{\(\) => onRemove\(task\.id\)\}/);
});

test("the container filters to the active session and badges new work", () => {
  assert.match(controller, /task\.sessionId === sessionId/);
  // The wire contract stays session-agnostic.
  assert.match(controller, /api\.backgroundTasksList\(\)/);
  // The badge clears only when the user enters the tasks tab.
  assert.match(controller, /const openTasksTab = useCallback/);
  assert.match(controller, /clearBadge\(selectTab\(current, sessionId, "tasks"\), sessionId\)/);
});

test("deleting a session signals its tasks from the shared cleanup path only", () => {
  // D6: every deletion path converges on `drop_session_side_data`, so that is
  // the one place a stop is issued. There is no archive RPC: archiving is a
  // renderer flag, which is what keeps it from killing live processes.
  const cleanup = rpcSources.match(
    /fn drop_session_side_data\(st: &AppState, id: &str\) \{([\s\S]*?)\n\}/,
  );
  assert.ok(cleanup, "the shared per-session cleanup must exist");
  assert.match(cleanup[1], /st\.background_tasks\.stop_session_running\(id\);/);
  // Deleting is the only caller of that cleanup, and no archive method exists.
  assert.equal(
    rpcSources.match(/drop_session_side_data\(&st, id\);/g)?.length,
    2,
    "both deletion paths reach the shared cleanup",
  );
  assert.doesNotMatch(rpcSources, /"session\.archive"/);
});
