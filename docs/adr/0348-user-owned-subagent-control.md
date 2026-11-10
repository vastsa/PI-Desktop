# ADR 0348: User-owned subagent control without a parent-model round trip

- Status: Implemented candidate
- Date: 2026-11-03
- Deciders: PI-Desktop maintainers
- Related: ADR 0089 (delegation lifecycle and permission scope), ADR 0279
  (resumable chains), ADR 0347 (session inspection),
  `docs/spec/03-runtime/02-agent-runtime.md` §5f.4,
  `docs/spec/04-ux/08-component-spec.md` §5.8
- Supersedes in part: ADR 0347's initial exclusion of direct child-send. Its
  inspection, bounded-history, and default parent-context decisions remain.
- Contract: current code, shared request types, and specs define behavior;
  this record explains the ownership decision, not release qualification.

## Context

The session directory makes a delegate discoverable, but asking the parent to
start or redirect it adds a provider round trip. An unguarded renderer-to-child
shortcut would bypass the session's authority and lose durable attribution.
User actions need the same delegation lifecycle, not another execution engine.

## Decision

1. Add declarative, session-scoped `start` and `message` commands across the
   existing preload/Main/sidecar boundary. The renderer supplies identifiers
   and task data, never launch credentials, permissions, or provider bindings.
   Main resolves current session state and launch configuration; the runtime
   independently admits the operation. Only supported local Agent sessions can
   control delegates. Plan/Goal, Remote, and Native Pi are not silently elevated.
2. Reuse the existing delegation factory, chain registry, child run, cancellation
   owner, and ordered user follow-up queue. A user may attach a permitted model
   choice to that message; it is resolved before admission and the binding changes
   only at its turn boundary, never during an in-flight request, retry, or fallback.
   A settled chain resumes with its history and the chosen model's context budget.
   Model, transport, and credentials change atomically; parent-provider Task
   resume restrictions and the parent model stay unchanged. No parent-model
   request is needed to admit either operation.
   Plain directions now reuse that same ordered queue at the next in-run model
   boundary after the current tool batch. Waiting until the entire Agent loop
   settled made redirection too late. The boundary waits for accepted writes,
   retains context-budget checks, and consumes only the plain-message prefix;
   a pending explicit model change remains an ordering barrier. No additional
   queue, cancellation channel, or execution authority is introduced.
   This includes an interrupted chain reconstructed after application shutdown:
   an explicit user message resumes from saved child history under current
   permissions and model availability. If shutdown occurred before the first
   child reply, its persisted original task can seed that user-requested run.
   Recovery neither replays unfinished tools automatically nor adds the
   interrupted chain to model-issued Task resume.
3. Persist commands as child-owned user rows with additive `subagentControl`
   metadata and an operation identity/hash. Do not forge provider Task calls.
   Repeated identities share one admission; conflicting content is rejected.
   Restored journal entries acknowledge recorded work instead of replaying it.
   Old transcripts need no database migration, and Rust retains SQLite ownership.
4. Adapt user-owned roots to the existing Task-shaped directory/transcript
   readers only for presentation. That adapter is neither persisted nor sent to
   a provider. Child rows stay out of default parent replay, and user-created
   reports do not automatically wake the parent; explicit TaskRead/TaskWait
   remain inspection paths. Sibling and cross-session messaging stay withdrawn.
5. Keep drafts keyed by session and chain across remounts and renderer refresh.
   Pending acknowledgements clear only the submitted revision. Errors and late
   results never clear a newer draft or affect another session.
6. Separate parent Stop from child cancellation. Parent Stop detaches already
   running children, releases only the parent turn, and allows another parent
   prompt without restarting or pruning those children. Explicit child Stop and
   session disposal retain their cancellation ownership. This reuses the same
   runtime and child run rather than introducing a second execution engine.
7. Register each child execution through trusted sidecar reverse RPC before it
   starts. Bind the live owner to its session, original parent turn, and runtime
   generation. The desktop sidecar records each actual tool call before forwarding
   it to Host; Main resolves authority from that registry, not transcript rows or
   caller-supplied delegation ids. Root calls retain `isTurnDispatchable`; all
   dispatch checks run again after asynchronous admission. Host replacement,
   child settlement, explicit cancellation, and disposal revoke authority.
8. Connect `tools.abort` to exact-call signals for plugin tools, plugin MCP,
   user MCP, and remote workspace dispatch while retaining native abort forwarding.
   Parent Stop must not cancel a shared MCP server or another execution's calls.
   Worktree `delegationId` and TodoWrite's owned-running-turn contract are unchanged.
9. Give child plugin tools a synthetic `ctx.turnId` equal to their execution
   owner. On settlement, send `subagent:executionEnded` and a compatibility
   `session:turnEnded` carrying `scope: "subagent"`, `parentTurnId`, and
   `executionOwnerId` only to participating, still-project-active plugins. Parent
   completion is neither delayed nor reinterpreted. These ids are cleanup scopes,
   not concurrent durable turns or authority for session-turn APIs.
10. Reject incompatible runtime configuration with `AGENT_BUSY` while children
    or user control admission remain active, instead of implicitly disposing
    them. Unchanged configuration reuses the runtime; rebuilding is allowed
    once those operations settle.

## Consequences

- Users can start, redirect, and continue a delegate from the session directory
  without delegating those actions back to the parent model.
- Additive control requests, transcript metadata, and bridge-local execution
  lifetimes now exist. SQLite ownership and durable turn semantics are unchanged;
  the plugin cleanup contract explicitly distinguishes child lifetimes below.
- Admission receipts are not proof of completion. Runtime events and persisted
  chain outcomes remain authoritative, including after reload and cancellation.
- Isolated renderer, runtime, and boundary tests cover local behavior. Native
  persistence and PR integration require their own qualification; this record
  does not assert those gates passed.
- Source-sidecar/Main IPC tests cover independent child plugin admission,
  per-call cancellation, configuration-change rejection, and disposal using a
  loopback provider and an in-memory Host adapter. They are not native Host,
  installed-plugin/client, or persistence qualification.

## Alternatives considered

- Keep every follow-up behind a parent Task request: safe, but unnecessarily adds
  latency and context for a direct user action.
- Let the renderer address a child process or append history itself: rejected
  because it duplicates execution ownership and bypasses host admission.
- Persist synthetic parent Task calls: rejected because it invents provider
  provenance and risks leaking user-owned child commands into parent context.
- Accept a transcript or worktree delegation id as child execution authority:
  rejected because history is not a live execution grant.
- Keep the parent turn alive, borrow its successor, or add a second durable
  turn: rejected because those approaches break turn ownership and stale-turn
  rejection. The bridge-local registry preserves the existing Rust notification
  identity fields without adding a second execution engine.
