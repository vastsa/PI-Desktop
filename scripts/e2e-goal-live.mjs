#!/usr/bin/env node
/**
 * Opt-in live acceptance of the builtin Goal mode against a real model
 * (ADR mode-definitions). This calls a paid model API: run it only with the
 * account owner's authorization.
 *
 * Real pieces: an isolated candidate Host process, the production
 * DesktopAgentRuntime loop and Electron main's mode run coordinator
 * (`apps/desktop/electron/main/runtime/mode-runs.ts`). The harness plays the
 * sidecar and the user: it dispatches the turns the coordinator asks for and
 * presses Pause / Edit / Remove at fixed points.
 *
 * Environment:
 *   PI_SCRATCH_DIR            isolated test state (required)
 *   PI_LIVE_BASE_URL          OpenAI-compatible base URL (required)
 *   PI_LIVE_MODEL             model id (required)
 *   PI_LIVE_API_KEY           API key, or load it from an encrypted secrets
 *   PI_LIVE_SECRETS_DIR +     directory copy (`<data>/secrets`) and its
 *   PI_LIVE_SECRET_REF        secret ref; the key is never printed
 *   PI_DESKTOP_HOST_BIN       candidate Host binary (optional)
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { register } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { builtinModeDefinition } from "../packages/agent-runtime/dist/mode-definitions.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { beginTurn, createSession, endTurn } from "./e2e/session.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
register(pathToFileURL(join(here, "../apps/desktop/test/helpers/ts-import-hooks.mjs")));
const { createModeRunCoordinator } = await import("../apps/desktop/electron/main/runtime/mode-runs.ts");

const scratchRoot = process.env.PI_SCRATCH_DIR;
assert.ok(scratchRoot, "PI_SCRATCH_DIR is required for isolated test state");
const baseUrl = process.env.PI_LIVE_BASE_URL;
const modelId = process.env.PI_LIVE_MODEL;
assert.ok(baseUrl && modelId, "PI_LIVE_BASE_URL and PI_LIVE_MODEL are required");
const scratch = join(scratchRoot, `goal-live-${Date.now()}`);
await mkdir(scratch, { recursive: true });
const hostBinary = resolveHostBinary();

/** Read the key through a throwaway Host over a copy of the secrets directory. */
async function loadApiKey() {
  if (process.env.PI_LIVE_API_KEY) return process.env.PI_LIVE_API_KEY;
  const dir = process.env.PI_LIVE_SECRETS_DIR;
  const ref = process.env.PI_LIVE_SECRET_REF;
  assert.ok(dir && ref, "set PI_LIVE_API_KEY, or PI_LIVE_SECRETS_DIR and PI_LIVE_SECRET_REF");
  // Only the machine key and the one secret file are copied.
  const data = join(scratch, "credentials");
  await mkdir(join(data, "secrets"), { recursive: true });
  const file = `${createHash("sha256").update(ref).digest("hex")}.bin`;
  for (const name of [".machine-key", file]) await cp(join(dir, name), join(data, "secrets", name));
  const host = new Host(hostBinary, data, { quiet: true });
  try {
    await host.start();
    const { value } = await host.call("secrets.getForRuntime", { secretRef: ref });
    assert.ok(typeof value === "string" && value.length > 0, "secret not found");
    return value;
  } finally {
    await host.stop();
    await rm(data, { recursive: true, force: true });
  }
}

