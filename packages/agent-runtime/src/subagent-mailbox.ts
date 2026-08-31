/**
 * Subagent peer messaging: a session-scoped mailbox that lets concurrent
 * delegates exchange bounded messages without routing every word through the
 * parent (D277, ADR 0138).
 *
 * The design keeps the delegation boundaries of ADR 0062/0089 intact:
 * - The mailbox is owned by the session runtime, never by a delegate. A
 *   delegate only ever holds the one `Peer` tool the runtime hands it, so it
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
  /** Optional topic tag for structured discussions. Free-form, max 80 chars. */
  topic?: string;
  /** Optional reference to an earlier message's seq, for threading. */
  inReplyTo?: number;
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
export const MAX_PEER_TOPIC_CHARS = 80;
/** Per-recipient queue depth. Oldest are dropped first, and the drop is
 * reported to the reader so a delegate is never silently lied to. Sized for
 * group discussions (e.g. 5 peers × 4 msgs/round × 3 rounds = 60). */
export const MAX_PEER_INBOX_MESSAGES = 64;
/** PLACEHOLDER_CAPS */
/** Total sends one delegate may make in a run. A ceiling, not a budget to
 * spend: it exists so a loop cannot become an infinite conversation. Sized
 * for multi-round group discussions with room for both directed and broadcast
 * messages. */
export const MAX_PEER_SENDS_PER_RUN = 60;
/** Longest a wait may block. Deliberately far below the delegate idle
 * watchdog (300s) so a delegate waiting for a peer that will never write
 * settles as its own timeout rather than tripping the watchdog. */
export const MAX_PEER_WAIT_SECONDS = 120;
export const DEFAULT_PEER_WAIT_SECONDS = 30;

/**
 * Operations one `Peer` tool can perform (D277, ADR 0138). A delegate declares
 * the single `Peer` tool; `action` picks the operation. Splitting them was the
 * original three-tool design; folding them into one tool keeps the capability
 * countable as a single tool without changing the mailbox semantics.
 */
export const PEER_ACTIONS = ["send", "inbox", "wait"] as const;
export type PeerAction = (typeof PEER_ACTIONS)[number];

export function isPeerAction(value: string): value is PeerAction {
  return (PEER_ACTIONS as readonly string[]).includes(value);
}

/** Filter options for draining and waiting. */
export type PeerReadFilter = {
  /** Only messages from this sender. */
  from?: string;
};

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

  /** PLACEHOLDER_METHODS */

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
    for (const other of this.inboxes.values()) {
      for (const wake of other.wakers) wake();
      other.wakers.clear();
    }
  }

  /** Running peers other than `self`, in registration order. */
  peers(self: string): string[] {
    return [...this.inboxes.keys()].filter((name) => name !== self);
  }

  /** PLACEHOLDER_SEND */

  /**
   * Deliver `text` to one peer, or to every other running peer when `to` is
   * omitted. A broadcast counts as one send against the sender's cap: the cost
   * being bounded is the sender's ability to loop, not the fan-out.
   */
  send(
    from: string,
    to: string | undefined,
    text: string,
    options?: { topic?: string; inReplyTo?: number },
  ): PeerSendOutcome {
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
    const topic = options?.topic?.trim().slice(0, MAX_PEER_TOPIC_CHARS) || undefined;
    const inReplyTo = options?.inReplyTo;
    const delivered: string[] = [];
    for (const target of targets) {
      const inbox = this.inboxes.get(target);
      if (!inbox) continue;
      inbox.messages.push({
        seq: ++this.seq,
        from,
        ...(to ? { to } : {}),
        ...(topic ? { topic } : {}),
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
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
      // Wake all current waiters. A filtered waiter may re-add itself if the
      // message does not match its filter, so we copy the set before iterating
      // and only delete the original entries, not re-registered ones.
      const current = [...inbox.wakers];
      for (const wake of current) {
        inbox.wakers.delete(wake);
        wake();
      }
      delivered.push(target);
    }
    return { ok: true, delivered };
  }

  /**
   * Read messages for `agentName`, optionally filtered by sender.
   *
   * Draining is destructive for matched messages only: unmatched messages stay
   * queued so a delegate reading messages from one specific peer does not lose
   * messages from others. When no filter is given, all messages are taken.
   */
  drain(
    agentName: string,
    filter?: PeerReadFilter,
  ): { messages: PeerMessage[]; dropped: number } {
    const inbox = this.inboxes.get(agentName);
    if (!inbox) return { messages: [], dropped: 0 };
    const dropped = inbox.dropped;
    inbox.dropped = 0;
    if (!filter?.from) {
      const messages = inbox.messages;
      inbox.messages = [];
      return { messages, dropped };
    }
    const matched: PeerMessage[] = [];
    const kept: PeerMessage[] = [];
    for (const message of inbox.messages) {
      if (message.from === filter.from) {
        matched.push(message);
      } else {
        kept.push(message);
      }
    }
    inbox.messages = kept;
    return { messages: matched, dropped };
  }

  /** True when `agentName` has something queued, optionally from a sender. */
  hasMessages(agentName: string, filter?: PeerReadFilter): boolean {
    const inbox = this.inboxes.get(agentName);
    if (!inbox || inbox.messages.length === 0) return false;
    if (!filter?.from) return true;
    return inbox.messages.some((m) => m.from === filter.from);
  }

  /** PLACEHOLDER_WAIT */

  /**
   * Resolve as soon as `agentName` has matching mail, the deadline passes, the
   * run aborts, or the set of peers changes such that waiting is pointless.
   * Returns true when mail arrived.
   */
  waitForMessages(
    agentName: string,
    deadline: number,
    signal?: AbortSignal,
    filter?: PeerReadFilter,
  ): Promise<boolean> {
    if (this.hasMessages(agentName, filter)) return Promise.resolve(true);
    const inbox = this.inboxes.get(agentName);
    if (!inbox) return Promise.resolve(false);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (force?: boolean) => {
        if (done) return;
        // When filtering by sender, a wakeup from an unrelated message should
        // re-arm rather than resolving. Only resolve when the filter matches,
        // the deadline expired, the signal aborted, or the inbox is gone.
        if (!force && filter?.from && !this.hasMessages(agentName, filter)) {
          // Re-register the waker for the next message arrival.
          const currentInbox = this.inboxes.get(agentName);
          if (currentInbox) currentInbox.wakers.add(wake);
          return;
        }
        done = true;
        clearTimeout(timer);
        inbox.wakers.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve(this.hasMessages(agentName, filter));
      };
      const wake = () => finish();
      const onAbort = () => finish(true);
      inbox.wakers.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
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
  const lines = messages.map((message) => {
    const parts: string[] = [`[${message.seq}]`];
    parts.push(`from ${message.from}`);
    if (!message.to) parts.push("(broadcast)");
    if (message.topic) parts.push(`[${message.topic}]`);
    if (message.inReplyTo !== undefined) parts.push(`(re: #${message.inReplyTo})`);
    parts.push(`:  ${message.text}`);
    return `- ${parts.join(" ")}`;
  });
  if (dropped > 0) {
    lines.unshift(
      `[${dropped} earlier message${dropped === 1 ? "" : "s"} dropped: your inbox was full. Peers are told when they hit the cap, but treat this as missing context.]`,
    );
  }
  return lines.join("\n");
}
