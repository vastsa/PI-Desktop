# ADR 0140: Fold the Three Peer Tools Into One `Peer` Tool

- Status: Accepted
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Related: D277, ADR 0138, ADR 0062, ADR 0089,
  `03-runtime/02-agent-runtime.md` §5f, E2E-165, E2E-165b
- Amends: ADR 0138 clauses 2 and 3. The mailbox semantics, the caps, and every
  boundary ADR 0138 established are unchanged; this decision only changes the
  *tool surface* a delegate declares and calls.

## Context

ADR 0138 introduced peer messaging as three delegate-only tools — `PeerSend`,
`PeerInbox` and `PeerWait` — declarable in a definition's `tools:` list. A
delegate that opts in writes `tools: [..., "PeerSend", "PeerInbox", "PeerWait"]`
and its spawner materialises three separate tools.

That split has a counting problem. Peer messaging is one capability: it carries
bounded text between running delegates. Listing three machine tool names
for it inflates a definition's declared tool count, forces a roundtable brief
to spell out three names at every use site, and makes the parent's `Task` tool
catalog read as if peer messaging were three unrelated capabilities. The
operations are also mutually exclusive per call — a delegate either sends, or
reads, or waits — so they never compose in one call, which is exactly the shape
an `action` parameter is for.

## Decision

Fold the three tools into **one `Peer` tool** selected by a required `action`
parameter:

- `Peer(action="send", to?, text, topic?, inReplyTo?)` — the former
  `PeerSend`: deliver a note to one running peer, or to all of them when `to`
  is omitted. A broadcast costs one send.
- `Peer(action="inbox", from?)` — the former `PeerInbox`: drain queued
  messages and list running peers; never blocks.
- `Peer(action="wait", timeoutSeconds?, from?)` — the former `PeerWait`: block
  until a message arrives, the timeout expires, the last peer leaves, or the
  run aborts.

Everything else in ADR 0138 stands exactly as decided:

- `SUBAGENT_PEER_TOOLS` is now `["Peer"]`; `isSubagentPeerTool` and
  `subagentUsesPeerMessaging` keep their meaning (declared peer tool → peer
  messaging is on).
- `action` is the only required parameter (`Type.Union` of the `PEER_ACTIONS`
  literals); all operation-specific parameters are optional and validated in
  the dispatch body. An omitted or unknown `action` falls back to `inbox`, the
  read-only, never-blocking operation — the safe default.
- The tool is still built per delegate at spawn time, still closes over the
  runtime-supplied peer id, and is still **absent from `toolCatalog`**, so the
  parent cannot reach it.
- The mailbox (session-scoped `SubagentMailbox`, join/leave/send/drain/wait,
  caps of 2,000 chars, 80-char topics, 64-message inboxes, 60 sends per run,
  120-second wait ceiling) is untouched. The operation names `send`, `inbox`,
  `wait` map one-to-one onto the mailbox's `send`, `drain` and
  `waitForMessages` methods.

## Consequences

- A peer-enabled definition now declares one tool: `tools: [..., "Peer"]`, and
  guidance can describe the capability as a unit.
- The `Peer` tool dispatches inside one `execute`, so the three operations share
  one parameter surface and one `details` shape that records which `action` ran;
  the transcript still records the call as a single peer tool call attributed by
  `parentToolCallId` and `agentName`.
- The roundtable example, the agent-runtime guidance block, and the delegation
  roundtable bullet all reference `Peer(action=...)` instead of three names.
- Four invariants from ADR 0138 remain hard: the `Peer` tool must never enter
  `toolCatalog`; the sender name must stay runtime-supplied; a settled delegate
  must leave the mailbox; and the wait ceiling must stay below the 300-second
  idle watchdog.
- Not addressed: nothing new. Cross-session messaging, messaging with the
  parent, nested delegation, and durable peer history stay out, exactly as in
  ADR 0138.

## Alternatives considered

- **Keep three tools:** rejected because the request that prompted this decision
  stated the contract should read as one tool; three names also inflate every
  counting surface and every brief.
- **A `Peer` tool with three boolean operation flags:** rejected — exactly one
  operation runs per call, so mutually exclusive booleans invite invalid calls
  that an `action` enum rules out by construction.
- **Keep operation names as separate tools but hide them behind a single
  declared name:** rejected — the half-measure keeps the extra transcript and
  catalog surface while adding a confusing declaration↔runtime mapping.