const provider = {
  id: "live", name: "Live", baseUrl, modelId, apiKey: await loadApiKey(),
  authKind: "api_key_and_base_url", apiStyle: "chat_completions",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const goal = builtinModeDefinition("goal");

const host = new Host(hostBinary, join(scratch, "data"), { quiet: true });
await host.start();
const { effective: commandShell } = await host.call("commandShells.list");

/** Electron main's coordinator, wired to this harness instead of the sidecar. */
const sessions = new Map();
const coordinator = createModeRunCoordinator({
  getHost: () => host,
  catalog: { definition: async (id) => builtinModeDefinition(id) },
  startContinuation: async (sessionId, origin, content) => {
    const session = sessions.get(sessionId);
    session.queue.push({ origin, content });
  },
  abortTurn: async (sessionId) => sessions.get(sessionId)?.runtime.abort(),
  notifyTurn: async (sessionId, turnId, notice) => {
    const session = sessions.get(sessionId);
    session.notices.push({ turnId, action: notice.action, applied: session.runtime.modeTurnNotice({ turnId, ...notice }).applied });
  },
  logger: { app: (...args) => console.error("[main]", ...args.slice(2, 3)) },
  isQuitting: () => false,
});

// The user approves Bash in the workspace (Host-started turns run at accept-edits).
const approved = new Set();
const approver = setInterval(() => {
  for (const note of host.matchingNotifications("permissions.request")) {
    const requestId = note.params?.requestId;
    if (!requestId || approved.has(requestId)) continue;
    approved.add(requestId);
    void host.call("permissions.resolve", { requestId, decision: "allow-session" }).catch(() => undefined);
  }
}, 100);

async function openGoalSession(title) {
  const workspace = join(scratch, title);
  await mkdir(workspace, { recursive: true });
  const created = await createSession(host, workspace, title);
  await host.call("session.configure", { id: created.id, mode: "goal", modeSnapshot: goal, permissionMode: "auto" });
  const session = { id: created.id, workspace, queue: [], notices: [], turns: [], onEvent: () => undefined };
  session.runtime = new DesktopAgentRuntime({
    host, sessionId: created.id, mode: "goal", modeDefinition: goal, projectPath: workspace,
    provider, commandShell, thinkingLevel: "off",
    onEvent: (envelope) => session.onEvent(envelope.event, session),
  });
  sessions.set(created.id, session);
  return session;
}

/** One durable turn the way Main dispatches it, with the per-turn event log. */
async function runTurn(session, origin, content) {
  const { session: row } = await host.call("session.get", { id: session.id, messageLimit: 1 });
  const turnId = await beginTurn(host, session.id);
  const prepared = await coordinator.prepareTurn({ sessionId: session.id, turnId, sessionMode: row.mode, content, origin });
  session.runtime.setMode(row.mode, prepared?.definition ?? builtinModeDefinition(row.mode));
  const turn = { turnId, origin, mode: row.mode, input: prepared?.modeTurn.input, requests: 0, tools: [], tokens: 0, aborted: false };
  session.turns.push(turn);
  session.current = turn;
  let reason = "completed";
  try {
    await session.runtime.prompt({ text: content, ...(prepared ? { modeTurn: prepared.modeTurn } : {}) }, undefined, turnId);
    if (turn.aborted) reason = "aborted";
  } catch (error) {
    reason = turn.aborted ? "aborted" : "error";
    turn.error = String(error?.message ?? error);
  }
  await endTurn(host, turnId, reason === "completed" ? "completed" : "aborted");
  await coordinator.settleTurn(session.id, turnId, {
    reason, usage: { inputTokens: turn.tokens, outputTokens: 0 }, ...(reason === "error" ? { errorCode: "TURN_FAILED" } : {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return turn;
}

/** Drain Host-requested continuations, at most `limit` turns. */
async function drain(session, limit) {
  for (let count = 0; count < limit && session.queue.length; count += 1) {
    const next = session.queue.shift();
    await runTurn(session, next.origin, next.content);
  }
}

function track(event, session) {
  const turn = session.current;
  if (!turn) return;
  if (event.type === "turn_start") turn.requests += 1;
  if (event.type === "tool_start") turn.tools.push({ name: event.toolName, request: turn.requests });
  if (event.type === "usage") turn.tokens += (event.usage?.inputTokens ?? 0) + (event.usage?.outputTokens ?? 0);
}

const run = async (sessionId) => (await host.call("modes.get", { sessionId })).run;
const sessionMode = async (sessionId) => (await host.call("session.get", { id: sessionId, messageLimit: 1 })).session.mode;
const report = {};
const timeout = setTimeout(() => {
  console.error("goal live acceptance exceeded 25 minutes");
  process.exit(2);
}, 25 * 60_000);

try {
  // A) Settings budget -> autonomous turns -> verified completion -> Agent.
  await host.call("settings.set", { goalBudget: { maxTurns: 6, maxTokens: null } });
  const a = await openGoalSession("complete");
  a.onEvent = track;
  await runTurn(a, "user", "In the workspace, create the file notes/hello.txt containing exactly the line `hello goal`, then verify its content with a shell command.");
  // The run's first announced state carries the budget it started with.
  const startedBudget = host.matchingNotifications("modes.changed", (note) => note.params?.sessionId === a.id)[0]?.params.run?.maxTurns;
  await drain(a, 6);
  const aRun = await run(a.id);
  const goalFiles = await readdir(join(a.workspace, ".pi/goals")).catch(() => []);
  const artifact = goalFiles[0] ? await readFile(join(a.workspace, ".pi/goals", goalFiles[0]), "utf8") : "";
  report.complete = {
    turns: a.turns.map((turn) => ({ origin: turn.origin, mode: turn.mode, requests: turn.requests, tools: turn.tools.map((tool) => tool.name) })),
    budgetAtStart: startedBudget,
    openRunAfter: aRun,
    sessionMode: await sessionMode(a.id),
    hello: await readFile(join(a.workspace, "notes/hello.txt"), "utf8").catch(() => null),
    artifactHeadings: ["# Objective", "# Acceptance criteria", "# Evidence"].map((heading) => artifact.includes(heading)),
  };
  assert.equal(startedBudget, 6, "a new Goal run takes the settings budget");
  assert.equal(aRun, null, "the Goal run finished");
  assert.equal(report.complete.sessionMode, "agent");
  assert.equal(report.complete.hello?.trim(), "hello goal");
  assert.deepEqual(report.complete.artifactHeadings, [true, true, true]);
  assert.ok(a.turns.some((turn) => turn.tools.some((tool) => tool.name === "CompleteStage")));

  // B) Edit + Pause mid-turn: closeout within 3 requests, no continuation;
  //    Resume -> the next turn receives the edited objective.
  const b = await openGoalSession("pause");
  let pausedAt;
  b.onEvent = (event, session) => {
    track(event, session);
    const turn = session.current;
    if (pausedAt === undefined && turn?.origin === "user" && event.type === "tool_end") {
      pausedAt = turn.requests;
      void (async () => {
        const open = await run(session.id);
        const edited = await coordinator.update({
          sessionId: session.id, runId: open.id, expectedRevision: open.revision,
          input: "In the workspace, create count.txt with the numbers 1 to 5, one per line, then verify it with a shell command.",
          budget: { maxTurns: 8, maxTokens: null },
        });
        await coordinator.control({ sessionId: session.id, runId: open.id, expectedRevision: edited.run.revision, action: "pause" });
      })().catch((error) => { session.controlError = String(error); });
    }
  };
  await runTurn(b, "user", "In the workspace, create count.txt with the numbers 1 to 3, one per line, then verify it with a shell command. Work in small steps: one tool call per reply.");
  const paused = await run(b.id);
  const firstTurn = b.turns[0];
  report.pause = {
    pausedAtRequest: pausedAt,
    requestsInTurn: firstTurn.requests,
    requestsAfterPause: pausedAt === undefined ? null : firstTurn.requests - pausedAt,
    notices: b.notices,
    stateAfterTurn: paused?.state,
    inputAfterEdit: paused?.input,
    maxTurnsAfterEdit: paused?.maxTurns,
    queuedAfterPause: b.queue.length,
    controlError: b.controlError,
  };
  assert.equal(b.controlError, undefined);
  assert.equal(paused?.state, "paused");
  assert.equal(b.queue.length, 0, "a paused run starts no turn");
  assert.ok(report.pause.requestsAfterPause !== null && report.pause.requestsAfterPause <= 3, "closeout within 3 requests");
  assert.deepEqual(b.notices.map((notice) => [notice.action, notice.applied]), [["closeout", true]]);
  await coordinator.control({ sessionId: b.id, runId: paused.id, expectedRevision: paused.revision, action: "resume" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await drain(b, 8);
  report.pause.resumed = b.turns.slice(1).map((turn) => ({ origin: turn.origin, input: turn.input, requests: turn.requests }));
  report.pause.finalRun = await run(b.id);
  report.pause.count = await readFile(join(b.workspace, "count.txt"), "utf8").catch(() => null);
  assert.ok(b.turns[1], "Resume started a turn");
  assert.match(b.turns[1].input, /1 to 5/, "the next turn carries the edited objective");
  assert.equal(report.pause.finalRun, null, "the resumed run finished");
  assert.deepEqual(report.pause.count?.trim().split(/\r?\n/), ["1", "2", "3", "4", "5"], "the run met the edited objective");

  // C) Remove mid-turn: the run ends, the turn finishes as Agent, nothing follows.
  const c = await openGoalSession("remove");
  let removedAt;
  c.onEvent = (event, session) => {
    track(event, session);
    const turn = session.current;
    if (removedAt === undefined && event.type === "tool_end") {
      removedAt = turn.requests;
      void (async () => {
        const open = await run(session.id);
        await coordinator.control({ sessionId: session.id, runId: open.id, expectedRevision: open.revision, action: "remove" });
      })().catch((error) => { session.controlError = String(error); });
    }
  };
  await runTurn(c, "user", "In the workspace, create bye.txt containing `bye`, then verify it with a shell command. Work in small steps: one tool call per reply.");
  const turnC = c.turns[0];
  report.remove = {
    removedAtRequest: removedAt,
    requests: turnC.requests,
    toolsAfterRemove: turnC.tools.filter((tool) => tool.request > removedAt).map((tool) => tool.name),
    notices: c.notices,
    error: turnC.error,
    openRunAfter: await run(c.id),
    sessionMode: await sessionMode(c.id),
    runtimeMode: c.runtime.getMode(),
    queued: c.queue.length,
  };
  assert.equal(c.controlError, undefined);
  assert.equal(turnC.error, undefined, "the turn was not interrupted");
  assert.deepEqual(c.notices.map((notice) => [notice.action, notice.applied]), [["release", true]]);
  assert.equal(report.remove.openRunAfter, null);
  assert.equal(report.remove.sessionMode, "agent");
  assert.equal(report.remove.runtimeMode, "agent");
  assert.equal(c.queue.length, 0, "no Host-started turn after Remove");
  assert.ok(!report.remove.toolsAfterRemove.includes("CompleteStage"));

  console.log(JSON.stringify({ ok: true, model: modelId, report }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, model: modelId, error: String(error?.stack ?? error), report }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  clearInterval(approver);
  for (const session of sessions.values()) await session.runtime.dispose().catch(() => undefined);
  await host.stop();
}
