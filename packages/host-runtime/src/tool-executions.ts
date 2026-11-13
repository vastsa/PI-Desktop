export type ChildExecutionOwner = Readonly<{
  sessionId: string;
  turnId: string;
  runtimeId: string;
  executionOwnerId: string;
}>;
export type ToolExecutionIdentity = {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
};
export type ToolExecution = Readonly<{
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  owner?: ChildExecutionOwner;
  signal: AbortSignal;
}>;
export type ChildExecutionEnd = ChildExecutionOwner & { reason: "completed" | "aborted" | "error"; pluginIds: string[] };
export type ToolExecutionPolicy = {
  canStart: (owner: ChildExecutionOwner) => boolean;
  onEnd: (event: ChildExecutionEnd) => void;
};

function denied(message: string): Error {
  return Object.assign(new Error(message), { errorCode: "TOOL_ABORTED" });
}
function field(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw denied(`Invalid execution identity: ${key}`);
  }
  return value;
}
function ownerFrom(input: Record<string, unknown>): ChildExecutionOwner {
  return Object.freeze({ sessionId: field(input, "sessionId"), turnId: field(input, "turnId"),
    runtimeId: field(input, "runtimeId"), executionOwnerId: field(input, "executionOwnerId") });
}
const keyFor = (sessionId: string, toolCallId: string) => JSON.stringify([sessionId, toolCallId]);

/** Ephemeral authority on one trusted sidecar/host connection, never transcript data.
 * Worktree delegation IDs and durable parent turns are not child lifetimes.
 */
export class SidecarToolExecutions {
  private readonly owners = new Map<string, ChildExecutionOwner>();
  private readonly retired = new Map<string, ChildExecutionOwner>();
  private readonly calls = new Map<string, { execution: ToolExecution; controller: AbortController }>();
  private readonly cancelled = new Set<string>();
  private readonly plugins = new Map<string, Set<string>>();
  // A broken sender cannot grow pre-dispatch cancellation state without bound.
  // Saturation fails closed until this transport generation is replaced.
  private saturated = false;
  private policy?: ToolExecutionPolicy;

  setPolicy(policy: ToolExecutionPolicy): void { this.policy = policy; }

  start(input: Record<string, unknown>): void {
    const owner = ownerFrom(input);
    for (const [id, previous] of this.retired) {
      if (this.policy?.canStart(previous) === false) this.retired.delete(id);
    }
    if (this.saturated || this.owners.size + this.retired.size >= 4096 ||
      this.owners.has(owner.executionOwnerId) || this.retired.has(owner.executionOwnerId) ||
      this.policy?.canStart(owner) === false) {
      throw denied("Child execution cannot start on this turn");
    }
    this.owners.set(owner.executionOwnerId, owner);
  }

  end(input: Record<string, unknown>): void {
    const identity = ownerFrom(input);
    const owner = this.owners.get(identity.executionOwnerId);
    if (!owner) return;
    if (owner.sessionId !== identity.sessionId || owner.runtimeId !== identity.runtimeId || owner.turnId !== identity.turnId) {
      throw denied("Child execution ownership mismatch");
    }
    if (input.reason !== "completed" && input.reason !== "aborted" && input.reason !== "error") {
      throw denied("Invalid child execution end reason");
    }
    this.revoke(owner, input.reason);
  }

  private revoke(owner: ChildExecutionOwner, reason: ChildExecutionEnd["reason"]): void {
    this.owners.delete(owner.executionOwnerId);
    this.retired.set(owner.executionOwnerId, owner);
    const pluginIds = [...(this.plugins.get(owner.executionOwnerId) ?? [])];
    this.plugins.delete(owner.executionOwnerId);
    for (const call of this.calls.values()) {
      if (call.execution.owner === owner) call.controller.abort();
    }
    this.policy?.onEnd({ ...owner, reason, pluginIds });
  }

  begin(input: Record<string, unknown>): { execution: ToolExecution; finish: () => void } {
    const sessionId = field(input, "sessionId");
    const toolCallId = field(input, "toolCallId");
    const toolName = field(input, "toolName");
    const turnId = typeof input.turnId === "string" ? input.turnId : undefined;
    const key = keyFor(sessionId, toolCallId);
    if (this.saturated || this.cancelled.has(key)) throw denied("Tool was cancelled before dispatch");
    if (this.calls.has(key)) throw denied("Duplicate tool execution");
    let owner: ChildExecutionOwner | undefined;
    if (input.executionOwnerId !== undefined) {
      owner = this.owners.get(field(input, "executionOwnerId"));
      if (!owner || owner.sessionId !== sessionId || owner.turnId !== turnId || owner.runtimeId !== input.runtimeId) {
        throw denied("Child execution is not live on this runtime and session");
      }
    }
    const controller = new AbortController();
    const execution = Object.freeze({ sessionId, turnId, toolCallId, toolName, owner, signal: controller.signal });
    const call = { execution, controller };
    this.calls.set(key, call);
    return { execution, finish: () => {
      if (this.calls.get(key) === call) this.calls.delete(key);
      this.cancelled.delete(key);
    } };
  }

  get(input: ToolExecutionIdentity): ToolExecution | undefined {
    if (!input.sessionId || !input.toolCallId) return undefined;
    const call = this.calls.get(keyFor(input.sessionId, input.toolCallId));
    const execution = call?.execution;
    return execution?.turnId === input.turnId && execution?.toolName === input.toolName ? execution : undefined;
  }

  markPlugin(input: ToolExecutionIdentity, pluginId: string): void {
    const execution = this.get(input);
    const owner = execution?.owner;
    if (!owner || execution.signal.aborted) return;
    let plugins = this.plugins.get(owner.executionOwnerId);
    if (!plugins) this.plugins.set(owner.executionOwnerId, plugins = new Set());
    plugins.add(pluginId);
  }

  abort(sessionId: string, toolCallId: string): void {
    const key = keyFor(sessionId, toolCallId);
    const call = this.calls.get(key);
    if (call) call.controller.abort();
    else if (this.cancelled.size < 4096) this.cancelled.add(key);
    else this.saturated = true;
  }

  clear(): void {
    for (const owner of this.owners.values()) this.revoke(owner, "aborted");
    for (const call of this.calls.values()) call.controller.abort();
    this.calls.clear();
    this.cancelled.clear();
    this.saturated = false;
  }
}
