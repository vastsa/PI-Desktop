/**
 * Subagent peer messaging: a session-scoped mailbox that lets concurrent
 * delegates exchange bounded messages without routing every word through the
 * parent (D277, ADR 0138).
 *
 * The design keeps the delegation boundaries of ADR 0062/0089 intact:
 * - The mailbox is owned by the session runtime, never by a delegate. A
 *   delegate only ever holds the three peer tools the runtime hands it, so it
 *   cannot enumerate, start, or stop delegations.
 * - Nothing here reaches the parent's model context. Peer traffic is delegate
 *   to delegate; the parent still learns only what a report says.
 * - Addressing is by `agentName`, not by delegation id, because that is the
 *   only name a delegate can know: it is told who its peers are in its prompt,
 *   and it never sees the ids `Task` returned to the parent.
 *
 * Every bound below exists because a mailbox is shared mutable state between
 * agents that are all trying to fill their own context. Unbounded, one chatty
 * delegate could exhaust another's window, or two could ping-pong forever.
 */

/** One delivered peer message. */
export type PeerMessage = {
  /** Monotonic per-session sequence, so a reader can order what it drains. */
  seq: number;
  from: string;
  /** Recipient agent name, or `undefined` for a broadcast. */
  to?: string;
  text: string;
  ts: number;
};

/**
 * Caps. A peer message is a coordination note ("I own src/a.ts", "schema is
 * X"), not a transport for file contents: a delegate that needs a file reads
 * it. Sizing the note small is what keeps the mailbox from becoming a way to
 * blow up a peer's context.
 */
export const MAX_PEER_MESSAGE_CHARS = 2_000;
/** Per-recipient queue depth. Oldest are dropped first, and the drop is
 * reported to the reader so a delegate is never silently lied to. */
export const MAX_PEER_INBOX_MESSAGES = 32;
/** Total sends one delegate may make in a run. A ceiling, not a budget to
 * spend: it exists so a loop cannot become an infinite conversation. */
export const MAX_PEER_SENDS_PER_RUN = 40;
/** Longest a `PeerWait` may block. Deliberately far below the delegate idle
 * watchdog (300s) so a delegate waiting for a peer that will never write
 * settles as its own timeout rather than tripping the watchdog. */
export const MAX_PEER_WAIT_SECONDS = 120;
export const DEFAULT_PEER_WAIT_SECONDS = 30;

type Inbox = {
  messages: PeerMessage[];
  /** Dropped by overflow since the last drain, surfaced to the reader. */
  dropped: number;
  /** Wakers for in-flight `PeerWait` calls. */
  wakers: Set<() => void>;
  /**
   * Live delegates sharing this agent name. Two concurrent delegations of one
   * definition are addressed identically, so the inbox outlives the first of
   * them to settle.
   */
  members: number;
};

export type PeerSendOutcome =
  | { ok: true; delivered: string[] }
  | { ok: false; reason: "unknown-peer" | "no-peers" | "send-cap" | "empty" };

/**
 * Session-scoped peer mailbox.
 *
 * Participants are registered by the runtime when a delegate starts and
 * unregistered when it settles, so "who can I talk to" always reflects who is
 * actually running. Messages to a peer that already finished are refused
 * rather than queued forever: a delegate should learn that its peer is gone,
 * not wait on a dead mailbox.
 */
export class SubagentMailbox {
  private readonly inboxes = new Map<string, Inbox>();
  private readonly sendCounts = new Map<string, number>();
  private seq = 0;

  /**
   * Register a running delegate under its agent name.
   *
   * Names are not unique: the parent may run two delegations of the same
   * definition concurrently, and both address peers by the same name. So an
   * inbox is reference-counted and joining an already-present name must not
   * reset its state — resetting the send count there would let a delegate
   * refresh its own cap by having a twin start, and clearing the queue would
   * silently drop mail the first delegate had not read yet.
   */
  join(agentName: string): void {
    const existing = this.inboxes.get(agentName);
    if (existing) {
      existing.members += 1;
      return;
    }
    this.inboxes.set(agentName, {
      messages: [],
      dropped: 0,
      wakers: new Set(),
      members: 1,
    });
    this.sendCounts.set(agentName, 0);
  }

