import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESUMABLE_CHAINS_PER_AGENT } from "@pi-desktop/shared";
import { DelegationChainRegistry } from "./delegation-chain.js";
import type { DelegationChain } from "./delegation-history.js";

const NONE = new Set<string>();

type StartOptions = {
  delegateSessionId: string;
  delegationId: string;
  agentName?: string;
  toolCallId?: string;
  originalTask?: string;
  objective?: string;
  modelId?: string;
  modelKey?: string;
};

function start(
  registry: DelegationChainRegistry,
  options: StartOptions,
): DelegationChain {
  return registry.start({
    delegateSessionId: options.delegateSessionId,
    delegationId: options.delegationId,
    toolCallId: options.toolCallId ?? `call-${options.delegationId}`,
    agentName: options.agentName ?? "explorer",
    originalTask: options.originalTask ?? "explore the parser",
    objective: options.objective ?? "explore the parser",
    ...(options.modelId ? { latestModelId: options.modelId } : {}),
    ...(options.modelKey ? { latestModelKey: options.modelKey } : {}),
  });
}

function chain(
  overrides: Partial<DelegationChain> = {},
): DelegationChain {
  return {
    delegateSessionId: "res-1",
    toolCallIds: ["call-1", "call-2", "call-3"],
    delegationIds: ["del-1", "del-2", "del-3"],
    agentName: "explorer",
    readFiles: [],
    readLineCount: 0,
    latestDelegationId: "del-3",
    latestObjective: "third run",
    lastActivityAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hydrate / lookup", () => {
  it("resolves a chain from any delegationId on it, middle ids included", () => {
    const registry = new DelegationChainRegistry();
    registry.hydrate([chain()]);

    for (const delegationId of ["del-1", "del-2", "del-3"]) {
      expect(registry.lookup(delegationId)).toMatchObject({
        delegateSessionId: "res-1",
        agentName: "explorer",
      });
    }
    expect(registry.lookup("del-unknown")).toBeUndefined();
  });
});

describe("resolveResume", () => {
  it("reports an unknown id", () => {
    const registry = new DelegationChainRegistry();
    const result = registry.resolveResume({
      resume: "missing",
      agentName: "explorer",
      runningDelegationIds: NONE,
    });
    expect(result).toEqual({ ok: false, error: { kind: "unknown" } });
  });

  it("reports a chain whose latest run is still running", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    const result = registry.resolveResume({
      resume: "del-1",
      agentName: "explorer",
      runningDelegationIds: new Set(["del-1"]),
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "running", delegationId: "del-1" },
    });
  });

  it("reports a settled chain whose status is not resumable", () => {
    for (const status of ["stopped", "aborted", "interrupted"]) {
      const registry = new DelegationChainRegistry();
      start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
      registry.settle("res-1", status);
      expect(
        registry.resolveResume({
          resume: "del-1",
          agentName: "explorer",
          runningDelegationIds: NONE,
        }),
      ).toEqual({ ok: false, error: { kind: "not-resumable", status } });
    }
  });

  it("accepts every settled status a delegate can end on", () => {
    for (const status of ["completed", "failed", "timed_out"]) {
      const registry = new DelegationChainRegistry();
      start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
      registry.settle("res-1", status);
      const result = registry.resolveResume({
        resume: "del-1",
        agentName: "explorer",
        runningDelegationIds: NONE,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("reports an agent mismatch before any other gate", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    registry.settle("res-1", "completed");
    const result = registry.resolveResume({
      resume: "del-1",
      agentName: "reviewer",
      runningDelegationIds: new Set(["del-1"]),
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "agent-mismatch", expected: "explorer", actual: "reviewer" },
    });
  });

  it("reports a chain that read past the resume budget", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    registry.noteReads("res-1", ["huge.ts"], 50_001);
    registry.settle("res-1", "completed");
    expect(
      registry.resolveResume({
        resume: "del-1",
        agentName: "explorer",
        runningDelegationIds: NONE,
      }),
    ).toEqual({ ok: false, error: { kind: "over-budget" } });
  });

  it("accepts a chain exactly at the budget", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    registry.noteReads("res-1", ["big.ts"], 50_000);
    registry.settle("res-1", "completed");
    expect(
      registry.resolveResume({
        resume: "del-1",
        agentName: "explorer",
        runningDelegationIds: NONE,
      }).ok,
    ).toBe(true);
  });
});

