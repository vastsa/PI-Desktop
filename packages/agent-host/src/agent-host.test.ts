import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventEnvelope,
  AskToolResolution,
  RacpEventEnvelope,
  RacpItemSummary,
  UiMessage,
} from "@pi-desktop/shared";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort, PendingToolRequest } from "./approvals.js";
import {
  MemoryQueueStore,
  type Clock,
  type IdSource,
  type Principal,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
  type TurnStartRequest,
} from "./ports.js";

class FixedClock implements Clock {
  constructor(public current = Date.parse("2026-09-10T00:00:00.000Z")) {}
  now(): number {
    return this.current;
  }
}

class SeqIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}

class FakeRuntime implements RuntimePort {
  prompts: TurnStartRequest[] = [];
  stops: string[] = [];
  aborts: Array<{ sessionId: string; turnId?: string }> = [];
  inputs: AskToolResolution[] = [];
  private counter = 0;
  failNext = false;
  async prompt(request: TurnStartRequest): Promise<{ turnId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error("runtime rejected"), { code: "AGENT_UNAVAILABLE" });
    }
    this.prompts.push(request);
    this.counter += 1;
    return { turnId: `rt_${this.counter}` };
  }
  async stop(sessionId: string): Promise<{ requested: boolean }> {
    this.stops.push(sessionId);
    return { requested: true };
  }
  async abort(sessionId: string, turnId?: string): Promise<void> {
    this.aborts.push({ sessionId, turnId });
  }
  async respondInput(resolution: AskToolResolution): Promise<void> {
    this.inputs.push(resolution);
  }
}

class FakeSessions implements SessionPort {
  summaries = new Map<string, SessionSummary>();
  items: RacpItemSummary[] = [];
  async get(sessionId: string): Promise<SessionSummary | null> {
    return this.summaries.get(sessionId) ?? null;
  }
  async history(): Promise<{ items: RacpItemSummary[]; hasMore: boolean }> {
    return { items: this.items, hasMore: false };
  }
}

class FakeApprovals implements ApprovalPort {
  tool: Array<{ requestId: string; decision: string }> = [];
  contract: Array<Record<string, unknown>> = [];
  pending: PendingToolRequest[] = [];
  async resolveTool(requestId: string, decision: "allow-once" | "allow-session" | "deny"): Promise<void> {
    this.tool.push({ requestId, decision });
  }
  async resolveContract(input: Record<string, unknown>): Promise<void> {
    this.contract.push(input);
  }
  async listPendingTools(sessionId?: string): Promise<PendingToolRequest[]> {
    return this.pending.filter((request) => !sessionId || request.sessionId === sessionId);
  }
}

const owner: Principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };
const controller: Principal = { subject: "phone", roles: ["controller"] };
const approver: Principal = { subject: "reviewer", roles: ["approver"] };
const viewer: Principal = { subject: "watcher", roles: ["viewer"] };

function summary(id: string, permissionMode: SessionSummary["permissionMode"] = "ask"): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    projectId: "proj",
    mode: "agent",
    permissionMode,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function message(id: string, content: string, status: UiMessage["status"] = "streaming"): UiMessage {
  return { id, role: "assistant", content, createdAt: "2026-09-10T00:00:00.000Z", status };
}

function envelope(sessionId: string, turnId: string | undefined, event: AgentEvent): AgentEventEnvelope {
  return { sessionId, ...(turnId ? { turnId } : {}), ts: Date.parse("2026-09-10T00:00:01.000Z"), event };
}

function build(options: { permissionMode?: SessionSummary["permissionMode"]; queueStore?: MemoryQueueStore; allowRemoteSessionGrants?: boolean } = {}) {
  const runtime = new FakeRuntime();
  const sessions = new FakeSessions();
  sessions.summaries.set("s1", summary("s1", options.permissionMode));
  const approvals = new FakeApprovals();
  const clock = new FixedClock();
  const host = new AgentHost({
    runtime,
    sessions,
    approvals,
    clock,
    ids: new SeqIds(),
    queueStore: options.queueStore,
    limits: { maxQueuedTurnsPerSession: 2 },
    allowRemoteSessionGrants: options.allowRemoteSessionGrants,
  });
  const received: RacpEventEnvelope[] = [];
  const sub = host.subscribe(viewer, { scope: "session", sessionId: "s1" }, { deliver: (event) => received.push(event), close: () => {} });
  return { runtime, sessions, approvals, clock, host, received, sub };
}

