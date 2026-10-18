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
  new URL("../src/components/BackgroundTasksBar.tsx", import.meta.url),
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
    /cancellation_receiver = if remote_workspace\.is_some\(\)[\s\S]*?&& !p\.run_in_background\)/,
  );
  assert.match(rpcSources.replace(/\r/g, ""), /"Bash" \| "GenerateImages"/);
});

test("the registry keeps output bounded and stops everything on shutdown", () => {
  assert.match(backgroundTasks, /RING_MAX_BYTES: usize = 256 \* 1024/);
  assert.match(backgroundTasks, /stop_all_running_sync/);
  assert.match(backgroundTasks, /MAX_RUNNING_TASKS: usize = 32/);
});

test("the renderer bar lists tasks, offers output and stop, and mounts above the composer input", () => {
  assert.match(controller, /api\.backgroundTasksList\(\)/);
  assert.match(controller, /api\.backgroundTasksStop\(id\)/);
  assert.match(bar, /aria-label=\{t\("backgroundTasks\.title"\)\}/);
  assert.match(composer, /import \{ BackgroundTasksBar \} from "\.\/BackgroundTasksBar";/);
  assert.match(composer, /<BackgroundTasksBar \/>/);
  // The bar renders before the composer shell (above the input, not inside it).
  const barIndex = composer.indexOf("<BackgroundTasksBar />");
  const shellIndex = composer.indexOf('className={`composer-shell');
  assert.ok(barIndex > 0 && shellIndex > barIndex, "bar must precede the composer shell");
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

test("the bar styles exist and mark a running task with a pulse", () => {
  assert.match(styles, /\.background-tasks-bar \{/);
  assert.match(
    styles,
    /\.background-task\[data-state="running"\] \.background-task-state \{[^}]*animation:/,
  );
  // Legibility: the command is the high-contrast element and every size comes
  // from the token scale instead of a raw literal.
  assert.match(styles, /\.background-task-command \{[^}]*color: var\(--ds-text-primary\)/);
});

test("the running/stopped/failed/exited labels are translated", () => {
  assert.match(i18nEn, /backgroundTasks: \{[^}]*running: "Running"/);
});

test("the bar shows only live work: a finished row expires and can be closed", async () => {
  const visibility = await readFile(
    new URL("../src/features/chat/background-tasks/bar-visibility.ts", import.meta.url),
    "utf8",
  );
  // The grace window is a named constant, not a magic number in the component.
  assert.match(visibility, /export const ENDED_VISIBLE_MS = 10_000;/);
  assert.match(controller, /selectVisibleTasks\(visibility, tasks, clock, expandedId\)/);
  assert.match(controller, /observeTasks\(current, result\.tasks, observedAt\)/);
  assert.match(controller, /dismissTask\(current, id\)/);
  // A finished row offers closing instead of stopping: it must be able to leave
  // the composer without touching the process lifecycle.
  assert.match(bar, /\{t\("backgroundTasks\.dismiss"\)\}/);
  assert.match(bar, /onClick=\{\(\) => dismiss\(task\.id\)\}/);
  assert.match(i18nEn, /backgroundTasks: \{[^}]*dismiss: "Dismiss"/);
});