describe("resumableList / promptBlock", () => {
  it("excludes running, non-resumable and over-budget chains, newest first", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const registry = new DelegationChainRegistry();
    // One agent per excluded case: eviction is per agent, so a third settled
    // chain for `explorer` would drop the two the ordering check needs.
    start(registry, { delegateSessionId: "res-a", delegationId: "del-a" });
    registry.settle("res-a", "completed");
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-b", delegationId: "del-b" });
    registry.settle("res-b", "completed");
    // Rebuilt from the transcript at launch: no settled status recorded yet.
    registry.hydrate([
      ...registry.resumableList({ runningDelegationIds: NONE }),
      chain({
        delegateSessionId: "res-c",
        toolCallIds: ["task-c"],
        delegationIds: ["del-c"],
        agentName: "fixer",
        latestDelegationId: "del-c",
        latestObjective: "still working",
        lastActivityAt: 1_700_000_009_000,
      }),
    ]);
    start(registry, {
      delegateSessionId: "res-d",
      delegationId: "del-d",
      agentName: "reviewer",
    });
    registry.settle("res-d", "stopped");
    start(registry, {
      delegateSessionId: "res-e",
      delegationId: "del-e",
      agentName: "test-runner",
    });
    registry.noteReads("res-e", ["huge.ts"], 50_001);
    registry.settle("res-e", "completed");

    expect(
      registry
        .resumableList({ runningDelegationIds: new Set(["del-c"]) })
        .map((entry) => entry.latestDelegationId),
    ).toEqual(["del-b", "del-a"]);
    // A chain whose status is unknown is only held back while it is running.
    expect(
      registry
        .resumableList({ runningDelegationIds: NONE })
        .map((entry) => entry.latestDelegationId),
    ).toEqual(["del-c", "del-b", "del-a"]);
  });

  it("prompts with the agent, the id, the objective and the files it read", () => {
    const registry = new DelegationChainRegistry();
    start(registry, {
      delegateSessionId: "res-1",
      delegationId: "del-1",
      objective: "explore the parser",
    });
    registry.noteReads(
      "res-1",
      ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts", "a6.ts", "a7.ts", "a8.ts", "a9.ts"],
      9,
    );
    registry.settle("res-1", "completed");
    start(registry, {
      delegateSessionId: "res-2",
      delegationId: "del-2",
      agentName: "reviewer",
      objective: "",
    });
    registry.settle("res-2", "failed");

    const block = registry.promptBlock({ runningDelegationIds: NONE });
    expect(block).toContain("explorer / del-1: explore the parser");
    expect(block).toContain("Files read: a1.ts, a2.ts");
    expect(block).toContain("(+1 more)");
    expect(block).toContain("reviewer / del-2: (no label)");
    expect(block).toContain("reviewer / del-2");
  });

  it("says so when a chain read nothing", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    registry.settle("res-1", "completed");
    expect(registry.promptBlock({ runningDelegationIds: NONE })).toContain(
      "Files read: none recorded",
    );
  });
});

describe("LRU eviction", () => {
  it("never evicts a running chain and drops the oldest settled one", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const registry = new DelegationChainRegistry();
    // The running chain is the *oldest* activity of the group: a naive LRU
    // would drop it first, stranding the delegate still writing into it.
    start(registry, { delegateSessionId: "res-run", delegationId: "del-run" });
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-a", delegationId: "del-a" });
    registry.settle("res-a", "completed");
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-b", delegationId: "del-b" });
    registry.settle("res-b", "completed");
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-c", delegationId: "del-c" });
    registry.settle("res-c", "completed");

    expect(registry.lookup("del-run")).toMatchObject({
      latestStatus: "running",
    });
    expect(registry.lookup("del-a")).toBeUndefined();
    expect(registry.lookup("del-b")).toBeDefined();
    expect(registry.lookup("del-c")).toBeDefined();

    const listed = registry.resumableList({
      runningDelegationIds: new Set(["del-run"]),
    });
    expect(listed.map((entry) => entry.latestDelegationId)).toEqual([
      "del-c",
      "del-b",
    ]);
    expect(listed).toHaveLength(MAX_RESUMABLE_CHAINS_PER_AGENT);
  });

  it("keeps every chain when only two per agent are settled", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-a", delegationId: "del-a" });
    registry.settle("res-a", "completed");
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-b", delegationId: "del-b" });
    registry.settle("res-b", "completed");
    vi.advanceTimersByTime(1_000);
    start(registry, { delegateSessionId: "res-run", delegationId: "del-run" });
    // Re-settling an already settled chain is what triggers the sweep here.
    registry.settle("res-b", "completed");

    for (const delegationId of ["del-a", "del-b", "del-run"]) {
      expect(registry.lookup(delegationId)).toBeDefined();
    }
    expect(registry.lookup("del-run")).toMatchObject({
      latestStatus: "running",
    });
  });

  it("evicts per agent, not across agents", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const registry = new DelegationChainRegistry();
    const settled: Array<[string, string]> = [
      ["res-e1", "del-e1"],
      ["res-e2", "del-e2"],
      ["res-e3", "del-e3"],
    ];
    for (const [delegateSessionId, delegationId] of settled) {
      vi.advanceTimersByTime(1_000);
      start(registry, { delegateSessionId, delegationId });
      registry.settle(delegateSessionId, "completed");
    }
    vi.advanceTimersByTime(1_000);
    start(registry, {
      delegateSessionId: "res-r1",
      delegationId: "del-r1",
      agentName: "reviewer",
    });
    registry.settle("res-r1", "completed");

    expect(registry.lookup("del-e1")).toBeUndefined();
    expect(registry.lookup("del-r1")).toBeDefined();
  });
});

