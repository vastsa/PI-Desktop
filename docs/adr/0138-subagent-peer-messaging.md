# ADR 0138: Subagent Peer Messaging

- Status: Accepted
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D201, D277, ADR 0062, ADR 0089, ADR 0100,
  `03-runtime/02-agent-runtime.md` §5f / §5f.2, E2E-165
- Amends: nothing. ADR 0062's parent-only integration point and ADR 0089's
  background delegation lifecycle are both preserved; this adds an opt-in
  sibling channel beside them.

## Context

Delegation as built by ADR 0062 and ADR 0089 has exactly one integration point:
the parent. A delegate receives one `task` brief at spawn time, runs alone, and
returns one report bounded to 12k characters. Concurrent delegates cannot see
each other. The only thing they share is mutual exclusion — `PathMutex` in the
sidecar and host-core's one-in-flight-mutation-per-session rule — and both are
locks with no payload.

For the fan-out pattern the `Task` description recommends (one delegate per
independent direction, in one assistant message), that isolation is correct: the
parent asked for independent answers and gets them. It stops being correct as
soon as the directions turn out not to be independent, which the parent cannot
always know when it writes the briefs:

- Two write-capable delegates discover mid-run that they need the same file. The
  path lock serializes the writes, so neither corrupts the other, but the second
  one's edit is built on a version it read before the first one's change. The
  lock prevents a torn write, not a stale premise.
- One delegate disproves an assumption every brief was written against. It has
  no way to say so. It reports the correction, the parent reads it after
  `TaskWait`, and by then the other delegates have finished spending their turns
  on the wrong premise.
- One delegate has already found the fact another is about to spend fifteen tool
  calls searching for. Both searches are paid in full, in separate contexts, and
  the duplication is invisible until the reports land.

Routing these through the parent does not work. The parent is blocked in
`TaskWait` while its delegates run, `task` is write-once so a running brief
cannot be corrected, and adding a parent-mediated relay would mean every
coordination note enters the parent's context — which is the exact cost
delegation exists to avoid.

## Decision

Add a **session-scoped peer mailbox** and three delegate-only tools, opt-in per
definition.

1. `SubagentMailbox` is owned by the session runtime, one per session. A
   delegate never holds a reference to it; it reaches it only through the tools
   the runtime builds for it.
2. Three tools, declarable in a definition's `tools:` list alongside the
   existing seven:
   - `PeerSend(to?, text)` — deliver a note to one running peer, or to all of
     them when `to` is omitted.
   - `PeerInbox()` — drain queued messages and list running peers; never blocks.
   - `PeerWait(timeoutSeconds?)` — block until a message arrives, the timeout
     expires, the last peer leaves, or the run aborts.
3. **Addressing is by agent name, not delegation id.** An agent name is the only
   identifier a delegate can know: it is told its own name and its peers' names
   in its prompt, and it never sees the ids `Task` returned to the parent.
   Exposing ids would hand a delegate a handle on the delegation registry, which
   is the parent's alone.
4. **The sender is bound at spawn time.** Each peer tool closes over the
   delegate's own agent name, supplied by the runtime, so `from` is not a model
   input and a delegate can neither spoof a sender nor read another inbox.
5. **Opt-in and default-off.** A definition that does not name a peer tool is
   unchanged, so every existing definition — including all four builtins — keeps
   ADR 0062 isolation exactly. None of the builtins declare one.
6. **Peer tools are absent from `toolCatalog`.** They are constructed per
   delegate at spawn. The parent already owns the delegation lifecycle through
   the four `Task*` tools and must not gain a second, weaker channel to its
   delegates.
7. **A peer tool is not a host tool call.** Messages are in-process, so they
   bypass `scopeDelegateTools`, carry no `permissionScope`, never reach
   host-core, and consume no tool budget. There is nothing to gate: no file, no
   process, no network.
8. **Peer traffic never enters the parent's model context.** The parent still
   learns only what a report says. A delegate is told, in its prompt, that
   anything mattering to the parent must also be in its report.
9. **Messaging alone is not a delegate.** A definition declaring only peer tools
   is refused at `Task` time with a tool error: it could talk but not work.
10. Every dimension is bounded, because a mailbox is shared mutable state
    between agents that are each trying to fill their own context:
    2,000 characters per message, 32 messages per inbox (oldest dropped first,
    with the loss reported to the reader), 40 sends per run, and a `PeerWait`
    ceiling of 120 seconds against a 300-second delegate idle watchdog.