describe("AgentHost ingest", () => {
  it("maps a full turn to durable and ephemeral RACP events", () => {
    const { host, received } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "turn_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "message_start", message: message("m1", "") }));
    host.ingest(envelope("s1", "rt_1", { type: "message_update", message: message("m1", "Hel"), deltaText: "Hel" }));
    host.ingest(envelope("s1", "rt_1", { type: "message_end", message: message("m1", "Hello", "complete") }));
    host.ingest(envelope("s1", "rt_1", { type: "tool_start", toolCallId: "c1", toolName: "Read", args: { path: "a" } }));
    host.ingest(envelope("s1", "rt_1", { type: "tool_update", toolCallId: "c1", partialResult: "..." }));
    host.ingest(envelope("s1", "rt_1", { type: "tool_end", toolCallId: "c1", result: "ok" }));
    host.ingest(envelope("s1", "rt_1", { type: "turn_end" }));
    host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: ["m1"] }));

    const kinds = received.map((event) => `${event.kind}:${event.sequence ?? "e"}`);
    expect(kinds).toEqual([
      "turn.started:1",
      "turn.activity:e",
      "item.started:2",
      "item.delta:e",
      "item.completed:3",
      "item.started:4",
      "tool.progress:e",
      "item.completed:5",
      "turn.activity:e",
      "turn.completed:6",
      "session.changed:7",
    ]);
    const delta = received.find((event) => event.kind === "item.delta")!;
    expect(delta.afterSequence).toBe(2);
    expect((delta.payload as { event: AgentEvent }).event.type).toBe("message_update");
    expect((received[0]!.payload as { event: AgentEvent }).event).toEqual({ type: "agent_start" });
    expect(received.every((event) => event.epoch === received[0]!.epoch)).toBe(true);
    expect(host.getTurn("rt_1").status).toBe("completed");
  });

  it("keeps active items for the snapshot while streaming and clears them at the end", async () => {
    const { host } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "message_start", message: message("m1", "") }));
    host.ingest(envelope("s1", "rt_1", { type: "message_update", message: message("m1", "partial text") }));
    const streaming = await host.snapshot("s1");
    expect(streaming.activeTurn?.status).toBe("running");
    expect(streaming.activeItems).toHaveLength(1);
    expect((streaming.activeItems[0]!.content as UiMessage).content).toBe("partial text");
    expect(streaming.cursor.sequence).toBe(2);
    host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: [] }), { interrupted: true });
    const done = await host.snapshot("s1");
    expect(done.activeItems).toEqual([]);
    expect(done.activeTurn).toBeUndefined();
    expect(host.getTurn("rt_1").status).toBe("interrupted");
    expect(done.session.status).toBe("idle");
  });
});

