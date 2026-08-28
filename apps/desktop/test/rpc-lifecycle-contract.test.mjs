import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sidecarSource = await readFile(
  new URL("../electron/main/agent-sidecar.ts", import.meta.url),
  "utf8",
);
const hostSource = await readFile(
  new URL("../electron/main/host-process.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../electron/main/index.ts", import.meta.url),
  "utf8",
);
const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const rpcTimeoutSource = await readFile(
  new URL("../../../packages/shared/src/rpc-timeouts.ts", import.meta.url),
  "utf8",
);
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);

test("sidecar detaches host listeners and gates every child write", () => {
  assert.match(sidecarSource, /private closeTransport\(error: Error\)/);
  assert.match(sidecarSource, /unsubscribeHostExit/);
  assert.match(sidecarSource, /private writeToChild\(payload: string\)/);
  assert.match(sidecarSource, /private localToolTimers = new Set/);
  assert.match(sidecarSource, /this\.localToolTimers\.clear\(\)/);
  assert.match(sidecarSource, /this\.child\.stdin\.destroyed/);
  assert.doesNotMatch(
    sidecarSource.replace(/private writeToChild\([\s\S]*?\n  \}/, ""),
    /this\.child\.stdin\.write\(/,
  );
});

test("host transport closes pending calls and listeners on process death", () => {
  assert.match(hostSource, /private closed = false/);
  assert.match(hostSource, /this\.handlers\.clear\(\)/);
  // Tagged, not a bare Error: a caller has to be able to tell routine teardown
  // from a registry that genuinely failed without matching message text.
  assert.match(
    hostSource,
    /if \(this\.closed\) throw this\.unavailableError\("host-core is unavailable"\)/,
  );
  assert.match(hostSource, /errorCode: ErrorCodes\.HOST_UNAVAILABLE,/);
  assert.match(hostSource, /private notifyExit\(/);
});

test("host transport retries transient RPC overload with a bounded backoff", () => {
  assert.match(hostSource, /HOST_OVERLOAD_RETRY_DELAYS_MS = \[50, 100, 200, 400\]/);
  assert.match(hostSource, /typeof msg\.error\.data\.errorCode === "string"/);
  assert.match(hostSource, /function isHostOverloaded\(/);
  assert.match(hostSource, /private async callOnce<.*>\(/);
  assert.match(hostSource, /!isHostOverloaded\(error\)/);
});

test("host disposal closes stdin, observes exit, and force-kills only after grace", () => {
  const disposeSource = hostSource.slice(hostSource.indexOf("async dispose()"));
  const closeTransportSource = hostSource.slice(
    hostSource.indexOf("private closeTransport"),
    hostSource.indexOf("private cleanupProcessListeners"),
  );

  assert.match(hostSource, /private disposePromise\?: Promise<void>/);
  assert.match(hostSource, /private waitForExit\(timeoutMs: number\)/);
  const graceMatch = hostSource.match(/const HOST_DISPOSE_GRACE_MS = ([\d_]+);/);
  assert.ok(graceMatch, "host disposal must define a graceful wait");
  const graceMs = Number(graceMatch[1].replace(/_/g, ""));
  assert.ok(
    graceMs >= 2_500 && graceMs <= 3_000,
    "host disposal must allow the documented process-tree cleanup time",
  );
  assert.match(hostSource, /this\.child\.kill\("SIGKILL"\)/);
  assert.match(disposeSource, /if \(this\.disposePromise\) return this\.disposePromise/);
  assert.ok(
    disposeSource.indexOf("this.child.stdin.end()") <
      disposeSource.indexOf("this.closeTransport("),
    "stdin must close before pending RPCs are rejected",
  );
  assert.doesNotMatch(
    closeTransportSource,
    /removeAllListeners\("exit"\)|removeAllListeners\("error"\)/,
  );
});

test("Bash defaults are finite and the tool advertises the effective timeout", () => {
  assert.match(runtimeSource, /DEFAULT_COMMAND_TIMEOUT_MS/);
  assert.match(runtimeSource, /defaults to a 60-second timeout/);
  assert.match(runtimeSource, /timeoutMs,\n\s+}/);
  assert.match(rpcTimeoutSource, /DEFAULT_BASH_RPC_TIMEOUT_MS/);
  assert.match(rpcTimeoutSource, /return DEFAULT_BASH_RPC_TIMEOUT_MS/);
  assert.doesNotMatch(rpcTimeoutSource, /return undefined/);
});

test("turn ownership and execution queue wake only after durable turn settlement", () => {
  const finishStart = mainSource.indexOf("function finishTurn(");
  const finishEnd = mainSource.indexOf("function isRecord", finishStart);
  const finishSource = mainSource.slice(finishStart, finishEnd);

  assert.match(mainSource, /const turnFinalizations = new Map/);
  assert.match(finishSource, /await host\.call<[\s\S]*?\("session\.endTurn"/);
  assert.ok(
    finishSource.indexOf('"session.endTurn"') <
      finishSource.lastIndexOf("activeTurns.delete"),
    "local session ownership must remain until session.endTurn settles",
  );
  assert.match(finishSource, /for \(const resolve of waiters\) resolve\(\)/);
});

test("late tool metadata cleanup is scoped to the turn that started the call", () => {
  const finishStart = mainSource.indexOf("function finishTurn(");
  const finishEnd = mainSource.indexOf("function isRecord", finishStart);
  const finishSource = mainSource.slice(finishStart, finishEnd);

  assert.match(mainSource, /turnId\?: string;/);
  assert.match(mainSource, /turnId: envelope\.turnId \?\? turnId/);
  assert.match(
    finishSource,
    /key\.startsWith\(toolPrefix\) && call\.turnId === turnId/,
  );
  assert.match(
    mainSource,
    /turnId: started\?\.turnId \?\? envelope\.turnId \?\? turnId/,
  );
  assert.match(
    mainSource,
    /event: \{ type: "message_end", message: persistedMessage \}/,
  );
});

test("app quit waits for one idempotent teardown before allowing the follow-up quit", () => {
  const shutdownStart = mainSource.indexOf('app.on("before-quit"');
  const shutdownSource = mainSource.slice(shutdownStart);

  assert.match(mainSource, /let shutdownComplete = false/);
  assert.match(mainSource, /let shutdownPromise: Promise<void> \| null = null/);
  assert.match(shutdownSource, /if \(shutdownComplete\) return/);
  assert.match(shutdownSource, /event\.preventDefault\(\)/);
  assert.match(shutdownSource, /if \(shutdownPromise\) return/);
  assert.ok(
    shutdownSource.indexOf("event.preventDefault()") <
      shutdownSource.indexOf("if (shutdownPromise) return"),
    "the first quit must be prevented before the idempotence guard returns",
  );
  assert.ok(
    shutdownSource.indexOf("host?.dispose()") <
      shutdownSource.indexOf("pluginPanels.closeAll()"),
    "host disposal must start before other application teardown",
  );
  assert.match(shutdownSource, /await hostShutdown/);
  assert.match(shutdownSource, /await Promise\.allSettled\(\[pluginPanelShutdown, sidecarShutdown\]\)/);
  assert.ok(
    shutdownSource.indexOf("shutdownComplete = true") <
      shutdownSource.indexOf("app.quit()"),
    "the second quit must only be allowed after teardown completes",
  );
  assert.match(shutdownSource, /void shutdownPromise\.then\(releaseQuit, releaseQuit\)/);
});

test("settings writes validate without applying read defaults", () => {
  assert.match(mainSource, /validateSettingsWrite\(settings\)/);
  assert.match(mainSource, /host\.call\("settings\.set", validatedSettings\)/);
  assert.doesNotMatch(mainSource, /host\.call\("settings\.set", normalizedSettings\)/);
  assert.match(apiSource, /export function validateSettingsWrite/);
  assert.match(apiSource, /invoke\(IPC\.invoke\.settingsSet, validateSettingsWrite\(settings\)\)/);
  assert.match(mainSource, /hasOwnProperty\.call\(value, "defaultCommandShell"\)/);
  assert.match(mainSource, /COMMAND_SHELL_INVALID/);
  assert.match(apiSource, /hasOwnProperty\.call\(value, "defaultCommandShell"\)/);
  assert.match(apiSource, /normalizeLargePasteThreshold/);
  assert.match(apiSource, /hasOwnProperty\.call\(value, "largePasteThreshold"\)/);
  assert.doesNotMatch(mainSource, /planApprovalPermissionMode/);
  assert.doesNotMatch(apiSource, /planApprovalPermissionMode/);
});

test("renderer notification drops silently when the render frame is disposed", () => {
  const sendStart = mainSource.indexOf("function sendToRenderer(");
  const sendEnd = mainSource.indexOf(
    "function resetMenuRendererReady",
    sendStart,
  );
  const sendSource = mainSource.slice(sendStart, sendEnd);
  assert.ok(sendSource.includes("window.webContents.send(channel, payload)"));
  assert.ok(sendSource.includes("try {"));
  assert.ok(sendSource.includes("} catch {"));
  // A disposed frame during teardown is routine; logging it as an error would
  // spam the same line on every sidecar crash while the window is closed.
  assert.ok(
    !sendSource.includes("console.error") && !sendSource.includes("console.warn"),
    "disposed-frame sends are dropped silently",
  );
});

test("sidecar crash reports carry the last stderr lines", () => {
  assert.match(sidecarSource, /SIDECAR_STDERR_TAIL_LINES/);
  assert.match(sidecarSource, /private stderrTail/);
  assert.ok(
    sidecarSource.includes("h({ ...info, stderrTail })"),
    "exit handlers receive the stderr tail",
  );
  assert.ok(
    sidecarSource.includes("this.stderrTail.slice()"),
    "stderr tail is snapshotted at exit",
  );
  assert.match(mainSource, /agent sidecar exited unexpectedly/);
  assert.ok(
    mainSource.includes("data: { exitCode: code, signal, stderrTail }"),
    "crash log carries the tail",
  );
});
