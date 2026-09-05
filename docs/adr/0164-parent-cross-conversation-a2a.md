# ADR 0164: Parent agents collaborate across conversations

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D321, D318, ADR 0147, ADR 0162, ADR 0062,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, E2E-165d
- Amends: ADR 0147 (parent must not call `A2A`) and ADR 0162 (no messaging
  with the parent). Subagent sibling coordination is unchanged.

## Context

ADR 0147 kept the `A2A` tool out of the parent catalog so the parent could not
open a second, weaker channel to its own delegates. ADR 0162 then let
subagents address peers in other sessions, but still not the parent.

That split does not match how users collaborate: they want two conversations
in the sidebar to coordinate, not two nested workers. The parent is the
session's only agent that already has the user's context. Asking the user to
spawn a `discussant` in each chat just to pass a note is the wrong seam.

The broker is already process-global. Each session runtime already lives in
the sidecar map after the first prompt. The missing piece is that the parent
never registers as an A2A client.

The remaining hazard is the original one: if the parent can address its own
subagents, `Task`'s brief and report boundary collapses.

## Decision

1. **Each Agent-mode session runtime registers a parent A2A agent** for its
   lifetime (first prompt through dispose). The card uses `kind: "parent"`,
   name `parent` (host-uniquified to `parent-2`, …), and a description that
   carries the session title. Plan/Goal runtimes do not register.
2. **`A2A` is a core Agent-mode parent tool**, present in the catalog from
   runtime construction — not after broker register. The first call (or the
   first prompt) mints the token. It stays out of Plan/Goal.
3. **Kinds do not mix.** Agent cards carry `kind: "parent" | "subagent"`
   (default `subagent`). `a2a.agents.list` and recipient resolution only
   consider the caller's kind. A parent cannot send to a subagent; a
   subagent cannot send to a parent. Same-session parent-to-delegate
   backchannel is therefore impossible.
4. **Inbound notes join the next parent turn.** Events addressed to the
   parent queue on its peer id. A parent that called `A2A(wait)` wakes as
   today. If the parent is idle, the next `prompt()` prepends a short A2A
   inbox to the user text so the model sees the other conversation's note
   without a separate auto-started turn.
5. **Reachability is runtime-lifetime.** A conversation is discoverable after
   it has an Agent runtime this process (after the first agent prompt) and
   until that runtime is disposed. Sidebar rows with no live runtime are not
   in the registry.

Unchanged: capability tokens, counterpart event routing,
`recipientContextId` delivery, parent still uses `Task*` for its own
delegates, no remote A2A, no nested delegation.

## Consequences

- Two Agent conversations on the same host can `discover` / `send` / `wait`
  / `complete` with each other.
- A parent that omits `to` addresses the unique other live parent, or
  `A2A_NO_PEERS` when several exist — same rule ADR 0162 used for remote
  subagents.
- Subagent A2A no longer lists parent cards, so a roundtable cannot page
  the user through A2A.
- An idle conversation does not start a provider turn on inbound A2A; the
  note waits for the user's next message in that session.
- Not addressed: auto-waking an idle conversation, addressing a session
  that has never run this process, and parent-to-foreign-subagent.

## Alternatives considered

- **Keep parent A2A-less; users spawn discussants:** rejected. That is not
  cross-conversation collaboration; it is nested worker coordination the
  user did not ask for.
- **Let parents address every live agent:** rejected. It reopens the
  parent→own-delegate backchannel ADR 0147 closed.
- **Auto-start a turn in the idle session:** rejected for this change.
  It spends a provider request the user did not send and needs a durable
  host turn the sidecar cannot mint. Inbox-on-next-prompt is enough to
  collaborate once both conversations are in use.
