import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";

import type { LaunchResolver } from "./launch-resolver.js";
import { RuntimeService, type RuntimeHostLink, type RuntimeSidecarLink, type TurnEndedInfo } from "./runtime-service.js";

type Call = { method: string; params: Record<string, unknown> };

class FakeHost implements RuntimeHostLink {
  calls: Call[] = [];
  notify: ((method: string, params: unknown) => void) | null = null;
  available = true;
  private turnCounter = 0;
  messages = new Map<string, UiMessage[]>();
  failAppend = false;
  session: Record<string, unknown> = { id: "s1", mode: "agent", permissionMode: "ask", providerId: "p1", modelId: "m1" };

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "settings.get":
        return {} as T;
      case "session.get":
        return { session: { ...this.session, id: params.id, messages: this.messages.get(String(params.id)) ?? [] } } as T;
      case "session.beginTurn":
        this.turnCounter += 1;
        return { turnId: `turn-${this.turnCounter}` } as T;
      case "session.appendMessage": {
        if (this.failAppend) throw Object.assign(new Error("disk full"), { errorCode: "INTERNAL" });
        const list = this.messages.get(String(params.sessionId)) ?? [];
        list.push(params.message as UiMessage);
        this.messages.set(String(params.sessionId), list);
        return {} as T;
      }
      case "session.endTurn":
        return { ok: true } as T;
      case "session.saveInflightMessage":
        return { ok: true } as T;
      case "plans.abort":
        return {} as T;
      default:
        throw new Error(`unexpected host call ${method}`);
    }
  }
  isAvailable(): boolean {
    return this.available;
  }
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notify = handler;
    return () => {
      this.notify = null;
    };
  }
  onExit(): () => void {
    return () => undefined;
  }
}

