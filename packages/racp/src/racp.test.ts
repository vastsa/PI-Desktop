import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, RacpEventEnvelope, RacpInitializeResult, RacpSessionSnapshot, RacpTurn, UiMessage } from "@pi-desktop/shared";
import { RacpError } from "@pi-desktop/agent-host";

import { hashToken, newDeviceToken, newPairingToken } from "./auth.js";
import type { RacpTerminalAccess } from "./host-operations.js";
import { OWNER_TOKEN, VIEWER_TOKEN, flush, harness } from "./test-harness.js";

function envelope(sessionId: string, turnId: string, event: AgentEventEnvelope["event"]): AgentEventEnvelope {
  return { sessionId, turnId, ts: Date.parse("2026-09-18T00:00:01.000Z"), event };
}

const context = (requestId: string, idempotencyKey?: string) => ({ requestId, ...(idempotencyKey ? { idempotencyKey } : {}) });

describe("RACP-WS handshake and authentication", () => {
  it("negotiates protocol, capabilities, limits, and the Host identity", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    const init = client.initialized as RacpInitializeResult;
    expect(init.protocolVersion).toBe("1.0");
    expect(init.server.hostId).toBe("host_test");
    expect(init.principal).toEqual({ subject: "dev_owner", roles: ["owner"] });
    expect(init.capabilities.remoteHostProfile).toBe(true);
    expect(init.capabilities.bindings).toEqual(["RACP-WS"]);
    expect(init.capabilities.terminal).toBe(false);
    expect(init.limits.maxQueuedTurnsPerSession).toBe(8);
    expect(init.policy.remoteMaxPermissionMode).toBe("ask");
    const ping = await client.request<{ ok: boolean }>("connection/ping");
    expect(ping.ok).toBe(true);
    await client.close();
    expect(h.server.connectionCount()).toBe(0);
  });

  it("refuses an unknown, revoked, or URL-carried credential before any RPC", async () => {
    const h = await harness();
    await expect(h.connect("pdt1.nonsense")).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    expect(await h.authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: true, connectionId: "c" })).toBeNull();
    expect(await h.authenticator.authenticate({ authorization: `Basic ${OWNER_TOKEN}`, urlHasToken: false, connectionId: "c" })).toBeNull();
    await h.store.revokeDevice("dev_owner", "2026-09-18T00:00:00.000Z");
    await expect(h.connect(OWNER_TOKEN)).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
  });

  it("rejects a request before initialization and an unknown operation after it", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    await expect(client.request("no/such")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(client.request("host/list")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(client.request("connection/initialize", {})).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces roles from the catalog and the client limit", async () => {
    const h = await harness({ limits: { maxConnectedClients: 1 } });
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("turn/start", { sessionId: "s1", input: { text: "x" }, context: context("r1") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.client.request("project/register", { path: "/x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const list = await viewer.client.request<{ sessions: unknown[] }>("session/list");
    expect(list.sessions).toHaveLength(1);
    await expect(h.connect(OWNER_TOKEN)).rejects.toMatchObject({ code: "REMOTE_CONNECTION_FAILED" });
  });

  it("exchanges a single-use pairing token for an owner device credential", async () => {
    const h = await harness();
    const issued = await h.authenticator.issuePairingToken(60_000);
    const pairing = await h.connect(issued.token);
    expect(pairing.client.initialized?.principal.roles).toEqual([]);
    await expect(pairing.client.request("session/list")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const paired = await pairing.client.request<{ deviceId: string; deviceToken: string; roles: string[] }>("connection/pair", { deviceLabel: "my laptop" });
    expect(paired.roles).toEqual(["owner"]);
    expect(paired.deviceToken.startsWith("pdt1.")).toBe(true);
    // Second exchange on the same token is refused; the new device token works.
    await expect(pairing.client.request("connection/pair", {})).rejects.toMatchObject({ code: "PAIRING_FAILED" });
    await expect(h.connect(issued.token)).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    const device = await h.connect(paired.deviceToken);
    expect(device.client.initialized?.principal).toEqual({ subject: paired.deviceId, roles: ["owner"] });
    const stored = (await h.store.listDevices()).find((record) => record.deviceId === paired.deviceId);
    expect(stored?.tokenHash).toBe(hashToken(paired.deviceToken));
    expect(stored?.label).toBe("my laptop");
  });

  it("refuses an expired pairing token and a pairing call on a device connection", async () => {
    const h = await harness();
    const expired = newPairingToken();
    await h.store.savePairing({ tokenHash: hashToken(expired), expiresAt: "2000-01-01T00:00:00.000Z" });
    await expect(h.connect(expired)).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
    const { client } = await h.connect(OWNER_TOKEN);
    await expect(client.request("connection/pair", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("RACP-WS turns, events, and approvals", () => {
  it("runs a turn end to end: attach, subscribe, start, ordered durable events, completion", async () => {
    const h = await harness();
    const { client, events } = await h.connect(OWNER_TOKEN);
    const attach = await client.request<{ session: { id: string; status: string }; snapshot: RacpSessionSnapshot }>("session/attach", { sessionId: "s1" });
    expect(attach.session.status).toBe("idle");
    expect(attach.snapshot.cursor).toEqual({ epoch: expect.any(String), sequence: 0 });
    const sub = await client.request<{ subscriptionId: string; replayComplete: boolean }>("events/subscribe", { scope: "session", sessionId: "s1" });
    expect(sub.replayComplete).toBe(true);
    const started = await client.request<{ accepted: boolean; turn: RacpTurn }>("turn/start", {
      sessionId: "s1",
      input: { text: "hello", messageId: "6f1c1e2a-3b4d-4c5e-8f6a-7b8c9d0e1f2a" },
      context: context("r1", "k1"),
    });
    expect(started.turn.status).toBe("running");
    expect(h.runtime.prompts[0]).toMatchObject({ content: "hello", userMessageId: "6f1c1e2a-3b4d-4c5e-8f6a-7b8c9d0e1f2a", effectivePermissionMode: "ask" });
    const message: UiMessage = { id: "m1", role: "assistant", content: "hi", createdAt: "2026-09-18T00:00:01.000Z", status: "complete" };
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    h.host.ingest(envelope("s1", "rt_1", { type: "message_start", message: { ...message, status: "streaming" } }));
    h.host.ingest(envelope("s1", "rt_1", { type: "message_update", message: { ...message, status: "streaming" }, deltaText: "hi" }));
    h.host.ingest(envelope("s1", "rt_1", { type: "message_end", message }));
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_end", messageIds: ["m1"] }));
    await flush();
    const sequenced = events.filter((event) => typeof event.sequence === "number").map((event) => event.sequence);
    expect(sequenced).toEqual([...sequenced].sort((a, b) => a - b));
    expect(new Set(sequenced).size).toBe(sequenced.length);
    expect(events.map((event) => event.kind)).toEqual(["turn.started", "item.started", "item.delta", "item.completed", "turn.completed", "session.changed"]);
    expect(events.find((event) => event.kind === "item.delta")?.afterSequence).toBe(2);
    const turn = await client.request<{ turn: RacpTurn }>("turn/get", { turnId: "rt_1" });
    expect(turn.turn.status).toBe("completed");
    expect(client.cursorFor("s1")).toEqual({ epoch: events[0]!.epoch, sequence: 5 });
  });

  it("returns the same turn for a repeated idempotency key and refuses a changed input", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    await client.request("session/attach", { sessionId: "s1" });
    const first = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", input: { text: "hello" }, context: context("r1", "same") });
    const second = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", input: { text: "hello" }, context: context("r2", "same") });
    expect(second.turn.id).toBe(first.turn.id);
    expect(h.runtime.prompts).toHaveLength(1);
    await expect(client.request("turn/start", { sessionId: "s1", input: { text: "other" }, context: context("r3", "same") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(client.request("turn/start", { sessionId: "s1", input: { text: "busy" }, context: context("r4") })).rejects.toMatchObject({ code: "AGENT_BUSY" });
    const queued = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", admission: "queue", input: { text: "later" }, context: context("r5") });
    expect(queued.turn.status).toBe("queued");
    expect(queued.turn.queuePosition).toBe(1);
  });

  it("stops, interrupts, and cancels through the catalog and enforces the prompt limit", async () => {
    const h = await harness({ limits: { maxPromptBytes: 16 } });
    const { client } = await h.connect(OWNER_TOKEN);
    await client.request("session/attach", { sessionId: "s1" });
    await expect(client.request("turn/start", { sessionId: "s1", input: { text: "x".repeat(17) }, context: context("r0") })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const started = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", input: { text: "go" }, context: context("r1") });
    const queued = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", admission: "queue", input: { text: "next" }, context: context("r2") });
    await client.request("turn/stop", { turnId: started.turn.id });
    expect(h.runtime.stops).toEqual(["s1"]);
    await client.request("turn/interrupt", { turnId: started.turn.id });
    expect(h.runtime.aborts).toEqual([{ sessionId: "s1", turnId: started.turn.id }]);
    const canceled = await client.request<{ turn: RacpTurn }>("turn/cancel", { turnId: queued.turn.id });
    expect(canceled.turn.status).toBe("canceled");
    await expect(client.request("turn/cancel", { turnId: started.turn.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("delivers approval requests to a viewer and lets the owner resolve them once", async () => {
    const h = await harness();
    const ownerSide = await h.connect(OWNER_TOKEN);
    const viewerSide = await h.connect(VIEWER_TOKEN);
    await ownerSide.client.request("session/attach", { sessionId: "s1" });
    await ownerSide.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    await viewerSide.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    await ownerSide.client.request("turn/start", { sessionId: "s1", input: { text: "run" }, context: context("r1") });
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    h.host.ingest(
      envelope("s1", "rt_1", {
        type: "tool_permission_request",
        request: { requestId: "perm-1", sessionId: "s1", toolCallId: "c1", toolName: "Bash", argsPreview: "rm", risk: "high", reason: "shell" },
      }),
    );
    await flush();
    const requested = viewerSide.events.find((event) => event.kind === "approval.requested");
    expect(requested).toBeDefined();
    expect((requested!.payload as { allowedDecisions: string[] }).allowedDecisions).toEqual(["allow-once", "deny"]);
    await expect(viewerSide.client.request("approval/respond", { approvalId: "perm-1", decision: "allow-once", context: context("r2") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const resolved = await ownerSide.client.request<{ status: string; alreadyResolved: boolean }>("approval/respond", { approvalId: "perm-1", decision: "deny", context: context("r3") });
    expect(resolved).toMatchObject({ status: "resolved", alreadyResolved: false });
    expect(h.approvals.tool).toEqual([{ requestId: "perm-1", decision: "deny" }]);
    const again = await ownerSide.client.request<{ alreadyResolved: boolean; decision: string }>("approval/respond", { approvalId: "perm-1", decision: "allow-once", context: context("r4") });
    expect(again).toMatchObject({ alreadyResolved: true, decision: "deny" });
    expect(h.approvals.tool).toHaveLength(1);
    await flush();
    expect(viewerSide.events.filter((event) => event.kind === "approval.resolved")).toHaveLength(1);
  });

  it("answers input requests and closes the subscription of a client that stops acknowledging", async () => {
    const h = await harness();
    const closed: unknown[] = [];
    const { client, events } = await h.connect(OWNER_TOKEN, { onSubscriptionClosed: (notice) => closed.push(notice) });
    await client.request("session/attach", { sessionId: "s1" });
    await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    await client.request("turn/start", { sessionId: "s1", input: { text: "ask" }, context: context("r1") });
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    h.host.ingest(envelope("s1", "rt_1", { type: "asktool_request", request: { requestId: "ask-1", sessionId: "s1", toolCallId: "c1", questions: [{ question: "Which?", options: ["a", "b"] }] } }));
    await flush();
    const input = events.find((event) => event.kind === "input.requested");
    expect(input).toBeDefined();
    await client.request("input/respond", { inputId: "ask-1", answers: [["a"]], context: context("r2") });
    expect(h.runtime.inputs).toEqual([{ requestId: "ask-1", sessionId: "s1", answers: [["a"]] }]);
    // Acknowledgements release the bound; without them a slow client is closed with a resumable cursor.
    for (let index = 0; index < 1_005; index += 1) {
      h.host.ingest(envelope("s1", "rt_1", { type: "message_end", message: { id: `m${index}`, role: "assistant", content: "x", createdAt: "2026-09-18T00:00:01.000Z", status: "complete" } }));
    }
    await flush();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ error: { code: "CLIENT_TOO_SLOW" }, lastSafeCursor: { sequence: expect.any(Number) } });
  });
});

describe("RACP-WS reconnect", () => {
  it("keeps the turn running across a drop and resumes events by cursor without a second prompt", async () => {
    const h = await harness();
    const { client, events, link } = await h.connect(OWNER_TOKEN, { reconnect: { enabled: true, baseDelayMs: 1 } });
    await client.request("session/attach", { sessionId: "s1" });
    await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    const started = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", input: { text: "long job" }, context: context("r1", "job-1") });
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    await flush();
    const before = events.length;
    link().drop();
    await flush();
    // Events that happened while disconnected are retained by the Host.
    h.host.ingest(envelope("s1", "rt_1", { type: "message_end", message: { id: "m1", role: "assistant", content: "still working", createdAt: "2026-09-18T00:00:01.000Z", status: "complete" } }));
    await flush();
    expect(client.state).toBe("connected");
    expect(h.runtime.aborts).toEqual([]);
    expect(h.runtime.stops).toEqual([]);
    const attach = await client.request<{ replayComplete: boolean; session: { activeTurnId?: string } }>("session/attach", { sessionId: "s1", after: client.cursorFor("s1") });
    expect(attach.replayComplete).toBe(true);
    expect(attach.session.activeTurnId).toBe(started.turn.id);
    const resumed = await client.request<{ replayComplete: boolean; starting: { sequence: number } }>("events/subscribe", { scope: "session", sessionId: "s1", after: client.cursorFor("s1") });
    expect(resumed.replayComplete).toBe(true);
    await flush();
    const replayed = events.slice(before).filter((event) => typeof event.sequence === "number");
    expect(replayed.map((event) => event.kind)).toEqual(["item.completed"]);
    // The same idempotency key after reconnect returns the same turn: nothing re-executes.
    const again = await client.request<{ turn: RacpTurn }>("turn/start", { sessionId: "s1", input: { text: "long job" }, context: context("r2", "job-1") });
    expect(again.turn.id).toBe(started.turn.id);
    expect(h.runtime.prompts).toHaveLength(1);
    // The old connection's subscription was released with it.
    expect(h.host.hub.subscriptionCount()).toBe(1);
  });

  it("falls back to a snapshot when the cursor is from another epoch or was evicted", async () => {
    const h = await harness({ limits: { replayWindowEvents: 3 } });
    const { client, events } = await h.connect(OWNER_TOKEN);
    await client.request("session/attach", { sessionId: "s1" });
    await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    await client.request("turn/start", { sessionId: "s1", input: { text: "go" }, context: context("r1") });
    h.host.ingest(envelope("s1", "rt_1", { type: "agent_start" }));
    await flush();
    const early = client.cursorFor("s1")!;
    for (let index = 0; index < 6; index += 1) {
      h.host.ingest(envelope("s1", "rt_1", { type: "message_end", message: { id: `m${index}`, role: "assistant", content: "x", createdAt: "2026-09-18T00:00:01.000Z", status: "complete" } }));
    }
    await flush();
    const evicted = await client.request<{ replayComplete: boolean; resyncReason?: string; snapshot?: RacpSessionSnapshot }>("session/attach", { sessionId: "s1", after: early });
    expect(evicted.replayComplete).toBe(false);
    expect(evicted.resyncReason).toBe("evicted");
    expect(evicted.snapshot?.activeTurn?.id).toBe("rt_1");
    const otherEpoch = await client.request<{ replayComplete: boolean; resyncReason?: string }>("session/attach", { sessionId: "s1", after: { epoch: "ep_old", sequence: 1 } });
    expect(otherEpoch.resyncReason).toBe("epoch");
    const ahead = await client.request<{ resyncReason?: string }>("events/subscribe", { scope: "session", sessionId: "s1", after: { epoch: early.epoch, sequence: 999 } });
    expect(ahead.resyncReason).toBe("ahead");
    expect(events.length).toBeGreaterThan(0);
  });

  it("rejects in-flight requests on a drop with HOST_DISCONNECTED and reports state changes", async () => {
    const h = await harness();
    const states: string[] = [];
    const { client, link } = await h.connect(OWNER_TOKEN, { onStateChange: (state) => states.push(state) });
    const pending = client.request("connection/ping");
    link().drop();
    await expect(pending).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    await flush();
    expect(client.state).toBe("disconnected");
    await expect(client.request("connection/ping")).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("gives up after the reconnect budget and reports an error state", async () => {
    const h = await harness();
    const states: string[] = [];
    const { client, link } = await h.connect(OWNER_TOKEN, { reconnect: { enabled: true, baseDelayMs: 1, maxAttempts: 2 }, onStateChange: (state) => states.push(state) });
    await h.store.revokeDevice("dev_owner", "2026-09-18T00:00:00.000Z");
    link().drop();
    await flush();
    await flush();
    expect(states.at(-1)).toBe("error");
    expect(client.state).toBe("error");
  });
});

describe("RACP-WS remote-host profile", () => {
  it("creates, configures, forks, renames, and deletes sessions and publishes host events", async () => {
    const h = await harness();
    const { client, events } = await h.connect(OWNER_TOKEN);
    await client.request("events/subscribe", { scope: "host" });
    const created = await client.request<{ session: { id: string; title: string; permissionMode: string } }>("session/create", { title: "Remote job", permissionMode: "accept-edits" });
    expect(created.session.permissionMode).toBe("accept-edits");
    const configured = await client.request<{ session: { mode: string } }>("session/configure", { sessionId: created.session.id, mode: "plan" });
    expect(configured.session.mode).toBe("plan");
    const forked = await client.request<{ session: { id: string } }>("session/fork", { sessionId: created.session.id });
    expect(forked.session.id).toBe(`${created.session.id}-fork`);
    await client.request("session/rename", { sessionId: created.session.id, title: "Renamed" });
    expect(h.sessions.get(created.session.id)?.title).toBe("Renamed");
    await client.request("session/delete", { sessionId: forked.session.id });
    expect(h.sessions.has(forked.session.id)).toBe(false);
    await client.request("session/compact", { sessionId: created.session.id });
    await flush();
    expect(events.filter((event) => event.scope === "host").map((event) => event.kind)).toEqual(["session.created", "session.changed", "session.created", "session.changed"]);
    await expect(client.request("session/get", { sessionId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serves projects and bounded workspace reads and maps Host path errors to stable codes", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    const projects = await client.request<{ projects: Array<{ id: string }> }>("project/list");
    expect(projects.projects[0]?.id).toBe("proj");
    const registered = await client.request<{ project: { id: string; label: string } }>("project/register", { path: "/srv/app" });
    expect(registered.project).toMatchObject({ id: "proj-2", label: "app" });
    await expect(client.request("project/register", { path: "/srv/missing" })).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
    const browsed = await client.request<{ entries: unknown[] }>("project/browse", {});
    expect(browsed.entries).toHaveLength(1);
    const listed = await client.request<{ entries: Array<{ name: string }> }>("workspace/list", { sessionId: "s1", path: "" });
    expect(listed.entries[0]?.name).toBe("README.md");
    const read = await client.request<{ kind: string; content: string }>("workspace/read", { sessionId: "s1", path: "README.md" });
    expect(read).toMatchObject({ kind: "text", content: "hello" });
    await expect(client.request("workspace/read", { sessionId: "s1", path: "../etc/passwd" })).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(client.request("workspace/read", { sessionId: "s1" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const diff = await client.request<{ repo: boolean }>("workspace/diff", { sessionId: "s1" });
    expect(diff.repo).toBe(true);
    await expect(client.request("terminal/open", { sessionId: "s1" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(client.request("attachment/create", {})).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("limits terminal operations to the paired owner and the connection's session attachment", async () => {
    const terminalRecords = new Map<string, { sessionId: string; principalSubject: string; connectionId: string; sink: { output: (data: string) => void; exit: (code: number | null) => void } }>();
    const calls: Array<{ operation: string; terminalId: string }> = [];
    const terminal: RacpTerminalAccess = {
      async open(sessionId, _options, identity, sink) {
        const terminalId = "term_1";
        terminalRecords.set(terminalId, { sessionId, principalSubject: identity.principalSubject, connectionId: identity.connectionId, sink });
        calls.push({ operation: "open", terminalId });
        return { terminalId, replay: "", cols: 80, rows: 24 };
      },
      async input(terminalId, _data, connectionId) {
        if (terminalRecords.get(terminalId)?.connectionId !== connectionId) throw new RacpError("NOT_FOUND", "terminal attachment");
        calls.push({ operation: "input", terminalId });
      },
      async resize(terminalId, _cols, _rows, connectionId) {
        if (terminalRecords.get(terminalId)?.connectionId !== connectionId) throw new RacpError("NOT_FOUND", "terminal attachment");
        calls.push({ operation: "resize", terminalId });
      },
      async close(terminalId, identity) {
        const owner = terminalRecords.get(terminalId);
        if (owner && (owner.connectionId !== identity.connectionId || owner.principalSubject !== identity.principalSubject)) throw new RacpError("NOT_FOUND", "terminal attachment");
        if (!owner) return;
        calls.push({ operation: "close", terminalId });
        terminalRecords.delete(terminalId);
      },
      async attach(sessionId, terminalId, identity, sink) {
        const record = terminalRecords.get(terminalId);
        if (!record || record.sessionId !== sessionId || record.principalSubject !== identity.principalSubject) return null;
        record.sink = sink;
        record.connectionId = identity.connectionId;
        calls.push({ operation: "attach", terminalId });
        return { terminalId, replay: "", cols: 80, rows: 24 };
      },
      detach() {},
    };
    const h = await harness({ operations: { terminal } });
    const { client, events } = await h.connect(OWNER_TOKEN);
    const opened = await client.request<{ terminalId: string }>("terminal/open", { sessionId: "s1", openRequestId: "open-1" });
    expect(opened.terminalId).toBe("term_1");
    await client.request("terminal/input", { terminalId: opened.terminalId, data: "aGk=" });
    terminalRecords.get(opened.terminalId)?.sink.output("b3V0");
    await flush();
    expect(events.at(-1)).toMatchObject({ scope: "session", sessionId: "s1", kind: "terminal.output", payload: { terminalId: "term_1", data: "b3V0" } });

    const secondOwner = await h.connect(OWNER_TOKEN);
    await expect(secondOwner.client.request("terminal/input", { terminalId: opened.terminalId, data: "dHlwZWQ=" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(secondOwner.client.request("terminal/open", { sessionId: "s2", terminalId: opened.terminalId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await secondOwner.client.request("terminal/open", { sessionId: "s1", terminalId: opened.terminalId });
    await secondOwner.client.request("terminal/resize", { terminalId: opened.terminalId, cols: 100, rows: 40 });
    await secondOwner.client.request("terminal/close", { terminalId: opened.terminalId });
    await secondOwner.client.request("terminal/close", { terminalId: opened.terminalId });
    await expect(client.request("terminal/input", { terminalId: opened.terminalId, data: "c3RpbGwgb2xk" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.map((call) => call.operation)).toEqual(["open", "input", "attach", "resize", "close"]);

    const controllerToken = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_controller", label: "controller", roles: ["controller"], tokenHash: hashToken(controllerToken), createdAt: "2026-09-18T00:00:00.000Z" });
    const controller = await h.connect(controllerToken);
    await expect(controller.client.request("terminal/open", { sessionId: "s1", openRequestId: "open-controller" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects malformed params and oversized frames with typed errors", async () => {
    const h = await harness({ limits: { maxFrameBytes: 512 } });
    const { client, link } = await h.connect(OWNER_TOKEN);
    await expect(client.request("turn/start", { sessionId: "s1" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.request("session/attach", { sessionId: 42 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.request("terminal/open", { sessionId: "s1", openRequestId: "x".repeat(129) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    link().clientSide().send("x".repeat(600));
    await flush();
    const last = JSON.parse(link().toClient.at(-1)!) as { error?: { data?: { code?: string } } };
    expect(last.error?.data?.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

/** Type-only assertion that the envelope import stays used. */
export type _Envelope = RacpEventEnvelope;
