/**
 * Live instruction inbox for one running delegate (issue #2544 §4).
 *
 * A parent may append an instruction to a delegation it started while that
 * delegation is still running. The instruction is queued into the delegate's
 * own agent loop and delivered at a model or tool boundary — never mid-stream —
 * and it cannot widen the delegate's permissions, role, or model.
 *
 * "Accepted" is not "delivered". The inbox records both, because a delegate
 * that settles, is cancelled, or never reaches another boundary must not be
 * reported as having received a message it never saw. Only a `user` message
 * that pi actually appended to the run counts as delivery.
 */

/**
 * Bound on one appended instruction. Appending is a correction channel, not a
 * second conversation: a parent that has this much to add should stop the
 * delegation and start a new one.
 */
export const MAX_DELEGATE_INSTRUCTION_CHARS = 4_000;
/** Bound on instructions queued but not yet delivered to one delegate. */
export const MAX_QUEUED_DELEGATE_INSTRUCTIONS = 8;
const MAX_DELEGATE_INSTRUCTIONS = 64;

export type InstructionStatus = "delivered" | "queued" | "undelivered";

export type QueuedInstruction = {
  id: string;
  text: string;
  status: InstructionStatus;
  queuedAt: number;
};

export type InstructionAcceptance =
  | { ok: true; instruction: QueuedInstruction }
  | { ok: false; reason: string };


/**
 * Ordered inbox for one delegate run. Not thread-safe by design: every caller
 * is the same session runtime event loop that owns the delegate.
 */
export class DelegationInbox {
  private readonly entries: QueuedInstruction[] = [];
  private closed = false;

  /** Accept one instruction, or explain why it cannot be queued. */
  accept(options: {
    id: string;
    text: string;
    now?: number;
  }): InstructionAcceptance {
    if (this.closed) return { ok: false, reason: "The delegation no longer accepts instructions." };
    const text = options.text.trim();
    if (!text) {
      return {
        ok: false,
        reason:
          "An appended instruction needs non-empty text. To correct the brief, send what changed and what the delegate should do instead.",
      };
    }
    if (text.length > MAX_DELEGATE_INSTRUCTION_CHARS) {
      return {
        ok: false,
        reason: `An appended instruction is limited to ${MAX_DELEGATE_INSTRUCTION_CHARS} characters. Send the correction only; stop the delegation and start a new one if the task itself changed.`,
      };
    }
    if (this.queued().length >= MAX_QUEUED_DELEGATE_INSTRUCTIONS) {
      return {
        ok: false,
        reason: `${MAX_QUEUED_DELEGATE_INSTRUCTIONS} instructions are already waiting for this delegate to reach a boundary. Wait for it to catch up, or stop it and start a new delegation.`,
      };
    }
    if (this.entries.length >= MAX_DELEGATE_INSTRUCTIONS) {
      return { ok: false, reason: "This delegation has reached its instruction limit. Converge with it before continuing." };
    }
    const instruction: QueuedInstruction = {
      id: options.id,
      text,
      status: "queued",
      queuedAt: options.now ?? Date.now(),
    };
    this.entries.push(instruction);
    return { ok: true, instruction };
  }

  /** Only the child may acknowledge a queued message, by identity, when its
   * loop puts that message into the next request's context. */
  markDelivered(id: string): QueuedInstruction | undefined {
    if (this.closed) return undefined;
    const entry = this.entries.find((candidate) => candidate.id === id && candidate.status === "queued");
    if (!entry) return undefined;
    entry.status = "delivered";
    return entry;
  }

  queued(): QueuedInstruction[] {
    return this.entries.filter((entry) => entry.status === "queued");
  }

  /**
   * The run settled or was cancelled. Anything still queued was never seen, so
   * it becomes `undelivered` instead of being reported as delivered.
   */
  close(): QueuedInstruction[] {
    this.closed = true;
    const dropped = this.queued();
    for (const entry of dropped) entry.status = "undelivered";
    return dropped;
  }

  snapshot(): { queued: string[]; delivered: string[]; undelivered: string[] } {
    const status = { queued: [] as string[], delivered: [] as string[], undelivered: [] as string[] };
    for (const entry of this.entries) status[entry.status].push(entry.id);
    return status;
  }
}