class FakeSidecar implements RuntimeSidecarLink {
  calls: Call[] = [];
  notify: ((method: string, params: unknown) => void) | null = null;
  exit: ((info: { intentional: boolean; code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
  roots = new Map<string, string | undefined>();
  rejectPrompt = false;
  running = false;

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "agent.prompt":
        if (this.rejectPrompt) throw Object.assign(new Error("model not configured"), { data: { errorCode: "MODEL_NOT_CONFIGURED" } });
        this.running = true;
        return { accepted: true, turnId: params.turnId } as T;
      case "agent.steeringContext":
        return { supportsVision: false } as T;
      case "agent.steer":
        return { accepted: true, turnId: params.expectedTurnId } as T;
      case "agent.abort":
        return { ok: true } as T;
      case "agent.stop":
        return { requested: this.running } as T;
      case "agent.getStatus":
        return { status: { sessionId: params.sessionId, isRunning: this.running, pendingToolConfirmations: 0 } } as T;
      case "asktool.resolve":
        return { ok: true } as T;
      default:
        throw new Error(`unexpected sidecar call ${method}`);
    }
  }
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notify = handler;
    return () => {
      this.notify = null;
    };
  }
  onExit(handler: (info: { intentional: boolean; code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.exit = handler;
    return () => {
      this.exit = null;
    };
  }
  setProjectInstructionRoot(sessionId: string, projectPath?: string): void {
    this.roots.set(sessionId, projectPath);
  }
  clearProjectInstructionRoot(): void {}
  clearVendorAuthBindings(): void {}
}

const launch: LaunchResolver = {
  async resolve(sessionId, session) {
    return {
      providerId: String(session.providerId ?? "p1"),
      modelId: String(session.modelId ?? "m1"),
      projectPath: "/work/project",
      sidecarParams: {
        sessionId,
        mode: "agent",
        provider: { id: "p1", name: "P1", modelId: "m1", apiKey: "k", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      },
    };
  },
};

function build() {
  const host = new FakeHost();
  const sidecar = new FakeSidecar();
  const events: AgentEventEnvelope[] = [];
  const ended: TurnEndedInfo[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const service = new RuntimeService({
    getHost: () => host,
    getSidecar: () => sidecar,
    launch,
    log: (level, message) => logs.push({ level, message }),
    now: () => Date.parse("2026-09-18T00:00:00.000Z"),
  });
  service.attachHost(host);
  service.attachSidecar(sidecar);
  service.onEvent((envelope) => events.push(envelope));
  service.onTurnEnded((info) => ended.push(info));
  return { host, sidecar, service, events, ended, logs };
}

const owner = { subject: "desktop", roles: ["owner" as const], pairedDevice: true };

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("RuntimeService prompt lifecycle", () => {
  it("opens a durable turn, persists the user row, then starts the runtime under that turn id", async () => {
    const { host, sidecar, service, events } = build();
    const { turnId } = await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    expect(turnId).toBe("turn-1");
    const methods = host.calls.map((call) => call.method);
    expect(methods.indexOf("session.beginTurn")).toBeLessThan(methods.indexOf("session.appendMessage"));
    const prompt = sidecar.calls.find((call) => call.method === "agent.prompt");
    expect(prompt?.params.turnId).toBe("turn-1");
    expect(prompt?.params.content).toBe("hello");
    expect(sidecar.roots.get("s1")).toBe("/work/project");
    expect(service.isBusy("s1")).toBe(true);
    expect(service.activeTurnId("s1")).toBe("turn-1");
    // The user row is announced to subscribers before the runtime answers.
    expect(events.map((event) => event.event.type)).toEqual(["message_start", "message_end"]);
    const userRow = (events[0]!.event as { message: UiMessage }).message;
    expect(userRow.role).toBe("user");
    expect(host.messages.get("s1")?.[0]?.id).toBe(userRow.id);
  });

  it("keeps a client-chosen UUID as the durable user row id", async () => {
    const { host, service } = build();
    const id = "6f1c1e2a-3b4d-4c5e-8f6a-7b8c9d0e1f2a";
    await service.prompt({ sessionId: "s1", content: "x", userMessageId: id, effectivePermissionMode: "ask", principal: owner });
    expect(host.messages.get("s1")?.[0]?.id).toBe(id);
  });

  it("refuses a second prompt while the turn runs and settles the turn on agent_end", async () => {
    const { host, sidecar, service, ended } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    await expect(
      service.prompt({ sessionId: "s1", content: "again", effectivePermissionMode: "ask", principal: owner }),
    ).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-1", ts: 1, event: { type: "agent_end", messageIds: [] } });
    await settle();
    const end = host.calls.find((call) => call.method === "session.endTurn");
    expect(end?.params).toMatchObject({ turnId: "turn-1", status: "completed" });
    expect(ended).toEqual([{ sessionId: "s1", turnId: "turn-1", reason: "completed", settled: true }]);
    expect(service.isBusy("s1")).toBe(false);
  });

  it("closes the turn as failed when the runtime rejects the prompt", async () => {
    const { host, sidecar, service, ended } = build();
    sidecar.rejectPrompt = true;
    await expect(
      service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner }),
    ).rejects.toThrow("model not configured");
    const end = host.calls.find((call) => call.method === "session.endTurn");
    expect(end?.params).toMatchObject({ turnId: "turn-1", status: "error", errorCode: "MODEL_NOT_CONFIGURED" });
    expect(ended[0]).toMatchObject({ reason: "error", errorCode: "MODEL_NOT_CONFIGURED" });
    expect(service.isBusy("s1")).toBe(false);
  });

  it("never starts a runtime turn when the user row could not be appended", async () => {
    const { host, sidecar, service } = build();
    host.failAppend = true;
    await expect(
      service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner }),
    ).rejects.toThrow("disk full");
    expect(sidecar.calls.some((call) => call.method === "agent.prompt")).toBe(false);
    expect(host.calls.find((call) => call.method === "session.endTurn")?.params).toMatchObject({ status: "error" });
  });

  it("records an abort before the cancel request so a late agent_end cannot restate it as completed", async () => {
    const { host, sidecar, service, ended } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    await service.abort("s1");
    expect(sidecar.calls.some((call) => call.method === "agent.abort")).toBe(true);
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-1", ts: 1, event: { type: "agent_end", messageIds: [] } });
    await settle();
    const ends = host.calls.filter((call) => call.method === "session.endTurn");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.params).toMatchObject({ status: "aborted", errorCode: "TURN_ABORTED" });
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("aborted");
  });