describe("noteReads", () => {
  it("merges files, adds new lines and keeps the chain identity", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    registry.noteReads("res-1", ["a.ts", "b.ts"], 3);
    registry.noteReads("res-1", ["b.ts", "c.ts"], 2);

    expect(registry.lookup("del-1")).toMatchObject({
      readFiles: ["a.ts", "b.ts", "c.ts"],
      readLineCount: 5,
    });
  });

  it("returns silently for a chain it does not hold", () => {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-1", delegationId: "del-1" });
    expect(() => registry.noteReads("res-missing", ["x.ts"], 10)).not.toThrow();
    expect(registry.lookup("del-1")).toMatchObject({
      readFiles: [],
      readLineCount: 0,
    });
    expect(
      registry.resumableList({ runningDelegationIds: NONE }),
    ).toHaveLength(0);
  });
});

describe("retarget", () => {
  it("updates the model and keeps the last known key when none is given", () => {
    const registry = new DelegationChainRegistry();
    start(registry, {
      delegateSessionId: "res-1",
      delegationId: "del-1",
      modelId: "m1",
      modelKey: "local/m1",
    });
    registry.retarget("res-1", { modelKey: "remote/m2", modelId: "m2" });
    expect(registry.lookup("del-1")).toMatchObject({
      latestModelId: "m2",
      latestModelKey: "remote/m2",
    });

    registry.retarget("res-1", { modelId: "m3" });
    expect(registry.lookup("del-1")).toMatchObject({
      latestModelId: "m3",
      latestModelKey: "remote/m2",
    });
  });

  it("returns silently for a chain it does not hold", () => {
    const registry = new DelegationChainRegistry();
    expect(() =>
      registry.retarget("res-missing", { modelId: "m1" }),
    ).not.toThrow();
  });
});

describe("drop", () => {
  it("removes every delegationId on the chain", () => {
    const registry = new DelegationChainRegistry();
    registry.hydrate([chain()]);
    registry.drop("res-1");
    for (const delegationId of ["del-1", "del-2", "del-3"]) {
      expect(registry.lookup(delegationId)).toBeUndefined();
    }
    expect(registry.resumableList({ runningDelegationIds: NONE })).toEqual([]);
  });
});

describe("resume error messages", () => {
  function registryWithChain(): DelegationChainRegistry {
    const registry = new DelegationChainRegistry();
    start(registry, { delegateSessionId: "res-a", delegationId: "del-a" });
    registry.settle("res-a", "completed");
    return registry;
  }

  it("says there is nothing to reuse when the list is empty", () => {
    const registry = new DelegationChainRegistry();
    const unknown = registry.unknownResumeError("missing", []);
    expect(unknown).toContain('Unknown delegation "missing".');
    expect(unknown).toContain("No reusable subagent sessions in this conversation.");
    expect(unknown).not.toContain("Reusable:");

    const noHistory = registry.noHistoryResumeError("del-a", []);
    expect(noHistory).toContain('Delegation "del-a" has no recorded history');
    expect(noHistory).toContain("Start a new delegation.");
    expect(noHistory).not.toContain("Reusable:");
  });

  it("hints at the reusable chains it was given", () => {
    const registry = registryWithChain();
    const list = registry.resumableList({ runningDelegationIds: NONE });
    expect(list).toHaveLength(1);
    expect(registry.unknownResumeError("missing", list)).toContain(
      "Reusable: explorer / del-a.",
    );
  });

  it("never advertises the dropped id as reusable", () => {
    const registry = registryWithChain();
    // The caller drops the chain before composing the message (ADR 0279 §4),
    // so the id it names must not come back as its own suggestion.
    registry.drop("res-b");
    const list = registry.resumableList({ runningDelegationIds: NONE });
    const message = registry.noHistoryResumeError("del-b", list);
    expect(message).toContain('Delegation "del-b" has no recorded history');
    expect(message).toContain("Reusable: explorer / del-a.");
    expect(message).not.toContain("Reusable: explorer / del-b");
  });
});
