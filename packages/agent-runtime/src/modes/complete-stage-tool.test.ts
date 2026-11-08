import { describe, expect, it, vi } from "vitest";
import type { ModeTurnContext } from "@pi-desktop/shared";
import {
  createCompleteStageTool,
  parseCompleteStageParams,
  type ModeGateCommand,
  type ModeGateRunResult,
} from "./complete-stage-tool.js";

const TURN: ModeTurnContext = {
  runId: "run-1",
  stageId: "work",
  origin: "user",
  enteredStage: true,
  input: "Make checkout work",
  artifactPaths: { goal: ".pi/goals/run-1.md" },
};

const RUN = { id: "run-1" };

type Harness = {
  host: { call: ReturnType<typeof vi.fn> };
  gates: ModeGateCommand[];
  endTurn: ReturnType<typeof vi.fn>;
  tool: ReturnType<typeof createCompleteStageTool>;
};

/** Host mock at the RPC boundary: scripted answers per `modes.*` method. */
function harness(
  answers: Record<string, unknown[]>,
  options: { claimed?: boolean; gate?: (request: ModeGateCommand) => Promise<ModeGateRunResult> } = {},
): Harness {
  const queues = Object.fromEntries(Object.entries(answers).map(([method, list]) => [method, [...list]]));
  const host = {
    call: vi.fn(async (method: string) => {
      const next = queues[method]?.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`unexpected host call ${method}`);
      return next;
    }),
  };
  const gates: ModeGateCommand[] = [];
  const endTurn = vi.fn();
  const tool = createCompleteStageTool({
    host: host as never,
    sessionId: "session-1",
    context: () => (options.claimed === false ? undefined : { turnId: "turn-1", modeTurn: TURN }),
    runGateCommand: async (request) => {
      gates.push(request);
      return options.gate ? options.gate(request) : { isError: false, text: "ok" };
    },
    endTurn,
  });
  return { host, gates, endTurn, tool };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