  it("ignores a terminal event that names a turn which no longer owns the session", async () => {
    const { host, sidecar, service, events } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    events.length = 0;
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-0", ts: 1, event: { type: "agent_end", messageIds: [] } });
    sidecar.notify?.("agent.event", { sessionId: "s1", ts: 1, event: { type: "agent_end", messageIds: [] } });
    await settle();
    expect(events).toHaveLength(0);
    expect(host.calls.some((call) => call.method === "session.endTurn")).toBe(false);
    expect(service.isBusy("s1")).toBe(true);
  });

  it("persists completed assistant and tool rows under the owning turn", async () => {
    const { host, sidecar, service } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    const assistant: UiMessage = { id: "a1", role: "assistant", content: "done", createdAt: "2026-09-18T00:00:00.000Z", status: "complete" };
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-1", ts: 1, event: { type: "tool_start", toolCallId: "c1", toolName: "Read", args: { path: "a" } } });
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-1", ts: 2, event: { type: "tool_end", toolCallId: "c1", result: "ok" } });
    sidecar.notify?.("agent.event", { sessionId: "s1", turnId: "turn-1", ts: 3, event: { type: "message_end", message: assistant } });
    await settle();
    const appended = host.calls.filter((call) => call.method === "session.appendMessage").map((call) => call.params);
    expect(appended.map((params) => (params.message as UiMessage).id)).toEqual([expect.any(String), "c1", "a1"]);
    expect(appended[1]).toMatchObject({ turnId: "turn-1" });
    expect((appended[1]!.message as UiMessage).toolName).toBe("Read");
    expect(appended[2]).toMatchObject({ turnId: "turn-1" });
  });

  it("turns a host permission request into an agent event that names the asking delegate", async () => {
    const { host, sidecar, service, events } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    sidecar.notify?.("agent.event", {
      sessionId: "s1",
      turnId: "turn-1",
      ts: 1,
      parentToolCallId: "task-1",
      agentName: "reviewer",
      event: { type: "tool_start", toolCallId: "c9", toolName: "Bash", args: {} },
    });
    events.length = 0;
    host.notify?.("permissions.request", {
      requestId: "req-1",
      sessionId: "s1",
      toolCallId: "c9",
      toolName: "Bash",
      argsPreview: "rm",
      risk: "high",
      reason: "shell",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.turnId).toBe("turn-1");
    expect(events[0]?.event).toMatchObject({
      type: "tool_permission_request",
      request: { requestId: "req-1", agentName: "reviewer", parentToolCallId: "task-1" },
    });
  });

  it("settles every running turn as aborted when the sidecar dies", async () => {
    const { host, sidecar, service, ended } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    sidecar.exit?.({ intentional: false, code: 1, signal: null });
    await settle();
    expect(host.calls.find((call) => call.method === "session.endTurn")?.params).toMatchObject({
      status: "aborted",
      recoverInflight: true,
    });
    expect(ended[0]?.reason).toBe("aborted");
    expect(service.isBusy("s1")).toBe(false);
  });

  it("steers only the live turn and refuses once it ended", async () => {
    const { sidecar, service } = build();
    await service.prompt({ sessionId: "s1", content: "hello", effectivePermissionMode: "ask", principal: owner });
    expect(await service.steer({ sessionId: "s1", turnId: "turn-1", content: "also", principal: owner })).toEqual({ accepted: true });
    expect(sidecar.calls.at(-1)?.params).toMatchObject({ expectedTurnId: "turn-1", content: "also" });
    expect(await service.steer({ sessionId: "s1", turnId: "turn-9", content: "no", principal: owner })).toEqual({ accepted: false });
  });

  it("refuses native Pi sessions and attachments the headless runtime cannot serve", async () => {
    const { service } = build();
    await expect(
      service.prompt({ sessionId: "native-pi:x", content: "hi", effectivePermissionMode: "ask", principal: owner }),
    ).rejects.toMatchObject({ errorCode: "NATIVE_PI_UNSUPPORTED" });
    await expect(
      service.prompt({
        sessionId: "s1",
        content: "hi",
        attachments: [{ path: "/tmp/a.png", name: "a.png", kind: "image" }],
        effectivePermissionMode: "ask",
        principal: owner,
      }),
    ).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  });
});
