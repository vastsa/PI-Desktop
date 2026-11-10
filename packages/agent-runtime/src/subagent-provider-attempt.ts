import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";

export const SUBAGENT_STALL_MS = 120_000;
export const SUBAGENT_RECOVERY_ERROR = "SUBAGENT_PROVIDER_RECOVERED";
export type SubagentProgress = {
  phase: "idle" | "provider" | "tools" | "recovering" | "settled";
  providerAttempt?: number;
  providerAttemptStartedAt?: number;
  lastProviderEventAt?: number;
  stalled: boolean;
  recoveryPending: boolean;
};
export type RecoveryTicket = { readonly attempt: number; readonly revision: number };
type Attempt = {
  id: number; revision: number; startedAt: number; lastEventAt?: number;
  end: (recovered: boolean) => void;
};

function failure(model: Model<Api>, message: string, aborted = false): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error", errorMessage: message, timestamp: Date.now(),
  };
}

/** Physical provider attempts only. Observation never aborts or selects a model. */
export class SubagentProviderAttempt {
  private active?: Attempt;
  private serial = 0;
  private reportedStallAttempt = 0;
  private lastEventAt?: number;
  private tools = new Set<string>();
  private phase: SubagentProgress["phase"] = "idle";
  private pending?: RecoveryTicket;
  private listeners = new Set<() => void>();

  constructor(private readonly onChange?: () => void) {
    if (onChange) this.onStall(onChange);
  }

  snapshot(): SubagentProgress {
    const attempt = this.active;
    return {
      phase: this.tools.size ? "tools" : this.phase,
      ...(attempt ? { providerAttempt: attempt.id, providerAttemptStartedAt: attempt.startedAt } : {}),
      ...(this.lastEventAt === undefined ? {} : { lastProviderEventAt: this.lastEventAt }),
      stalled: Boolean(attempt && this.phase === "provider" && !this.tools.size &&
        Date.now() - (attempt.lastEventAt ?? attempt.startedAt) >= SUBAGENT_STALL_MS),
      recoveryPending: Boolean(this.pending),
    };
  }

  /** TaskWait reports each physical attempt once; snapshots remain observational. */
  consumeStallObservation(): boolean {
    const attempt = this.active;
    if (!attempt || attempt.id === this.reportedStallAttempt || !this.snapshot().stalled) return false;
    this.reportedStallAttempt = attempt.id;
    return true;
  }

  reserve(): RecoveryTicket {
    if (this.pending) throw new Error("A recovery is already pending for this subagent");
    if (!this.active || !this.snapshot().stalled) throw new Error("The subagent has no active provider attempt stalled for 120 seconds");
    const ticket = { attempt: this.active.id, revision: this.active.revision };
    this.pending = ticket;
    this.changed();
    return ticket;
  }

  validate(ticket: RecoveryTicket): void {
    if (this.pending !== ticket || this.active?.id !== ticket.attempt || this.active.revision !== ticket.revision || !this.snapshot().stalled) {
      throw new Error("The provider attempt changed or resumed activity during recovery authorization");
    }
  }

  release(ticket: RecoveryTicket): void {
    if (this.pending !== ticket) return;
    this.pending = undefined;
    if (this.phase === "recovering") this.phase = "idle";
    this.changed();
  }

  recover(ticket: RecoveryTicket): void {
    this.validate(ticket);
    this.active?.end(true);
  }

  toolStarted(id: string): void { this.tools.add(id); this.changed(); }
  toolEnded(id: string): void { this.tools.delete(id); this.changed(); }
  settle(): void { this.phase = "settled"; this.pending = undefined; this.tools.clear(); this.changed(); }

  /** A disposable deadline watcher owned by TaskWait, not a lifecycle watchdog. */
  onStall(callback: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      timer = undefined;
      const attempt = this.active;
      if (!attempt || this.tools.size || this.phase !== "provider") return;
      const remaining = SUBAGENT_STALL_MS - (Date.now() - (attempt.lastEventAt ?? attempt.startedAt));
      timer = setTimeout(() => {
        timer = undefined;
        if (this.snapshot().stalled) callback(); else check();
      }, Math.max(0, remaining));
    };
    this.listeners.add(check);
    check();
    return () => { clearTimeout(timer); this.listeners.delete(check); };
  }

  /** Wrap inside setup retry: backoff and tool execution are never provider time. */
  stream(model: Model<Api>, options: SimpleStreamOptions, create: (options: SimpleStreamOptions, isCurrent: () => boolean) => AssistantMessageEventStream): AssistantMessageEventStream {
    const outer = createAssistantMessageEventStream();
    const controller = new AbortController();
    let closed = false;
    let ended = false;
    const close = (phase: SubagentProgress["phase"] = "idle") => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (this.active === attempt) { this.active = undefined; this.phase = phase; this.changed(); }
    };
    const end = (recovered: boolean) => {
      if (ended) return;
      close(recovered ? "recovering" : "idle");
      ended = true;
      // Stop only this physical request. Never abort the Agent or its turn.
      controller.abort();
      const message = failure(model, recovered ? SUBAGENT_RECOVERY_ERROR : "Request aborted", !recovered);
      outer.push({ type: "error", reason: recovered ? "error" : "aborted", error: message });
      outer.end(message);
    };
    const attempt: Attempt = { id: ++this.serial, revision: 0, startedAt: Date.now(), end };
    // A Stop cancels only the physical request and invalidates any pending
    // recovery authorization. The outer stream still ends with the provider's
    // own answer, exactly like an unwrapped delegate, so a parent Stop keeps
    // waiting for every child's real retirement (#1767).
    const onAbort = () => { this.pending = undefined; close(); controller.abort(); };
    this.active = attempt;
    this.phase = "provider";
    this.changed();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // No physical request exists yet, so there is nothing to wait for.
    if (options.signal?.aborted) { end(false); return outer; }
    let inner: AssistantMessageEventStream;
    try { inner = create({ ...options, signal: controller.signal }, () => !closed && this.active === attempt); }
    catch (error) { close(); throw error; }
    void (async () => {
      // Keep draining even if the provider ignores abort. No late event may
      // refresh progress, start a tool, or replace the controlled failure.
      for await (const event of inner) {
        if (closed) continue;
        attempt.lastEventAt = this.lastEventAt = Date.now();
        attempt.revision += 1;
        this.changed();
        if (event.type === "done" || event.type === "error") close();
        outer.push(event);
      }
      if (!ended) { close(); ended = true; outer.end(await inner.result()); }
    })().catch((error: unknown) => {
      if (closed || ended) return;
      close();
      const message = failure(model, error instanceof Error ? error.message : String(error));
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    });
    return outer;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
    this.onChange?.();
  }
}