  /**
   * Unregister a settled delegate and wake anything waiting on it, so a peer
   * blocked in `PeerWait` does not hang until its own timeout when the agent
   * it was waiting for has already exited.
   */
  leave(agentName: string): void {
    const inbox = this.inboxes.get(agentName);
    if (!inbox) return;
    // A twin of the same definition may still be running under this name. Wake
    // its waiters so they re-check, but keep the name addressable.
    if (inbox.members > 1) {
      inbox.members -= 1;
      for (const wake of inbox.wakers) wake();
      inbox.wakers.clear();
      return;
    }
    for (const wake of inbox.wakers) wake();
    inbox.wakers.clear();
    this.inboxes.delete(agentName);
    this.sendCounts.delete(agentName);
    // Waiters elsewhere may be blocked on a message this agent will now never
    // send; wake them so they re-evaluate their peer list.
    for (const other of this.inboxes.values()) {
      for (const wake of other.wakers) wake();
      other.wakers.clear();
    }
  }

  /** Running peers other than `self`, in registration order. */
  peers(self: string): string[] {
    return [...this.inboxes.keys()].filter((name) => name !== self);
  }

  /**
   * Deliver `text` to one peer, or to every other running peer when `to` is
   * omitted. A broadcast counts as one send against the sender's cap: the cost
   * being bounded is the sender's ability to loop, not the fan-out.
   */
  send(from: string, to: string | undefined, text: string): PeerSendOutcome {
    const body = text.trim();
    if (!body) return { ok: false, reason: "empty" };
    const sent = this.sendCounts.get(from) ?? 0;
    if (sent >= MAX_PEER_SENDS_PER_RUN) {
      return { ok: false, reason: "send-cap" };
    }
    const targets = to ? [to] : this.peers(from);
    if (to && (to === from || !this.inboxes.has(to))) {
      return { ok: false, reason: "unknown-peer" };
    }
    if (targets.length === 0) return { ok: false, reason: "no-peers" };

    this.sendCounts.set(from, sent + 1);
    const delivered: string[] = [];
    for (const target of targets) {
      const inbox = this.inboxes.get(target);
      if (!inbox) continue;
      inbox.messages.push({
        seq: ++this.seq,
        from,
        ...(to ? { to } : {}),
        text: body.slice(0, MAX_PEER_MESSAGE_CHARS),
        ts: Date.now(),
      });
      if (inbox.messages.length > MAX_PEER_INBOX_MESSAGES) {
        inbox.messages.splice(
          0,
          inbox.messages.length - MAX_PEER_INBOX_MESSAGES,
        );
        inbox.dropped += 1;
      }
      for (const wake of inbox.wakers) wake();
      inbox.wakers.clear();
      delivered.push(target);
    }
    return { ok: true, delivered };
  }

  /**
   * Take everything queued for `agentName`. Draining is destructive because
   * the delegate's own context is now the only copy — keeping a second copy in
   * the mailbox would only invite it to read the same message twice.
   */
  drain(agentName: string): { messages: PeerMessage[]; dropped: number } {
    const inbox = this.inboxes.get(agentName);
    if (!inbox) return { messages: [], dropped: 0 };
    const messages = inbox.messages;
    const dropped = inbox.dropped;
    inbox.messages = [];
    inbox.dropped = 0;
    return { messages, dropped };
  }

  /** True when `agentName` has something queued right now. */
  hasMessages(agentName: string): boolean {
    return (this.inboxes.get(agentName)?.messages.length ?? 0) > 0;
  }

  /**
   * Resolve as soon as `agentName` has mail, the deadline passes, the run
   * aborts, or the set of peers changes such that waiting is pointless.
   * Returns true when mail arrived.
   */
  waitForMessages(
    agentName: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.hasMessages(agentName)) return Promise.resolve(true);
    const inbox = this.inboxes.get(agentName);
    if (!inbox) return Promise.resolve(false);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inbox.wakers.delete(wake);
        signal?.removeEventListener("abort", finish);
        resolve(this.hasMessages(agentName));
      };
      const wake = () => finish();
      inbox.wakers.add(wake);
      signal?.addEventListener("abort", finish, { once: true });
      const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    });
  }

  /** Drop all state; used when the session runtime disposes. */
  clear(): void {
    for (const inbox of this.inboxes.values()) {
      for (const wake of inbox.wakers) wake();
      inbox.wakers.clear();
    }
    this.inboxes.clear();
    this.sendCounts.clear();
  }
}

/** Render drained messages as one bounded block for the delegate's model. */
export function formatPeerMessages(
  messages: PeerMessage[],
  dropped: number,
): string {
  if (messages.length === 0) {
    return "No peer messages.";
  }
  const lines = messages.map(
    (message) =>
      `- [${message.seq}] from ${message.from}${message.to ? "" : " (broadcast)"}: ${message.text}`,
  );
  if (dropped > 0) {
    lines.unshift(
      `[${dropped} earlier message${dropped === 1 ? "" : "s"} dropped: your inbox was full. Peers are told when they hit the cap, but treat this as missing context.]`,
    );
  }
  return lines.join("\n");
}