describe("CompleteStage", () => {
  it("hands the summary and artifacts to modes.completeStage", async () => {
    const { host, tool, endTurn } = harness({ "modes.completeStage": [{ status: "finished", run: RUN }] });
    await tool.execute("call-1", { summary: " Done ", artifacts: { goal: "# Objective\n" } });

    expect(host.call).toHaveBeenCalledWith("modes.completeStage", {
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      summary: "Done",
      artifacts: { goal: "# Objective\n" },
    });
    expect(endTurn).toHaveBeenCalledTimes(1);
  });

  it("reports a failed check with its message and the retries left, and keeps the turn going", async () => {
    const { tool, endTurn } = harness({
      "modes.completeStage": [{ status: "failed", gateIndex: 0, message: "missing heading Evidence", retriesLeft: 2, run: RUN }],
    });
    const result = await tool.execute("call-1", { summary: "Done" }) as { isError?: boolean; terminate?: boolean; content: Array<{ type: string; text?: string }> };

    expect(text(result)).toContain("Exit check 1 failed: missing heading Evidence");
    expect(text(result)).toContain("2 retries left");
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(endTurn).not.toHaveBeenCalled();
  });

  it("runs every run gate with a fresh call id and reports each verdict until an outcome settles", async () => {
    const { host, tool, gates, endTurn } = harness({
      "modes.completeStage": [{ status: "run", gateIndex: 0, command: "npm test", timeoutMinutes: 5, run: RUN }],
      "modes.gateResult": [
        { status: "run", gateIndex: 1, command: "npm run lint", timeoutMinutes: 1, run: RUN },
        { status: "advanced", nextStageId: "review", run: RUN },
      ],
    });
    const result = await tool.execute("model-call", { summary: "Done" }) as { terminate?: boolean; content: Array<{ type: string; text?: string }> };

    expect(gates.map((gate) => [gate.command, gate.modeGate, gate.timeoutSeconds])).toEqual([
      ["npm test", { runId: "run-1", gateIndex: 0 }, 300],
      ["npm run lint", { runId: "run-1", gateIndex: 1 }, 60],
    ]);
    const ids = gates.map((gate) => gate.toolCallId);
    expect(new Set([...ids, "model-call"]).size).toBe(3);
    expect(host.call.mock.calls.filter(([method]) => method === "modes.gateResult").map(([, params]) => params)).toEqual([
      { sessionId: "session-1", runId: "run-1", turnId: "turn-1", gateIndex: 0, toolCallId: ids[0] },
      { sessionId: "session-1", runId: "run-1", turnId: "turn-1", gateIndex: 1, toolCallId: ids[1] },
    ]);
    expect(text(result)).toContain("advances to stage `review`");
    expect(result.terminate).toBe(true);
    expect(endTurn).toHaveBeenCalledTimes(1);
  });

  it("returns a failed gate verdict to the model and keeps the turn going", async () => {
    const { tool, endTurn } = harness({
      "modes.completeStage": [{ status: "run", gateIndex: 0, command: "npm test", timeoutMinutes: 5, run: RUN }],
      "modes.gateResult": [{ status: "failed", gateIndex: 0, message: "exit code 1: 2 tests failed", retriesLeft: 1, run: RUN }],
    }, { gate: async () => ({ isError: true, text: "2 tests failed" }) });
    const result = await tool.execute("call-1", { summary: "Done" }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    expect(text(result)).toContain("exit code 1: 2 tests failed");
    expect(text(result)).toContain("1 retry left");
    expect(result.isError).toBe(true);
    expect(endTurn).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "advanced", nextStageId: "review", run: RUN }, "advances to stage `review`"],
    [{ status: "goto", nextStageId: "draft", message: "Tests failed", run: RUN }, "moves to stage `draft`"],
    [{ status: "blocked", message: "Retries exhausted", run: RUN }, "The stage is blocked: Retries exhausted"],
    [{ status: "awaiting_approval", run: RUN }, "awaits the user's approval"],
    [{ status: "finished", run: RUN }, "the run is finished"],
  ])("ends the turn gracefully on %o", async (outcome, fragment) => {
    const { tool, endTurn } = harness({ "modes.completeStage": [outcome] });
    const result = await tool.execute("call-1", { summary: "Done" }) as { isError?: boolean; terminate?: boolean; content: Array<{ type: string; text?: string }> };

    expect(text(result)).toContain(fragment);
    expect(text(result)).toContain("this turn ends now");
    expect(result.terminate).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(endTurn).toHaveBeenCalledTimes(1);
  });

  it("refuses without a run claim and never calls the Host", async () => {
    const { host, tool } = harness({}, { claimed: false });
    const result = await tool.execute("call-1", { summary: "Done" }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("only in a turn of an active mode run");
    expect(host.call).not.toHaveBeenCalled();
  });

  it("ends the turn when the Host says the claim is gone", async () => {
    const lost = Object.assign(new Error("claim mismatch"), { data: { errorCode: "MODE_CLAIM_MISMATCH" } });
    const { tool, endTurn } = harness({ "modes.completeStage": [lost] });
    const result = await tool.execute("call-1", { summary: "Done" }) as { terminate?: boolean; content: Array<{ type: string; text?: string }> };
    expect(text(result)).toContain("MODE_CLAIM_MISMATCH");
    expect(result.terminate).toBe(true);
    expect(endTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects an outcome that would loop on the same gate", async () => {
    const { tool, gates } = harness({
      "modes.completeStage": [{ status: "run", gateIndex: 0, command: "npm test", timeoutMinutes: 5, run: RUN }],
      "modes.gateResult": [{ status: "run", gateIndex: 0, command: "npm test", timeoutMinutes: 5, run: RUN }],
    });
    const result = await tool.execute("call-1", { summary: "Done" }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(gates).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("MODE_OUTCOME_INVALID");
  });

  it("validates the model's arguments before calling the Host", () => {
    expect(parseCompleteStageParams({ summary: "ok" })).toEqual({ summary: "ok" });
    expect(parseCompleteStageParams({ summary: "" })).toContain("summary");
    expect(parseCompleteStageParams({ summary: "ok", extra: 1 })).toContain("unknown argument");
    expect(parseCompleteStageParams({ summary: "ok", artifacts: { Goal: "x" } })).toContain("invalid");
    expect(parseCompleteStageParams({ summary: "ok", artifacts: { goal: 3 } })).toContain("Markdown string");
  });
});