11. **Draining is destructive.** Once read, a message is gone from the mailbox;
    the delegate's own context is the only copy.
12. **Membership tracks running delegates.** A delegate joins when it starts and
    leaves when it settles. Leaving wakes every waiter, so a delegate parked in
    `PeerWait` on an agent that just exited returns immediately instead of
    waiting out its timeout.
13. **Agent names are reference-counted, not unique.** The parent may run two
    delegations of one definition concurrently, and both are addressed by the
    same name. An inbox therefore counts its live members: a second join neither
    resets the send count — which would let a delegate refresh its own cap by
    having a twin start — nor clears the queue, and the name stops being
    addressable only when the last member leaves.

No IPC, storage, host protocol, or renderer change. `AgentEventEnvelope` is
untouched: peer messages are tool calls of the delegate that sent or read them,
so they already appear in the transcript attributed by `parentToolCallId` and
`agentName` with no new wire contract.

## Consequences

- Two write-capable delegates can claim files before editing them, turning the
  path lock from the only coordination primitive into the backstop it should be.
- A delegate that disproves a shared assumption can say so while its peers can
  still act on it, instead of after `TaskWait` when their turns are spent.
- The parent's context cost is unchanged. Coordination that used to be
  impossible does not become parent context; it stays between the delegates.
- Peer messages are visible in the transcript as ordinary delegate tool calls,
  so a user reviewing a fan-out can see what the delegates told each other
  without a new UI surface.
- Four invariants callers must keep:
  - **A peer tool must never be added to `toolCatalog`.** That would give the
    parent `PeerSend` and, with it, a way to inject messages that bypasses
    `Task`'s brief and the report boundary.
  - **`from` must stay runtime-supplied.** The moment a sender name becomes a
    tool parameter, attribution in the transcript becomes a model claim.
  - **A settled delegate must leave the mailbox.** A stale participant makes
    `PeerSend` report success for a message nobody will ever read, and leaves
    waiters blocked on an agent that is gone.
  - **`PeerWait`'s ceiling must stay below the idle watchdog.** A wait longer
    than 300 seconds of silence would let a delegate kill itself waiting, and
    the failure would read as a hung delegate rather than an unanswered
    question.
- A delegate can now spend turns on messages. The caps bound the worst case, and
  the prompt is explicit that coordination is not conversation, but a definition
  that opts in accepts that its delegate may spend a few turns coordinating.
- Not addressed: cross-session messaging, messaging with the parent, nested
  delegation, and durable peer history. All four stay out.

## Alternatives considered

- **Route peer messages through the parent:** rejected. The parent is blocked in
  `TaskWait` while delegates run, so it cannot relay in time, and every note
  would land in the context delegation exists to protect. It also makes the
  parent's model responsible for correctly forwarding messages it has no
  interest in.
- **Give delegates `TaskList`/`TaskWait` over their siblings:** rejected. Those
  are lifecycle tools over the delegation registry. A delegate waiting on a
  sibling's *completion* rather than a message reintroduces deadlock (two
  delegates each waiting for the other) and hands a worker control over work it
  did not start.
- **Shared scratch files as the channel:** rejected. It works today and is
  exactly the failure mode worth avoiding: no delivery semantics, no bounds, no
  attribution in the transcript, and a polling loop in every delegate that wants
  to listen. It also puts coordination state in the workspace or scratch tree,
  where it outlives the session.
- **Always-on peer tools for every definition:** rejected. It would change the
  behaviour of all four builtins and every existing user definition at once, for
  a capability most delegations do not need. A `code-reviewer` reviewing one
  change has nobody to coordinate with, and the tool would only invite it to
  look.
- **Interrupt-style delivery that injects a message into a peer's next request:**
  rejected. A delegate mid-edit cannot act on an interrupt coherently, and an
  injected message would appear in a context the delegate did not ask to change.
  Pull delivery keeps the delegate in control of when it reads, at the cost of a
  note sometimes being read late — which is why the prompt frames every exchange
  as best effort.
- **Broadcast only, with no directed messages:** rejected. The common case is
  one delegate telling one specific peer that it owns a file. Broadcasting that
  to eight delegates spends eight contexts to inform one.
