# Unreleased changes
- Fixed file writes and edits failing with `HOST_OVERLOADED` under ordinary
  reading traffic. A `Glob`/`Grep` holds the file domain shared while it scans
  (minutes on a large tree), which only writes wait for; an exclusive request
  now waits for the holder it conflicts with instead of giving up at the shared
  30-second window, and the client retries a pre-execution saturation rejection
  for about as long as that window. Stopping the turn still ends the wait.
- A subagent's own events no longer drive the parent session's running state.
  A child that keeps working after its parent turn ended no longer leaves the
  composer stuck in "running" with no way to type, and a child finishing no
  longer clears a parent turn that is still going.
- A child that outlives its parent turn now reads as **running (detached)** in
  both the transcript and the Session subagents tab. The transcript used to
  report it stopped while the subagents tab reported it running, so stopping and
  restarting a child showed two different states; the detached marker clears
  when the child settles.

- Fixed legacy child continuation losing its original provider/model binding.
  Recorded child replies recover missing account keys; new runs persist exact
  account identities. Missing or ambiguous bindings require explicit selection
  instead of substituting the definition/session default. Rejected Task attempts
  no longer clear the original model display or replace its continuation id.
- Restored native Secure DNS controls and resolution across Desktop, local
  provider calls, and Host marketplace requests in the same source candidate as
  independent subagent controls. Saved DNS preferences remain device-local;
  unrelated settings writes preserve them and strict DoH never silently falls
  back to system DNS. Failed or shutdown-stale sidecars are not published.
- Fixed development plugins repeatedly reloading on Windows when NTFS updates
  a source file's last-access time. Read-only injection checks now preserve
  resident proxy connections; genuine edits still reload and permission review,
  disable, and uninstall behavior remains unchanged.
- Create and edit projects with selected skills, MCP servers, and independent
  Markdown stored in the app. Inherit enabled capabilities or select a smaller
  set; saved choices survive reopening and temporarily unavailable entries stay
  removable. Project instructions no longer need a repository Markdown file.
- Fixed overlapping skill and MCP descriptions in Create/Edit project. Long
  capability rows keep their natural height inside the scrollable lists, including
  narrow windows, without changing inheritance or saved selections.
- Parents can recover a child whose provider has emitted no events for two
  minutes using `TaskRecover` and another currently authorized delegation model.
  Thinking events count as activity and tool execution is excluded. Recovery
  preserves the child history and completed tools; the parent model stays unchanged.
- Added a **Session subagents** work-panel tab that lists the current
  conversation's delegations — agent, task, model, and status, with recent
  chains first, search, All / Running / Completed / Issues filters, refresh and
  retry, explicit load-earlier, a detail view, copy of the chain's latest
  delegation id, and the existing confirmed row/stop-all cancellation. A
  resumed Task chain reads as one row, a Task start never opens the tab, and
  the global Settings → Agent → Subagents definition page is unchanged.
  Its index scans at most four 256-row history pages per request and retains no
  child transcripts. Its history read path reuses existing IPC without a database
  migration. See [component spec §5.8](../spec/04-ux/08-component-spec.md) and ADR 0347.
- Added direct **New subagent** and child-message controls for supported local
  Agent sessions. A running child accepts safe steering: ordinary saved messages
  enter the next model request after the current tool batch, without waiting for
  the entire task or interrupting active tools. Ordered model changes remain a
  separate follow-up boundary. A settled chain continues with its history.
  The child model menu can choose a permitted binding for the
  next message without interrupting current work or changing the parent model.
  No parent-model request is needed for admission.
  Main/runtime enforce current authority, commands remain child-owned user rows,
  and operation identities prevent duplicate replay after acknowledgement loss.
  Drafts survive tab remount and renderer refresh without clearing newer edits.
  The control protocol and additive transcript metadata are described in
  [agent runtime §5f.4](../spec/03-runtime/02-agent-runtime.md) and ADR 0348.
  Stopped, interrupted-after-restart, or resume-cache-evicted children remain
  continuable through explicit user controls. Even a first run with no reply can
  continue from its saved original task. Unfinished tools are not replayed.
  TaskList pages recorded chains independently of resume grants, and TaskRead
  remains available after a definition is removed.
- Stopping the parent now leaves already-running children alive across the next
  parent prompt. Child plugin/MCP and remote tools retain independent execution
  ownership and precise cancellation; explicit child Stop and session disposal
  still cancel them. Incompatible runtime configuration is rejected while they
  are active rather than silently destroying their work. Plugin child cleanup
  uses a separate execution id and `scope: "subagent"` lifecycle notices.
- Fixed explicit interface refresh in packaged file-based shells: the navigation
  guard now allows only the exact current document to reload, still blocking
  external URLs and other files. A cancelled reload releases the button after
  10 seconds, preserves live drafts, and discards the stale checkpoint for retry.
- Added opt-in parent inspection of recorded delegation steps through
  `TaskRead`. It is declared in Agent mode even when no subagent definitions are
  configured, denied in Plan/Goal and to delegates, and resolves only this
  conversation's `delegationId` — never files, sessions, paths, or another
  conversation. Pages are bounded (40 steps by default, max 100; 2000 characters
  per value; 20000 per page), gapless through `nextOffset`, and expose only
  visible user tasks/follow-ups, assistant text and tool calls/results, never
  reasoning or provider replay. The default parent context still skips child rows; only a requested
  `TaskRead` output enters the turn. See
  [agent runtime §5f](../spec/03-runtime/02-agent-runtime.md) and ADR 0347.
- Fixed the composer context ring staying at the pre-compaction figure after
  `/compact` or an automatic compaction until another turn ran (#2015). The
  ring now shows the compacted context's estimated size as soon as the
  checkpoint is installed, and after reopening the session.
- Fixed prompt cache misses after a conversation's agent runtime is rebuilt
  (#1972). Rebuilding happens after a restart or when the thinking level, mode,
  project rules, or model settings change. Assistant replies now keep the
  provider's thinking, reasoning, and Gemini function-call signatures in the
  transcript, so Claude, OpenAI Responses, Gemini, and other reasoning models
  receive the same history as before the rebuild instead of a rewritten one.
- Fixed duplicate `/、` when opening slash commands with a Chinese IME in an
  empty composer. Keep pre-edit text intact and apply the slash alias only
  after composition commits, preserving recovery from a missing end event.
- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Fixed an older regenerated prompt appearing after the latest reply when its
  branch archive completed outside the loaded history window (#1870). Pager
  acknowledgements now update existing rows without appending historical roots.
- Generate inline visualizations faster. The visualization shell now preloads
  the bundled D3 and a `viz` chart helper layer (container sizing, resize and
  theme redraw, axes, tick overlap, legends, and a declarative `viz.render`
  for bar, line, area, point, heatmap, and donut charts), so model-written
  fragments are shorter. The `visualize` skill asks for a single write
  followed by the reply instead of reading the file back. Fragments written
  under the earlier skill keep rendering. When a fragment's script fails, the
  card now says so and shows the error instead of staying blank, and the
  model's write result flags syntax errors and missing chart containers so it
  can fix them with one edit.
- Fixed cramped inline visualizations. The visualization shell now places a
  fragment in the kit's `#widget` container, which spaces its top-level blocks
  12px apart, and the `visualize` skill asks for the title, controls, chart,
  legend, and captions as top-level blocks instead of one wrapping element.
  Inline controls, block styling, and roots that lay themselves out keep their
  geometry; cards written earlier inside one wrapping element render as before.
