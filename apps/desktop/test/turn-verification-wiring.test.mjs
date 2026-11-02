import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Turn verification is observational by contract: `finishTurn` may report how a
// turn ended, but it must never change the decision that drives the next
// provider request. These assertions pin the wiring, not the classifier (which
// `packages/agent-runtime/src/turn-verification.test.ts` covers directly).

const runtimeSource = await readFile(
  new URL("../../../packages/agent-runtime/src/runtime.ts", import.meta.url),
  "utf8",
);
const sidecarSource = await readFile(
  new URL("../electron/main/runtime/sidecar.ts", import.meta.url),
  "utf8",
);

test("finishTurn records the turn verdict before any graceful-stop decision", () => {
  const finishTurnAt = runtimeSource.indexOf("finishTurn: async (turn) =>");
  assert.ok(finishTurnAt > 0, "finishTurn should take the whole turn context");

  const body = runtimeSource.slice(finishTurnAt, finishTurnAt + 600);
  const recordAt = body.indexOf("this.recordTurnVerdict(turn);");
  const gracefulAt = body.indexOf("this.gracefulStopRequested");
  assert.ok(recordAt >= 0, "finishTurn should call recordTurnVerdict");
  assert.ok(gracefulAt > recordAt, "the verdict is recorded even when no stop was requested");
});

test("the verdict is reported as a diagnostic and never as a turn decision", () => {
  const start = runtimeSource.indexOf("private recordTurnVerdict(");
  assert.ok(start > 0, "recordTurnVerdict should exist");
  const end = runtimeSource.indexOf("private logEventHandlerFailure(", start);
  const method = runtimeSource.slice(start, end);

  assert.match(method, /kind: "turn_verification"/);
  assert.match(method, /this\.onDiagnostic\(/);
  // A returned decision here would add provider requests and change the
  // turn_end / agent_end sequence.
  assert.doesNotMatch(method, /action:\s*"(continue|end)"/);
  // Classification failure must be contained, not propagated into the turn.
  assert.match(method, /catch \(error\)/);
});

test("the diagnostic kind is declared on the runtime diagnostic contract", () => {
  assert.match(runtimeSource, /kind: "turn_verification";/);
});

test("Electron main logs turn verification without demanding a requestId", () => {
  const branchAt = sidecarSource.indexOf('diagnostic.kind === "turn_verification"');
  assert.ok(branchAt > 0, "sidecar should handle the turn_verification diagnostic");
  const branch = sidecarSource.slice(branchAt, branchAt + 700);

  assert.match(branch, /logger\.app\(/);
  assert.match(branch, /session\.turn\.verification/);
  // Compaction diagnostics carry a requestId; a turn verdict has none.
  assert.doesNotMatch(branch, /typeof diagnostic\.requestId === "string"/);
  assert.match(branch, /return;/);
});

test("the semantic judge runs off the turn boundary", () => {
  // `finishTurn` is awaited by the pi loop. Awaiting the judge there would make
  // every candidate turn wait on an extra provider request, so the call must be
  // fire-and-forget.
  assert.match(runtimeSource, /void this\.classifyTurnReply\(/);
  assert.doesNotMatch(runtimeSource, /await this\.classifyTurnReply\(/);
  // A judge that never answers must not leak a timer or a pending request.
  assert.match(runtimeSource, /TURN_VERDICT_JUDGE_TIMEOUT_MS/);
  assert.match(runtimeSource, /abort\.abort\(\)/);
});

test("a judge that cannot answer reports nothing", () => {
  const start = runtimeSource.indexOf("private async classifyTurnReply(");
  assert.ok(start > 0, "classifyTurnReply should exist");
  const end = runtimeSource.indexOf("private logEventHandlerFailure(", start);
  const method = runtimeSource.slice(start, end);

  // Only a confirmed CLAIMS answer may emit.
  assert.match(method, /parseVerdictReply\(result\.text\) !== "claims"/);
  assert.match(method, /this\.emitTurnVerdict\("suspicious", outcome\)/);
  // The catch block logs to stderr and returns; it must not emit a diagnostic.
  const catchAt = method.indexOf("catch (error)");
  assert.ok(catchAt > 0, "the judge must be contained");
  const catchBody = method.slice(catchAt);
  assert.doesNotMatch(catchBody, /onDiagnostic|emitTurnVerdict\("suspicious"/);
});
