# ADR 0347: Session subagent inspection — a session-scoped directory and explicit TaskRead

- Status: Accepted
- Date: 2026-11-02
- Deciders: PI-Desktop maintainers
- Related: ADR 0089 (delegation lifecycle and permission scope), ADR 0062
  (bounded subagents), ADR 0279 (resumable delegations), ADR 0337 (stable
  request prefix), ADR 0028 (session-scoped work-panel contexts),
  `docs/spec/03-runtime/02-agent-runtime.md` §5f,
  `docs/spec/03-runtime/03-tools-and-permissions.md` §10.2,
  `docs/spec/04-ux/08-component-spec.md` §5.8
- Contract: the executable contract stays in the specs and code. This record
  explains the choice; it does not replace those sources.

> Update 2026-11-03: ADR 0348 adds host-admitted, user-owned control commands and
> supersedes the initial exclusion of direct child-send. Inspection, bounded
> history reads, and default parent-context behavior remain unchanged.

## Context

Delegation keeps the parent's context small on purpose: by default, only a
`Task` report enters the parent's model context, and the runtime skips every
persisted row carrying `parentToolCallId`. That is the right default, but it
leaves two practical gaps.

1. **Review without replay.** The parent sees the conclusion, not how the
   delegate got there. "Why did it say that?" is currently answered only by the
   human opening a transcript, and the parent model itself has no bounded way to
   read the recorded steps it is being asked about.

2. **No session-scoped view.** The work panel can open one delegation from a
   topology node, but it has no directory counterpart for "what is running in
   this conversation right now". The Settings → Agent → Subagents destination
   is global definition management; it is not a directory of this session's
   delegations, and it says nothing about what is running.

Naively solving either by replaying delegate rows into the parent, or by
auto-opening a panel whenever a `Task` starts, reintroduces the context cost
delegation exists to avoid and takes the panel away from what the user was
reading.

## Decision

1. **`TaskRead` is an additive, opt-in parent inspection tool.** It pages one
   delegate's recorded visible steps: initial task, ordered user follow-ups,
   assistant text, and tool arguments/results, never hidden reasoning or model-system rows,
   provider replay or attachments. It does not resolve files, filesystem paths,
   session ids, or another conversation. Identity is this conversation's
   `delegationId` from `Task`/`TaskList`, resolved against live records or the
   current session transcript, so a resumed chain pages as one sequence even
   after resume-cache eviction. Inspection never adds a resume grant.
2. **Inspection is Agent-mode only, with unconditional core declarations.**
   `TaskList` and `TaskRead` remain available without configured definitions.
   TaskList keeps live status and resumable ids separate from a `recorded`
   metadata page (offset 0, default 40, max 100, objective previews 512 chars),
   including stopped and user-created chains. Plan and Goal retain these declarations for compatibility but
   reject calls before execution. A delegate never receives it, including
   through `tools: inherit`.
3. **The projection is bounded and gapless.** `offset` defaults to 0, `limit` to
   40 (max 100), every text value is clipped to 2000 characters, and the
   serialized page stays inside 20000 characters. The envelope reports `total`,
   `returned`, `offset`, `hasMore`, `nextOffset`, `truncatedValues`,
   `source` (`live` or `chain`), `status`, and — when only a Task call id
   attributes legacy rows — `unattributedRows` with a note. `nextOffset` counts
   the steps actually emitted; an out-of-range offset is a valid empty page.
4. **The default parent context does not change.** Parent replay always skips
   every `parentToolCallId` row. An explicit `TaskRead` imports only that tool's
   bounded output into the turn, not the underlying raw rows. A page is never
   automatically re-injected on later requests; the tool adds no system-prompt
   section (ADR 0337).
5. **The current-session directory is a singleton work-panel tab.** It lists
   this conversation's delegations — agent, task, model, status, recent chains
   first, one row for a resumed chain — with search, status filters, refresh and
   retry, explicit **load earlier**, a detail view, copy of the chain's latest
   `delegationId`, and row/stop-all cancellation through the existing confirmed
   `TaskStop` routine. Entry points are the conversation topbar bot action and
   New launcher row; the topbar action is hidden without a session and for
   remote sessions. Creating entries withhold handle-dependent controls, while
   selection uses the stable Task-call identity and survives handle arrival.
6. **History reads and retention are independently bounded.** An index request
   scans at most four 256-row `getSession` pages with a 512-character body/value
   preview budget, stops once it finds `Task` rows, and retains only parent
   `Task`/lifecycle metadata, never child transcripts or reports. The Host
   preserves bounded identity/status/resume metadata separately from previews,
   so a large report cannot break chain grouping or turn a failed delegation
   into Completed. A selected chain pages independently around its `Task` anchor
   (256 rows, 8000-character body/value budget per row). Live snapshots win by
   message id and history reads never overwrite the main transcript. Hook-owned
   abort signals reject stale or disposed completions on session change and tab
   close. Projection and page caps are not whole-process memory guarantees.
7. **Inspection reuses existing protocol and storage.** The directory read path
   reuses `getSession`, Task/status projection, `SubagentTranscriptTab`, and
   cancellation. Metadata preservation changes bounded display conversion only;
   canonical uncapped reads remain unchanged. The original parent-only follow-up
   decision is superseded in part by ADR 0348's separately admitted user commands.

## Consequences

- A parent can now justify or audit a delegation without the report-only default
  being weakened; the cost is opt-in and bounded per call.
- Reading retained rows works with `subagents: []` after restore and after
  resume-cache eviction. The session transcript backs inspection identity;
  the bounded in-memory resume registry is neither durable storage nor a
  complete historical directory.
- Legacy rows without `agentName` can still be attributed by their unique Task
  call id. They are counted and disclosed rather than silently dropped or
  silently accepted as the requested agent.
- The directory index costs a bounded number of history reads and retains only
  metadata; child content is loaded separately for the selected chain.
- Two surfaces now exist and must stay distinct in copy and navigation: the
  global definition destination in Settings and this session directory. A
  future consolidation would have to preserve that separation of concerns.
- `Task`, `TaskWait`, `TaskStop`, report text, resume semantics, permissions, and
  storage ownership are unchanged.

## Alternatives considered

- **Replay delegate rows into the parent by default.** Rejected: it recreates
  the context problem delegation exists to prevent and contradicts the report
  contract.
- **Enter the step page through a new IPC/read model.** Rejected: `getSession`
  history paging already provides bounded, attributed reads; a second read path
  would duplicate ownership.
- **Make the directory the global definition page, or add it as a Settings
  tab.** Rejected: one is definition management across projects, the other is
  this conversation's runtime state. Merging them would put a live session view
  behind a Settings navigation step and blur what each surface owns.
- **Auto-open or focus the directory when a `Task` starts.** Rejected: it steals
  the panel from the user's current reading and makes background delegation
  disruptive.
- **An unguarded renderer-to-child send shortcut.** Rejected: it loses permission
  and durable command attribution. ADR 0348 instead reuses host admission and
  the existing delegation owner for direct user commands.
