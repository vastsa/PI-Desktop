/** Host batch bindings. Resource identity and conflict admission live in Host. */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeHost } from "./host-client.js";
import { FILE_BATCH_VERSION, type FileBatchRegistration } from "@pi-desktop/shared";

type Batch = { id: string; seal?: Promise<unknown>; failure?: Error; calls: Map<object, string> };
type Call = { batch: Batch; id: string; ticket: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class BatchPlanner {
  supported = false;
  private batches = new WeakMap<object, Batch>();
  private byArgs = new WeakMap<object, Call>();
  private execution = new AsyncLocalStorage<Call | undefined>();
  private pendingCleanup = new Set<Promise<unknown>>();
  private negotiation?: Promise<void>;

  constructor(private host: RuntimeHost, private sessionId: string) {}

  /** Capability belongs to the actual execution endpoint, never local stat. */
  async negotiate(remote: boolean): Promise<void> {
    // A runtime is bound to one Host connection/configuration. Background
    // delegates must not switch lock protocols when a later prompt starts.
    this.negotiation ??= this.loadCapabilities(remote);
    await this.negotiation;
  }

  private async loadCapabilities(remote: boolean): Promise<void> {
    if (remote) return;
    let response: unknown;
    try {
      response = await this.host.call("tools.fileBatchCapabilities", { sessionId: this.sessionId });
    } catch (error) {
      if (record(error) && (error.code === -32601 || error.errorCode === "METHOD_NOT_FOUND"
        || (record(error.rpc) && error.rpc.code === -32601))) return;
      throw error;
    }
    this.supported = record(response) && response.version === FILE_BATCH_VERSION && response.supported === true;
  }

  async register(batchKey: object, argsKey: object, call: {
    ordinal: number; toolCallId: string; toolName: string; args: unknown; delegationId?: string;
  }): Promise<void> {
    if (!this.supported) return;
    let batch = this.batches.get(batchKey);
    if (!batch) {
      batch = { id: randomUUID(), calls: new Map() };
      this.batches.set(batchKey, batch);
    }
    if (batch.failure) throw batch.failure;
    const registration: FileBatchRegistration = {
      sessionId: this.sessionId, batchId: batch.id, ...call,
    };
    let response: unknown;
    try {
      response = await this.host.call("tools.fileBatchRegister", registration);
      if (!record(response) || typeof response.ticket !== "string" || !response.ticket) {
        throw new Error("Host returned an invalid file batch ticket");
      }
    } catch (error) {
      batch.failure = error instanceof Error ? error : new Error(String(error));
      // No executor can have started during ordered preparation. Cancel the
      // whole metadata batch instead of stranding successors behind an unknown
      // ticket from a lost registration response. Never retry a write.
      await this.host.call("tools.fileBatchClose", { sessionId: this.sessionId, batchId: batch.id });
      throw batch.failure;
    }
    const prepared = { batch, id: call.toolCallId, ticket: response.ticket };
    batch.calls.set(argsKey, call.toolCallId);
    this.byArgs.set(argsKey, prepared);
  }

  async waitForTurn(argsKey: object, signal?: AbortSignal): Promise<void> {
    const call = this.byArgs.get(argsKey);
    if (!call) return;
    if (call.batch.failure) throw call.batch.failure;
    if (signal?.aborted) throw Object.assign(new Error("file call aborted before dispatch"), { name: "AbortError" });
    // pi prepares the entire parallel batch before starting any executor.
    // Sharing the seal promise prevents an executor from overtaking sealing.
    call.batch.seal ??= this.host.call("tools.fileBatchSeal", {
      sessionId: this.sessionId, batchId: call.batch.id,
    });
    await call.batch.seal;
    if (signal?.aborted) throw Object.assign(new Error("file call aborted before dispatch"), { name: "AbortError" });
  }

  ticket(toolCallId: string): string | undefined {
    const call = this.execution.getStore();
    return call?.id === toolCallId ? call.ticket : undefined;
  }

  execute<T>(argsKey: object, body: () => Promise<T>): Promise<T> {
    // Provider call IDs may repeat in independent delegate conversations. Bind
    // the ticket to this executor, not a process-global toolCallId map.
    return this.execution.run(this.byArgs.get(argsKey), body);
  }

  async settle(argsKey: object): Promise<void> {
    const call = this.byArgs.get(argsKey);
    if (!call) return;
    this.byArgs.delete(argsKey);
    call.batch.calls.delete(argsKey);
    if (call.batch.failure) return;
    // Host only abandons a ticket that never reached tools.execute. Running
    // disk work retains its permit even if the transport waiter was aborted.
    await this.host.call("tools.fileBatchAbandon", { sessionId: this.sessionId, ticket: call.ticket });
  }

  settleBatch(batchKey: unknown): void {
    if (!record(batchKey)) return;
    const batch = this.batches.get(batchKey);
    if (!batch) return;
    this.batches.delete(batchKey);
    for (const args of batch.calls.keys()) this.byArgs.delete(args);
    batch.calls.clear();
    const cleanup = this.host.call("tools.fileBatchClose", { sessionId: this.sessionId, batchId: batch.id });
    this.pendingCleanup.add(cleanup);
    void cleanup.catch((error: unknown) => {
      console.warn("[agent-runtime] Host file batch cleanup failed", error instanceof Error ? error.message : String(error));
    }).finally(() => this.pendingCleanup.delete(cleanup));
  }

  async drain(): Promise<void> { await Promise.all(this.pendingCleanup); }
}

/** Wrap validation and mode guards so pre-Host failures abandon their ticket. */
export function withBatchTurn(tool: AgentTool, planner: BatchPlanner): AgentTool {
  return { ...tool, execute: async (id, args, signal, update) => {
    try {
      await planner.waitForTurn(args as object, signal);
      return await planner.execute(args as object, () => tool.execute(id, args, signal, update));
    } finally { await planner.settle(args as object); }
  } };
}