describe("AgentHost turns", () => {
  it("starts immediately, applies the ceiling, and honors idempotency", async () => {
    const { host, runtime } = build({ permissionMode: "auto" });
    const started = await host.startTurn(controller, {
      sessionId: "s1",
      idempotencyKey: "k1",
      input: { text: "hello" },
      context: { requestId: "r1" },
    });
    expect(started.turn.status).toBe("running");
    expect(started.turn.effectivePermissionMode).toBe("ask");
    expect(runtime.prompts[0]!.effectivePermissionMode).toBe("ask");
    const again = await host.startTurn(controller, {
      sessionId: "s1",
      idempotencyKey: "k1",
      input: { text: "hello" },
      context: { requestId: "r2" },
    });
    expect(again.turn.id).toBe(started.turn.id);
    expect(runtime.prompts).toHaveLength(1);
    await expect(
      host.startTurn(controller, { sessionId: "s1", idempotencyKey: "k1", input: { text: "other" }, context: { requestId: "r3" } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("exempts the paired desktop from the ceiling and rejects stale revisions", async () => {
    const { host, runtime } = build({ permissionMode: "auto" });
    await expect(
      host.startTurn(owner, { sessionId: "s1", input: { text: "x" }, context: { requestId: "r", expectedRevision: 9 } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const started = await host.startTurn(owner, { sessionId: "s1", input: { text: "x" }, context: { requestId: "r", expectedRevision: 0 } });
    expect(started.turn.effectivePermissionMode).toBe("auto");
    expect(runtime.prompts[0]!.principal.subject).toBe("desktop");
    await expect(host.startTurn(viewer, { sessionId: "s1", input: { text: "x" }, context: { requestId: "r" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("queues behind an active turn, drains in order, and aliases runtime ids", async () => {
    const { host, runtime, received } = build();
    const first = await host.startTurn(controller, { sessionId: "s1", input: { text: "one" }, context: { requestId: "r1" } });
    host.ingest(envelope("s1", first.turn.id, { type: "agent_start" }));
    await expect(host.startTurn(controller, { sessionId: "s1", input: { text: "two" }, context: { requestId: "r2" } })).rejects.toMatchObject({
      code: "AGENT_BUSY",
    });
    const queued = await host.startTurn(controller, { sessionId: "s1", admission: "queue", input: { text: "two" }, context: { requestId: "r3" } });
    expect(queued.turn.status).toBe("queued");
    expect(queued.turn.queuePosition).toBe(1);
    const third = await host.startTurn(controller, { sessionId: "s1", admission: "queue", input: { text: "three" }, context: { requestId: "r4" } });
    expect(third.turn.queuePosition).toBe(2);
    await expect(
      host.startTurn(controller, { sessionId: "s1", admission: "queue", input: { text: "four" }, context: { requestId: "r5" } }),
    ).rejects.toMatchObject({ code: "AGENT_BUSY", details: { queueFull: true } });
    expect(received.filter((event) => event.kind === "turn.queued")).toHaveLength(2);
    const snapshot = await host.snapshot("s1");
    expect(snapshot.queuedTurns.map((turn) => turn.queuePosition)).toEqual([1, 2]);
    expect(snapshot.session.queuedTurnIds).toEqual([queued.turn.id, third.turn.id]);

    const canceled = await host.cancelTurn(controller, third.turn.id);
    expect(canceled.status).toBe("canceled");
    expect(received.some((event) => event.kind === "turn.canceled")).toBe(true);

    host.ingest(envelope("s1", first.turn.id, { type: "agent_end", messageIds: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts.map((prompt) => prompt.content)).toEqual(["one", "two"]);
    host.ingest(envelope("s1", "rt_2", { type: "agent_start" }));
    const started = received.filter((event) => event.kind === "turn.started");
    expect(started.map((event) => event.turnId)).toEqual([first.turn.id, queued.turn.id]);
    expect(host.getTurn(queued.turn.id).status).toBe("running");
    await host.interruptTurn(controller, queued.turn.id);
    expect(runtime.aborts).toEqual([{ sessionId: "s1", turnId: "rt_2" }]);
    await host.stopTurn(controller, queued.turn.id);
    expect(runtime.stops).toEqual(["s1"]);
  });

  it("marks a queued turn failed when the runtime rejects it and keeps draining", async () => {
    const { host, runtime, received } = build();
    const first = await host.startTurn(controller, { sessionId: "s1", input: { text: "one" }, context: { requestId: "r1" } });
    host.ingest(envelope("s1", first.turn.id, { type: "agent_start" }));
    const bad = await host.startTurn(controller, { sessionId: "s1", admission: "queue", input: { text: "bad" }, context: { requestId: "r2" } });
    await host.startTurn(controller, { sessionId: "s1", admission: "queue", input: { text: "good" }, context: { requestId: "r3" } });
    runtime.failNext = true;
    host.ingest(envelope("s1", first.turn.id, { type: "agent_end", messageIds: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.getTurn(bad.turn.id).status).toBe("failed");
    expect(received.some((event) => event.kind === "turn.failed")).toBe(true);
    expect(runtime.prompts.map((prompt) => prompt.content)).toEqual(["one", "good"]);
  });

  it("holds a restored queue until a controller attaches", async () => {
    const store = new MemoryQueueStore();
    await store.push({
      id: "turn_restored",
      sessionId: "s1",
      principalSubject: "phone",
      content: "after reboot",
      effectivePermissionMode: "ask",
      inputHash: "h",
      createdAt: 1,
    });
    const { host, runtime } = build({ queueStore: store });
    await host.start();
    const asViewer = await host.attach(viewer, { sessionId: "s1" });
    expect(asViewer.snapshot?.queuedTurns.map((turn) => turn.id)).toEqual(["turn_restored"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts).toHaveLength(0);
    await host.attach(controller, { sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts.map((prompt) => prompt.content)).toEqual(["after reboot"]);
  });
});

describe("AgentHost approvals and inputs", () => {
  const permission = (requestId = "req_1") => ({
    type: "tool_permission_request" as const,
    request: { requestId, sessionId: "s1", toolCallId: "c1", toolName: "Bash", argsPreview: { command: "ls" }, risk: "high" as const, reason: "high risk" },
  });

  it("raises approvals with the local vocabulary and settles them once", async () => {
    const { host, approvals, received } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", permission()));
    const raised = received.find((event) => event.kind === "approval.requested")!;
    expect((raised.payload as { allowedDecisions: string[] }).allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(host.getTurn("rt_1").status).toBe("waiting_approval");
    expect((await host.snapshot("s1")).session.status).toBe("waiting_permission");

    await expect(
      host.respondApproval(viewer, { approvalId: "req_1", decision: "deny", context: { requestId: "r" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      host.respondApproval(approver, { approvalId: "req_1", decision: "allow-session", context: { requestId: "r" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await host.respondApproval(approver, { approvalId: "req_1", decision: "allow-once", context: { requestId: "r" } });
    expect(result).toMatchObject({ status: "resolved", decision: "allow-once", alreadyResolved: false });
    expect(approvals.tool).toEqual([{ requestId: "req_1", decision: "allow-once" }]);
    expect(host.getTurn("rt_1").status).toBe("running");
    expect(received.at(-1)?.kind).toBe("approval.resolved");
    const again = await host.respondApproval(owner, { approvalId: "req_1", decision: "deny", context: { requestId: "r2" } });
    expect(again.alreadyResolved).toBe(true);
    expect(approvals.tool).toHaveLength(1);
  });

  it("lets the desktop card settle an approval so a later remote answer is a no-op", async () => {
    const { host, approvals, received } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", permission()));
    const settled = host.settleApprovalExternally("req_1", { decision: "deny" });
    expect(settled?.decision).toBe("deny");
    expect(received.at(-1)?.kind).toBe("approval.resolved");
    const later = await host.respondApproval(approver, { approvalId: "req_1", decision: "allow-once", context: { requestId: "r" } });
    expect(later.alreadyResolved).toBe(true);
    expect(approvals.tool).toEqual([]);
  });

  it("shows host-pending approvals to a late attach and uses the remote lifetime", async () => {
    const { host, approvals } = build();
    approvals.pending = [
      { ...permission("req_late").request, createdAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-10T00:02:00.000Z" },
    ];
    const attached = await host.attach(controller, { sessionId: "s1" });
    expect(attached.snapshot?.pendingApprovals.map((approval) => approval.id)).toEqual(["req_late"]);
    expect(attached.snapshot?.pendingApprovals[0]!.expiresAt).toBe("2026-09-10T00:02:00.000Z");
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", permission("req_remote")));
    const remote = host.pendingApprovals("s1").find((approval) => approval.id === "req_remote")!;
    expect(remote.expiresAt).toBe("2026-09-10T00:30:00.000Z");
  });

  it("falls back to the local lifetime with no remote subscriber attached", () => {
    const runtime = new FakeRuntime();
    const sessions = new FakeSessions();
    sessions.summaries.set("s1", summary("s1"));
    const host = new AgentHost({ runtime, sessions, approvals: new FakeApprovals(), clock: new FixedClock(), ids: new SeqIds() });
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", permission()));
    expect(host.pendingApprovals("s1")[0]!.expiresAt).toBe("2026-09-10T00:02:00.000Z");
  });

  it("routes contract approvals through the contract port with a permission mode", async () => {
    const { host, approvals, received } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(
      envelope("s1", "rt_1", { type: "planning_state", state: "awaiting_approval", kind: "plan", proposalId: "prop_1", title: "Plan", question: "Go?", version: 3 }),
    );
    expect((await host.snapshot("s1")).session.planningState).toBe("awaiting_approval");
    expect(received.filter((event) => event.kind === "approval.requested")).toHaveLength(1);
    await expect(
      host.respondApproval(owner, { approvalId: "prop_1", decision: "approve", context: { requestId: "r" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await host.respondApproval(owner, { approvalId: "prop_1", decision: "approve", permissionMode: "accept-edits", context: { requestId: "r" } });
    expect(approvals.contract).toEqual([{ proposalId: "prop_1", sessionId: "s1", action: "approve", permissionMode: "accept-edits", version: 3 }]);
  });

  it("relays asktool answers with skip semantics", async () => {
    const { host, runtime, received } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(
      envelope("s1", "rt_1", {
        type: "asktool_request",
        request: { requestId: "ask_1", sessionId: "s1", toolCallId: "c9", questions: [{ question: "Which?", options: ["a", "b"], multiSelect: true }, { question: "Why?", options: [] }] },
      }),
    );
    const raised = received.find((event) => event.kind === "input.requested")!;
    expect((raised.payload as { questions: unknown[] }).questions).toHaveLength(2);
    expect(host.getTurn("rt_1").status).toBe("waiting_input");
    await expect(host.respondInput(controller, { inputId: "ask_1", answers: [["a"]], context: { requestId: "r" } })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await host.respondInput(controller, { inputId: "ask_1", answers: [["a", "b"], null], context: { requestId: "r" } });
    expect(runtime.inputs).toEqual([{ requestId: "ask_1", sessionId: "s1", answers: [["a", "b"], null] }]);
    expect(host.getTurn("rt_1").status).toBe("running");
    expect(received.at(-1)?.kind).toBe("input.resolved");
  });
});

describe("AgentHost attach and subscribe", () => {
  it("replays from a cursor or reports a resync, and paginates history", async () => {
    const { host, sessions } = build();
    sessions.items = [{ id: "old", turnId: "t0", itemType: "message", status: "completed", createdAt: "2026-09-09T00:00:00.000Z", content: {} }];
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: [] }));
    const epoch = host.hub.stream("s1").epoch;
    const attached = await host.attach(viewer, { sessionId: "s1", after: { epoch, sequence: 1 } });
    expect(attached.replayComplete).toBe(true);
    expect(attached.snapshot?.items.map((item) => item.id)).toEqual(["old"]);
    const stale = await host.attach(viewer, { sessionId: "s1", after: { epoch: "gone", sequence: 1 }, includeSnapshot: false });
    expect(stale.replayComplete).toBe(false);
    expect(stale.resyncReason).toBe("epoch");
    expect(stale.snapshot).toBeUndefined();
    await expect(host.attach(viewer, { sessionId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(host.attach(viewer, { sessionId: "s1", role: "controller" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const page = await host.history(viewer, { sessionId: "s1", limit: 500 });
    expect(page.items).toHaveLength(1);
    expect(page.revision).toBeGreaterThan(0);
  });

  it("publishes host-scope session changes", () => {
    const { host } = build();
    const kinds: string[] = [];
    host.subscribe(viewer, { scope: "host" }, { deliver: (event) => kinds.push(event.kind), close: () => {} });
    host.publishSessionChange("session.created", summary("s2"));
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: [] }));
    expect(kinds).toEqual(["session.created", "session.changed"]);
  });
});

describe("AgentHost queue extras", () => {
  it("prioritizes a queued turn, reports queue changes, and respects runtime busy state", async () => {
    const changes: Array<{ sessionId: string; ids: string[] }> = [];
    const runtime = new FakeRuntime();
    const sessions = new FakeSessions();
    sessions.summaries.set("s1", summary("s1"));
    let runtimeBusy = false;
    (runtime as RuntimePort).isBusy = () => runtimeBusy;
    const host = new AgentHost({
      runtime,
      sessions,
      approvals: new FakeApprovals(),
      clock: new FixedClock(),
      ids: new SeqIds(),
      onQueueChange: (sessionId, entries) => changes.push({ sessionId, ids: entries.map((entry) => entry.turn.id) }),
    });
    runtimeBusy = true;
    const first = await host.startTurn(owner, { sessionId: "s1", admission: "queue", input: { text: "one" }, context: { requestId: "r1" } });
    const second = await host.startTurn(owner, { sessionId: "s1", admission: "queue", input: { text: "two" }, context: { requestId: "r2" } });
    expect(first.turn.status).toBe("queued");
    expect(runtime.prompts).toHaveLength(0);
    expect(changes.at(-1)?.ids).toEqual([first.turn.id, second.turn.id]);

    const moved = await host.prioritizeTurn(owner, second.turn.id);
    expect(moved.queuePosition).toBe(1);
    expect(host.queueEntries("s1").map((entry) => entry.content)).toEqual(["two", "one"]);
    expect(changes.at(-1)?.ids).toEqual([second.turn.id, first.turn.id]);
    await expect(host.prioritizeTurn(viewer, first.turn.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    runtimeBusy = false;
    host.kick("s1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts.map((prompt) => prompt.content)).toEqual(["two"]);
    expect(changes.at(-1)?.ids).toEqual([first.turn.id]);
    await expect(host.prioritizeTurn(owner, second.turn.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("queues behind a pending contract approval and drains when planning leaves it", async () => {
    const { host, runtime } = build();
    host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    host.ingest(envelope("s1", "rt_1", { type: "planning_state", state: "awaiting_approval", kind: "plan", proposalId: "p1", title: "T", question: "?" }));
    host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: [] }));
    const queued = await host.startTurn(owner, { sessionId: "s1", admission: "queue", input: { text: "later" }, context: { requestId: "r" } });
    expect(queued.turn.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts).toHaveLength(0);
    host.ingest(envelope("s1", undefined, { type: "planning_state", state: "inactive" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.prompts.map((prompt) => prompt.content)).toEqual(["later"]);
  });
});

