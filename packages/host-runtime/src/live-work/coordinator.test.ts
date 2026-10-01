import { describe, expect, it, vi } from "vitest";
import { LiveWorkCoordinator, type LiveWorkCandidate } from "./coordinator.js";
import { parseLiveWorkIntent } from "./intent.js";
import { build, candidate } from "../../test/live-work-fixture.js";

describe("LiveWorkCoordinator", () => {
  it("accepts opaque session-selection references and rejects provider-supplied session IDs", () => {
    expect(parseLiveWorkIntent({ kind: "select-session", selectionRef: "short-lived-ref" })).toEqual({
      kind: "select-session",
      selectionRef: "short-lived-ref",
    });
    expect(parseLiveWorkIntent({ kind: "select-session", selectionRef: "short-lived-ref", sessionId: "remote:host:raw-id" })).toBeNull();
  });
  it("delivers a received receipt before classifying and submits the original text once", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false } });
    const order: string[] = [];
    await subject.coordinator.receiveCandidate(candidate, async (receipt) => {
      order.push(`receipt:${receipt.status}`);
      return { status: "sent", deliveryId: "delivery-1" };
    });
    expect(order).toEqual(["receipt:received"]);
    expect(subject.calls).toContain(`submit:${candidate.instruction}:` + subject.coordinator.getOperation("call-1", subject.coordinator.listOperations("call-1")[0]!.operationId)?.userMessageId);
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "accepted", execution: "running", turnId: "turn-1" });
  });

  it("switches voice work targets without losing earlier session terminal evidence", async () => {
    const subject = build({
      intent: ({ providerRequestId }: LiveWorkCandidate) => {
        if (providerRequestId === "provider-list") return { kind: "list-sessions" };
        if (providerRequestId === "provider-select") return { kind: "select-session", selectionRef: "session-ref" };
        return { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false };
      },
      selectSession: async ({ selectionRef }) => selectionRef === "session-ref"
        ? { status: "selected", sessionId: "session-b", label: "Remote / Refactor" }
        : { status: "expired" },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "receipt-a" }));
    const first = subject.coordinator.listOperations("call-1")[0]!;
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-list", instruction: "List sessions" }, async () => ({ status: "sent", deliveryId: "receipt-list" }));
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-select", instruction: "Switch to the refactor session" }, async () => ({ status: "sent", deliveryId: "receipt-select" }));
    await subject.coordinator.receiveCandidate({ ...candidate, workSessionId: "session-b", providerRequestId: "provider-b", instruction: "Inspect the selected task" }, async () => ({ status: "sent", deliveryId: "receipt-b" }));

    subject.coordinator.reportTurnTerminal({ sessionId: "session-a", runtimeTurnId: first.turnId!, turnId: first.turnId!, status: "completed" });
    subject.coordinator.reportTurnResult({ callId: "call-1", operationId: first.operationId, summary: "Session A result remains attached to A." });

    const operations = subject.coordinator.listOperations("call-1");
    expect(operations[0]).toMatchObject({ workSessionId: "session-a", execution: "completed", resultSummary: "Session A result remains attached to A." });
    expect(operations.at(-1)).toMatchObject({ workSessionId: "session-b", admission: "accepted", execution: "running" });
    expect(subject.calls.some((call) => call.startsWith("submit:Inspect the selected task:"))).toBe(true);
  });

  it("cancels an old queued operation through its original session after a voice target switch", async () => {
    const subject = build({
      intent: ({ providerRequestId }: LiveWorkCandidate) => providerRequestId === "provider-list"
        ? { kind: "list-sessions" }
        : providerRequestId === "provider-select"
          ? { kind: "select-session", selectionRef: "session-ref" }
          : { kind: "new-task", relationToActive: "independent", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-a" },
      selectSession: async () => ({ status: "selected", sessionId: "session-b", label: "Remote / Refactor", source: "remote" }),
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "queue-receipt" }));
    const queued = subject.coordinator.listOperations("call-1")[0]!;
    expect(queued).toMatchObject({ workSessionId: "session-a", execution: "queued", queueEntryId: "queue-1" });
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-list",
      instruction: "List sessions",
    }, async () => ({ status: "sent", deliveryId: "list-receipt" }));
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-select",
      instruction: "Switch to the refactor session",
    }, async () => ({ status: "sent", deliveryId: "select-receipt" }));

    expect(await subject.coordinator.cancelQueuedOperation({ callId: "call-1", operationId: queued.operationId })).toEqual({ status: "canceled" });
    expect(subject.calls).toContain("cancel:session-a:queue-1");
    expect(subject.coordinator.getOperation("call-1", queued.operationId)).toMatchObject({ workSessionId: "session-a", execution: "canceled" });
  });

  it("routes voice cancellation of an old queued operation to that operation's original session", async () => {
    let queuedOperationId = "";
    const subject = build({
      intent: ({ providerRequestId }: LiveWorkCandidate) => providerRequestId === "provider-list"
        ? { kind: "list-sessions" }
        : providerRequestId === "provider-select"
          ? { kind: "select-session", selectionRef: "session-ref" }
          : providerRequestId === "provider-cancel"
            ? { kind: "cancel-queued", operationRef: queuedOperationId }
            : { kind: "new-task", relationToActive: "independent", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-a" },
      selectSession: async () => ({ status: "selected", sessionId: "session-b", label: "Remote / Refactor", source: "remote" }),
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "queue-receipt" }));
    const queued = subject.coordinator.listOperations("call-1")[0]!;
    queuedOperationId = queued.operationId;
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-list",
      instruction: "List sessions",
    }, async () => ({ status: "sent", deliveryId: "list-receipt" }));
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-select",
      instruction: "Switch to the refactor session",
    }, async () => ({ status: "sent", deliveryId: "select-receipt" }));
    await subject.coordinator.receiveCandidate({
      ...candidate,
      workSessionId: "session-b",
      providerRequestId: "provider-cancel",
      instruction: "Cancel the queued operation",
    }, async () => ({ status: "sent", deliveryId: "cancel-receipt" }));

    expect(subject.calls).toContain("cancel:session-a:queue-1");
    expect(subject.calls).not.toContain("cancel:session-b:queue-1");
    expect(subject.coordinator.getOperation("call-1", queued.operationId)).toMatchObject({ workSessionId: "session-a", execution: "canceled" });
  });

  it("stops an old running operation through its original session and exact turn after a voice target switch", async () => {
    const subject = build({
      intent: ({ providerRequestId }: LiveWorkCandidate) => providerRequestId === "provider-list"
        ? { kind: "list-sessions" }
        : providerRequestId === "provider-select"
          ? { kind: "select-session", selectionRef: "session-ref" }
          : { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      selectSession: async () => ({ status: "selected", sessionId: "session-b", label: "Remote / Refactor", source: "remote" }),
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "task-receipt" }));
    const running = subject.coordinator.listOperations("call-1")[0]!;
    subject.snapshot.state = "running";
    subject.snapshot.activeTurnId = running.turnId;
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-list",
      instruction: "List sessions",
    }, async () => ({ status: "sent", deliveryId: "list-receipt" }));
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-select",
      instruction: "Switch to the refactor session",
    }, async () => ({ status: "sent", deliveryId: "select-receipt" }));

    expect(await subject.coordinator.stopOperation({ callId: "call-1", operationId: running.operationId })).toEqual({ status: "requested" });
    expect(subject.calls).toContain(`stop:session-a:${running.turnId}:graceful`);
  });

  it("does not dispatch if the local provider receipt was not sent", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false } });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "not-sent", deliveryId: "delivery-1", code: "closed" }));
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("uses the Host queue for an explicitly independent task while busy", async () => {
    const subject = build({
      intent: { kind: "new-task", relationToActive: "independent", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-current" },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("queue:"))).toBe(true);
    expect(subject.calls.some((call) => call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "accepted", execution: "queued", queueEntryId: "queue-1" });
  });

  it("keeps a terminal event that arrives before submit returns", async () => {
    let subject: ReturnType<typeof build>;
    subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async (request) => {
        subject.coordinator.reportTurnTerminal({
          sessionId: "session-a",
          runtimeTurnId: "turn-early",
          turnId: "turn-early",
          idempotencyKey: request.idempotencyKey,
          status: "completed",
        });
        return { status: "started", turnId: "turn-early" };
      },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      admission: "accepted",
      execution: "completed",
      turnId: "turn-early",
    });
    const operation = subject.coordinator.listOperations("call-1")[0]!;
    expect(subject.coordinator.findOperationByTurn({ sessionId: "session-a", turnId: "turn-early" })).toEqual({
      callId: "call-1",
      operationId: operation.operationId,
    });
    subject.coordinator.reportTurnResult({ callId: "call-1", operationId: operation.operationId, summary: "Updated the login validation." });
    expect(subject.coordinator.getOperation("call-1", operation.operationId)).toMatchObject({
      summary: "Work started in the bound session.",
      resultSummary: "Updated the login validation.",
      resultState: "available",
    });
  });

  it("answers a result query from the recorded operation without starting another turn", async () => {
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-query"
        ? { kind: "query-result" }
        : { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    const original = subject.coordinator.listOperations("call-1")[0]!;
    subject.coordinator.reportTurnTerminal({
      sessionId: "session-a",
      runtimeTurnId: original.turnId!,
      turnId: original.turnId!,
      status: "completed",
    });
    subject.coordinator.reportTurnResult({
      callId: "call-1",
      operationId: original.operationId,
      summary: "Updated the login validation.",
    });

    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-query", instruction: "What did the task change?" }, async () => ({ status: "sent", deliveryId: "delivery-2" }));

    const query = subject.coordinator.listOperations("call-1")[1]!;
    expect(query).toMatchObject({ admission: "accepted", execution: "not-started", summary: "Updated the login validation." });
    expect(subject.calls.filter((call) => call.startsWith("submit:"))).toHaveLength(1);
  });

  it("shares one terminal result with every operation attached to the same turn", async () => {
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-steer"
        ? { kind: "steer-current" }
        : { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "receipt-submit" }));
    subject.snapshot.state = "running";
    subject.snapshot.activeTurnId = "turn-1";
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-steer",
      instruction: "Also check the error path.",
      observedTurnId: "turn-1",
    }, async () => ({ status: "sent", deliveryId: "receipt-steer" }));
    const [submit, steer] = subject.coordinator.listOperations("call-1");

    subject.coordinator.reportTurnTerminal({
      sessionId: "session-a",
      runtimeTurnId: "turn-1",
      turnId: "turn-1",
      status: "completed",
    });
    subject.coordinator.reportTurnResult({
      callId: "call-1",
      operationId: submit!.operationId,
      summary: "The exact turn result.",
      resultState: "available",
      sourceMessageId: "message-final",
    });

    expect(subject.coordinator.getOperation("call-1", submit!.operationId)).toMatchObject({
      resultSummary: "The exact turn result.",
      resultSourceMessageId: "message-final",
    });
    expect(subject.coordinator.getOperation("call-1", steer!.operationId)).toMatchObject({
      execution: "completed",
      resultSummary: "The exact turn result.",
      resultState: "available",
      resultSourceMessageId: "message-final",
    });
  });

  it("keeps a stop acknowledgement out of the latest engineering result", async () => {
    let stopOperationId = "";
    const subject = build({
      intent: ({ providerRequestId }: LiveWorkCandidate) => {
        if (providerRequestId === "provider-stop") return { kind: "stop-current", urgency: "graceful" };
        if (providerRequestId === "provider-result-explicit") return { kind: "query-result", operationRef: stopOperationId };
        if (providerRequestId.startsWith("provider-result")) return { kind: "query-result" };
        return { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false };
      },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "task-receipt" }));
    const task = subject.coordinator.listOperations("call-1")[0]!;
    subject.snapshot.state = "running";
    subject.snapshot.activeTurnId = "turn-1";
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-stop",
      instruction: "Stop the current task.",
      observedTurnId: "turn-1",
    }, async () => ({ status: "sent", deliveryId: "stop-receipt" }));
    const stop = subject.coordinator.listOperations("call-1")[1]!;
    stopOperationId = stop.operationId;
    subject.coordinator.reportTurnTerminal({
      sessionId: "session-a",
      runtimeTurnId: "turn-1",
      turnId: "turn-1",
      status: "completed",
    });
    subject.coordinator.reportTurnResult({ callId: "call-1", operationId: task.operationId, summary: "The requested change is verified." });
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-result-latest",
      instruction: "What did the task do?",
    }, async () => ({ status: "sent", deliveryId: "result-receipt-latest" }));
    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-result-explicit",
      instruction: "What was the result of the task I stopped?",
    }, async () => ({ status: "sent", deliveryId: "result-receipt-explicit" }));

    const [taskAfter, stopAfter, latestResultQuery, explicitResultQuery] = subject.coordinator.listOperations("call-1");
    expect(taskAfter?.resultSummary).toBe("The requested change is verified.");
    expect(stopAfter?.summary).toBe("Task stop requested.");
    expect(stopAfter?.resultSummary).toBeUndefined();
    expect(stopAfter).toMatchObject({ execution: "not-started", targetTurnId: "turn-1" });
    expect(latestResultQuery?.summary).toBe("The requested change is verified.");
    expect(explicitResultQuery?.summary).toBe("The requested change is verified.");
  });

  it("does not answer a pending terminal result with the admission message", async () => {
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-query"
        ? { kind: "query-result" }
        : { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    const original = subject.coordinator.listOperations("call-1")[0]!;
    subject.coordinator.reportTurnTerminal({
      sessionId: "session-a",
      runtimeTurnId: original.turnId!,
      turnId: original.turnId!,
      status: "completed",
    });

    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-query", instruction: "What happened?" }, async () => ({ status: "sent", deliveryId: "delivery-2" }));

    expect(subject.coordinator.listOperations("call-1")[1]?.summary).toContain("result is still being synchronized");
    expect(subject.coordinator.listOperations("call-1")[1]?.summary).not.toContain("Work started");
  });

  it("asks for clarification when a busy new task has no explicit relationship", async () => {
    const subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-current" },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:") || call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("reports an authoritative final workspace rejection instead of admission unknown", async () => {
    const subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async () => {
        throw Object.assign(new Error("workspace moved"), { code: "WORKSPACE_CHANGED" });
      },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "workspace-receipt" }));

    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      admission: "rejected",
      execution: "not-started",
      summary: "The bound workspace changed before Host admission. Start a new work call to authorize the current workspace.",
    });
  });

  it("rejects a stale steer without falling back to prompt or queue", async () => {
    const subject = build({ intent: { kind: "steer-current" }, snapshot: { state: "running", activeTurnId: "turn-new" } });
    await subject.coordinator.receiveCandidate({ ...candidate, observedTurnId: "turn-old" }, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:") || call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("keeps an ingress-time empty turn target instead of stopping a later turn", async () => {
    const subject = build({
      intent: { kind: "stop-current", urgency: "graceful" },
      snapshot: { state: "running", activeTurnId: "turn-2" },
    });
    await subject.coordinator.receiveCandidate({ ...candidate, observedTurnId: null }, async () => ({ status: "sent", deliveryId: "delivery-1" }));

    expect(subject.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("aborts the classifier when its deadline expires and never routes its late result", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let resolverStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolverStarted = resolve; });
    const subject = build({
      intent: null,
      classifyTimeoutMs: 250,
      resolveIntent: (request) => {
        signal = request.signal;
        resolverStarted();
        return new Promise(() => {});
      },
    });

    try {
      const pending = subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
      await started;
      await vi.advanceTimersByTimeAsync(250);
      await pending;

      expect(signal?.aborted).toBe(true);
      expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:"))).toBe(false);
      expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "rejected", failureCode: "classifier-timeout" });
    } finally {
      vi.useRealTimers();
      subject.coordinator.closeCall("call-1");
    }
  });

  it("lets a validated stop use its reserved classifier while an ordinary classifier is pending", async () => {
    let releaseNormal!: (value: unknown) => void;
    let normalStarted!: () => void;
    const started = new Promise<void>((resolve) => { normalStarted = resolve; });
    const subject = build({
      intent: null,
      snapshot: { state: "running", activeTurnId: "turn-current" },
      resolveIntent: ({ candidate: current }) => {
        if (current.providerRequestId === "provider-1") {
          normalStarted();
          return new Promise((resolve) => { releaseNormal = resolve; });
        }
        return { kind: "stop-current", urgency: "graceful" };
      },
    });
    const normal = subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "normal-receipt" }));
    await started;

    await subject.coordinator.receiveCandidate({
      ...candidate,
      providerRequestId: "provider-stop",
      instruction: "Stop the current task now.",
    }, async () => ({ status: "sent", deliveryId: "stop-receipt" }));

    expect(subject.calls.some((call) => call === "stop:session-a:turn-current:graceful")).toBe(true);
    releaseNormal({ kind: "new-task", relationToActive: "unspecified", explicitRepeat: false });
    await normal;

    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "withdrawn", execution: "not-started" });
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:"))).toBe(false);
  });

  it("does not let a control scheduling hint directly execute a write intent", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false } });
    await subject.coordinator.receiveCandidate({
      ...candidate,
      instruction: "Stop the current task now.",
    }, async () => ({ status: "sent", deliveryId: "delivery-stop-hint" }));

    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:") || call.startsWith("stop:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("bounds a Host snapshot that never resolves", async () => {
    vi.useFakeTimers();
    const subject = build({ intent: { kind: "conversation" }, hangSnapshot: true });
    try {
      const pending = subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "snapshot-receipt" }));
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
      expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
    } finally {
      vi.useRealTimers();
      subject.coordinator.closeCall("call-1");
    }
  });

  it("bounds an unresolved dispatch and reconciles it without resubmitting", async () => {
    vi.useFakeTimers();
    let submitCalls = 0;
    let lookupCalls = 0;
    const subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async () => {
        submitCalls += 1;
        return new Promise(() => {});
      },
      lookupAdmission: async () => {
        lookupCalls += 1;
        return { kind: "running", turnId: "turn-reconciled" };
      },
    });
    try {
      const pending = subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "dispatch-receipt" }));
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
        admission: "unknown",
        execution: "unknown",
        failureCode: "dispatch-unknown",
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
        admission: "accepted",
        execution: "running",
        turnId: "turn-reconciled",
      });
      expect(subject.coordinator.listOperations("call-1")[0]?.failureCode).toBeUndefined();
      expect(submitCalls).toBe(1);
      expect(lookupCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      subject.coordinator.closeCall("call-1");
    }
  });

  it("preserves unknown admission when the call closes during Host dispatch", async () => {
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async () => {
        releaseStarted();
        return new Promise(() => {});
      },
    });
    const pending = subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "close-dispatch-receipt" }));
    await started;
    subject.coordinator.closeCall("call-1");
    await pending;

    expect(subject.calls.at(-1)).toBe("state:unknown:unknown");
    expect(subject.calls.some((call) => call === "state:withdrawn:not-started")).toBe(false);
  });

  it("keeps terminal Host evidence when the submit acknowledgement is lost", async () => {
    let subject: ReturnType<typeof build>;
    subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async (request) => {
        subject.coordinator.reportTurnTerminal({
          sessionId: "session-a",
          runtimeTurnId: "runtime-turn-early",
          turnId: "turn-early",
          idempotencyKey: request.idempotencyKey,
          status: "completed",
        });
        throw new Error("lost acknowledgement after Host completion");
      },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));

    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      admission: "accepted",
      execution: "completed",
      turnId: "turn-early",
    });
    subject.coordinator.closeCall("call-1");
  });

  it("deduplicates the same provider request and rejects parameter conflicts", async () => {
    const subject = build({ intent: { kind: "conversation" } });
    let deliveries = 0;
    const deliver = async () => {
      deliveries += 1;
      return { status: "sent" as const, deliveryId: `delivery-${deliveries}` };
    };
    await subject.coordinator.receiveCandidate(candidate, deliver);
    await subject.coordinator.receiveCandidate(candidate, deliver);
    await subject.coordinator.receiveCandidate({ ...candidate, instruction: "a different request" }, deliver);
    expect(subject.coordinator.listOperations("call-1")).toHaveLength(1);
    expect(deliveries).toBe(2);
  });

  it("fails closed on malformed classifier output and validates exact intent fields", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "independent", explicitRepeat: false, sessionId: "elsewhere" } });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      summary: "I could not confirm what you want me to do. Please clarify.",
      failureCode: "classifier-invalid",
    });
    expect(parseLiveWorkIntent({ kind: "stop-current", urgency: "immediate", turnId: "turn-1" })).toBeNull();
    expect(parseLiveWorkIntent({ kind: "stop-current", urgency: "immediate" })).toEqual({ kind: "stop-current", urgency: "immediate" });
  });

  it("does not dispatch a classifier result after the work call closes", async () => {
    let release: ((value: unknown) => void) | undefined;
    let resolverStarted: (() => void) | undefined;
    let submitted = false;
    const started = new Promise<void>((resolve) => { resolverStarted = resolve; });
    const delayed = new LiveWorkCoordinator({
      resolveIntent: ({ signal }) => {
        signal.addEventListener("abort", () => { resolverStarted?.(); }, { once: true });
        return new Promise((resolve) => { release = resolve; resolverStarted?.(); });
      },
      workPort: {
        snapshot: async (sessionId) => ({ sessionId, mode: "agent", state: "idle", queue: [], observedAt: 1 }),
        observeTurnTarget: () => null,
        lookupAdmission: async () => ({ kind: "not-found" }),
        submit: async () => { submitted = true; throw new Error("must not dispatch"); },
        steer: async () => ({ accepted: false }),
        enqueue: async () => ({ queueEntryId: "queue" }),
        stop: async () => ({ status: "unsupported" }),
        cancelQueued: async () => ({ status: "not-found" }),
        listProjects: async () => [],
        listSessions: async () => [],
        openSelection: async () => ({ status: "expired" }),
      },
    });
    delayed.openCall({ callId: "call-1", workSessionId: "session-a", workBindingRevision: 2 });
    const running = delayed.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery" }));
    await started;
    delayed.closeCall("call-1");
    release?.({ kind: "new-task", relationToActive: "unspecified", explicitRepeat: false });
    await running;
    expect(submitted).toBe(false);
    expect(delayed.listOperations("call-1")).toEqual([]);
    expect(delayed.findOperationByTurn({ sessionId: "session-a", turnId: "late-turn" })).toBeUndefined();
  });

  it("lists session choices and opens only a call-scoped selection reference", async () => {
    let selectedRef = "";
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-list"
        ? { kind: "list-sessions" }
        : { kind: "open-session", selectionRef: selectedRef },
    });
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-list" }, async () => ({ status: "sent", deliveryId: "receipt-list" }));
    const listing = subject.coordinator.listOperations("call-1")[0]!;
    selectedRef = listing.selections?.[0]?.selectionRef ?? "";
    expect(listing.selections).toEqual([{ selectionRef: "session-ref", kind: "session", action: "open", label: "Demo / Chat" }]);

    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-open" }, async () => ({ status: "sent", deliveryId: "receipt-open" }));
    expect(subject.coordinator.listOperations("call-1")[1]).toMatchObject({ admission: "accepted", summary: expect.stringContaining("remains bound") });
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });

  it("creates only a project choice and keeps the active call's bound session unchanged", async () => {
    const subject = build({ intent: { kind: "create-session" } });
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-create" }, async () => ({ status: "sent", deliveryId: "receipt-create" }));
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      workSessionId: "session-a",
      selections: [{ selectionRef: "project-ref", kind: "project", action: "create", label: "Demo" }],
    });
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });
});
