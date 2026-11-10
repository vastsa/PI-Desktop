import { randomUUID } from "node:crypto";

type Identity = Readonly<{ runtimeId: string; executionOwnerId: string; turnId?: string }>;
type EndReason = "completed" | "aborted" | "error";

/** One runtime generation's child lifetimes. Never derive these from replayed messages. */
export class DelegationExecutionOwners {
  private readonly runtimeId = randomUUID();
  private readonly owners = new Map<string, { identity: Identity; ending?: Promise<void> }>();

  constructor(private readonly call: (method: string, params: Record<string, unknown>) => Promise<unknown>) {}

  async start(delegationId: string, turnId: string | undefined): Promise<void> {
    const identity = Object.freeze({ runtimeId: this.runtimeId, executionOwnerId: `subagent:${randomUUID()}`, turnId });
    this.owners.set(delegationId, { identity });
    try {
      await this.call("tools.execution.start", identity);
    } catch (error) {
      await this.end(delegationId, "error");
      throw error;
    }
  }

  identity(delegationId: string | undefined): Identity | undefined {
    const owner = delegationId ? this.owners.get(delegationId) : undefined;
    return owner?.ending ? undefined : owner?.identity;
  }

  async end(delegationId: string, reason: EndReason): Promise<void> {
    const owner = this.owners.get(delegationId);
    if (!owner) return;
    owner.ending ??= (async () => {
      try {
        await this.call("tools.execution.end", { ...owner.identity, reason });
      } catch (error) {
        // Transport loss also revokes the host registry; other failures remain
        // diagnosable rather than silently leaking an execution lifetime.
        console.error("[runtime] child execution cleanup failed", error);
      }
    })();
    await owner.ending;
    if (this.owners.get(delegationId) === owner) this.owners.delete(delegationId);
  }
}
