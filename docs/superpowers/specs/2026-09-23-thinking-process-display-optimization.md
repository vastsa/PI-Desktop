# Thinking Process Display Optimization

## 1. Status and scope

- Status: Approved and implemented. Three staged commits on
  `feat/thinking-process-display-optimization`: `f4ed71d33` (activity breakdown),
  `e1db6ff60` (whole-process folding) and `a166ca892` (interim narration), with the
  documentation sync in the same series. Nothing was pushed.
- Date: 2026-09-23.
- Branch: `feat/thinking-process-display-optimization`, developed directly in the
  project checkout as the request required. This overrides the AGENTS.md §5
  branch-and-worktree rule for this task only: the user asked for no dedicated
  worktree, and the request is a staged change set rather than a single commit.
- Inspected baseline: `4e09fe5f70d512f49bddb8315b6f10a9ccad1c4e`. At inspection
  time `main` and the cached `origin/main` matched, and the working tree contained
  only this untracked document.
- Remote refresh: `git fetch origin main` failed with
  `Permission denied (publickey)`. Every finding here is verified against the local
  cached `origin/main` revision above; this document claims nothing about a newer
  remote revision.
- Scope: renderer transcript presentation and interaction only. No provider event,
  `UiMessage`, IPC/RPC, persisted message, host-core, settings, or Plugin SDK
  contract is changed.
- Evidence: current source, tests, and accepted ADR and spec text, each cited with
  file and line, plus the screenshots supplied with the request. The running
  desktop was not started to reproduce those screenshots.

## 2. Problem

Three defects are visible in one working session, and they come from three
separate policies rather than from one broken component.

**Interim narration is indistinguishable from the answer.** A model that narrates
between tool calls emits assistant text that the transcript cannot classify yet.
`projectTurnProcess()` keeps the last non-empty assistant message in `responses`
and moves every earlier one into `process` (`lib/turn-process.ts:84-98`), so text
that will later be reclassified as progress is presented as the answer until more
activity arrives. The reviewer saw `现在开始改代码。先改 HangUpRowBo.cs...` at answer
width, in answer tone, and read it as the reply. The transcript does not infer
intent from wording, and this design keeps that rule; the defect is that the
provisional state is not presented as provisional.

**The activity summary hides the categories a reader can see.** The summary
reports one aggregate label and one count, plus a boolean note that thinking is
present (`lib/activity-summary.ts:24-44`, `ProcessActivityGroup.tsx:39-51`). The
reviewer's group contained 5 tool calls, 2 command executions and 3 thinking
entries across ten expanded rows, and the header said `7 次工具操作 包含思考`. The
expansion shows three kinds of work; the header reports none of them.

**The whole-turn process never folds.** `shouldAutoOpenTurnProcess()` returns open
for Detailed mode unconditionally (`lib/turn-process.ts:69-76`), while an
untouched nested activity group derives its state from whether its own live
segment is running (`ActivityGroup.tsx:257-261`). Consequently, when the answer
arrives, nested groups fold inside a top-level process that stays open, and the
answer a reader wants sits below a wall of finished work.

## 3. Verified current behavior

| Area | Verified implementation | Consequence |
|---|---|---|
| Trailing assistant text | `projectTurnProcess()` keeps the last non-empty assistant message in `responses` and moves every other assistant text into `process` (`lib/turn-process.ts:84-98`); `AssistantTurn` renders `TurnProcess` before `responses` (`AssistantTurn.tsx:325`, `:372-378`) | Text that later becomes progress is presented as an answer until later activity arrives. Intent is never inferred from wording |
| Process text layout and tone | `.turn-process-body` indents its children (`styles/messages.css:3021-3024`). The secondary color set on the fragment wrapper (`styles/messages.css:3031-3034`) does not reach the text: `.prose-chat` sets `color: var(--ds-text-primary)` (`styles/prose.css:15-16`) and no process-scoped override exists under `styles/` | Process narration differs from the answer by indentation alone, which at answer width reads as body text |
| Activity summary | `activitySummary()` returns one `label`, one `count`, plus `tools`, `thinking` and `issues` (`lib/activity-summary.ts:24-44`). `tools` counts every non-thinking item, hosted-search rounds included (`:25`, `:35`). A mixed group renders the aggregate label plus separate includes-thinking and failure spans (`ProcessActivityGroup.tsx:39-51`) | Direct tool calls, command executions, hosted-search rounds and thinking entries are not reported as separate counts |
| Activity item model | A thinking entry and each hosted-search round are separate activity items built from the same assistant message (`lib/assistant-turns.ts:250-256`); a tool item carries a `delegate` payload for delegated work (`:238-247`) | The four kinds of work are already distinguishable in the data, so no new classification is needed |
| Command classification | `getToolAction()` maps `bash`, `shell`, `exec`, `execCommand`, `runCommand` and `terminal` to `run`, and classifies a search tool as `search` (`lib/tool-display.ts:95-123`) | "Command execution" is a reliable existing classification, and a hosted-search round is not a tool call |
| Header counts at two levels | The top level summarizes every activity item of the turn (`TurnProcess.tsx:45`) and renders `chat.processTools` (`:87-89`); a group summarizes `visibleActivityItems(...)` (`ActivityGroup.tsx:255`, `:398`) | The two header levels count different item sets, and the top level shows no breakdown |
| Whole-turn disclosure default | `shouldAutoOpenTurnProcess()` returns open for Detailed unconditionally (`lib/turn-process.ts:69-76`, called from `TurnProcess.tsx:47-51`); a group derives open from its live segment (`ActivityGroup.tsx:257-261`) | After the turn ends the top-level process stays open while untouched nested groups close |
| Disclosure ownership | `useAutomaticDisclosure()` stores only explicit choices and derives the rest (`disclosure.tsx:17-40`, `:83-87`); a descendant interaction claims its ancestors without toggling them (`:94-97`, `:136`); automatic close already refuses to hide focused or selected content (`:106-113`); only manual toggles notify the scroll anchor (`:115-122`); a search reveal records an open choice (`:99-103`) | The ownership model can carry a changed default without overriding user intent, but the automatic path does not yet participate in scroll anchoring |
| Message completion is not turn completion | `StopReason` is `pending`, `stop`, `length`, `toolUse`, `error`, `aborted` or `deferred` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:316`), and the runtime maps everything except `error` and `aborted` to `status: "complete"` (`packages/agent-runtime/src/native-pi-session.ts:123`). Every appended assistant message emits `message_end` (`:433-450`, wired at `:1056`). Turn-level state is `isRunning`, cleared on `agent_end` (`stores/slices/events-slice.ts:458-459`), and the transcript's `isActive` also subtracts the reading window (`ChatTranscript.tsx:95-98`, `:275`) | A mid-turn narration message that ended on a tool call is already `complete` while the turn keeps running, so message status alone can never prove that a turn finished |
| Persisted status | The canonical transcript record keeps `status` in its meta (`crates/host-core/src/transcripts.rs:41-55`), written at `crates/host-core/src/sessions.rs:293`, read at `:436`, and promoted to `complete` or `aborted` for a turn that was still running when the session ended (`:2063`). The SQLite message index has no status column (`crates/host-core/src/db/schema.rs:143-155`) | Completed turns reload with a recorded status; disclosure choices do not persist |
| Summary vocabulary and plurals | Keys `chat.processTools`, `chat.activityCommands`, `chat.activitySearches`, `chat.activityTools`, `chat.activityThinking`, `chat.activityIncludesThinking` and `chat.activityFailures` (`packages/i18n/src/locales/en/index.ts:467-478`). i18next runs v4 plural suffixes (`apps/desktop/src/main.tsx:42-47`) and Chinese resolves its `_other` form only (`packages/i18n/src/locales/zh-CN/index.ts:425-427`). No combined-summary template key exists | A combined breakdown is new text, not a rewording of an existing key |
| Existing coverage | `apps/desktop/test/turn-process.test.mjs:102-112` asserts Detailed is open for every input, inactive turns included; no test under `apps/desktop/test/` references `activitySummary`; the only summary-text assertion is `scripts/e2e/turn-process.tsx:207` (`"2 tools"`, produced by `chat.processTools`); the Detailed open default is pinned again at `scripts/e2e/turn-process.tsx:113-120` and `scripts/e2e/transcript-disclosure-anchor.tsx:280-283`; `apps/desktop/test/transcript-style.test.mjs:184-191` asserts streaming turns carry no tile background | Every default and wording this design touches is currently pinned by a test that must move with it |

## 4. Design

### 4.1 Interim narration

Keep `projectTurnProcess()` as the source-order projection: a trailing assistant
message stays a response candidate until later activity moves it into the process.
Add renderer-only interim presentation when all of the following hold:

1. The entry is the transcript tail and the session is running
   (`stores/slices/events-slice.ts:458-459`), and the trailing non-empty response
   is still `streaming`, with no `error` and no `aborted` status.
2. A distinct earlier tool call or hosted-search round exists in the process. A
   thinking entry attached to the same assistant message does not qualify.
3. `visibleProcessSteps(process, mode, isActive) > 0`
   (`lib/turn-process.ts:100-122`), the same gate that decides whether
   `TurnProcess` renders (`TurnProcess.tsx:61`).

Read condition 1 from turn-level running state rather than from `isActive`, so a
reader who is inside the reading window does not strip presentation from a turn
that is still running.

When the conditions hold, render the candidate at the process indentation, in the
process text tone, and at the same line measure as progress paragraphs. Keep it
outside the collapsible process body, so folding the process never hides text that
is still streaming. Do not add a card or other chrome, and do not inspect the
message wording.

The tone is part of this design rather than an inherited property: §3 shows that
process narration is only indented today, because `.prose-chat` re-asserts the
primary color. Add one scoped rule so the narration inside the process body and
the interim candidate use the secondary tone, while answer prose outside the
process keeps the primary tone. Use design tokens only, because `apps/desktop`
lints raw style values with `node scripts/check-style-tokens.mjs`
(`apps/desktop/package.json:23`).

Stated side effect: in a turn that already produced a tool call or a
hosted-search round, the final answer also streams with interim presentation, and
the presentation is removed when the message stops streaming. That is the common
path, so the transition must be covered by tests and must not move the reader's
viewport. The accepted ADR already records that `UiMessage` carries no
final-answer marker and that the renderer does not guess intent from wording
(`docs/adr/turn-process-and-thinking-display.md:21-25`).

Unchanged presentation: answer-only turns, pure reasoning followed by an answer, a
single message carrying both thinking and answer text, Compact turns whose process
has no visible step, and candidates that carry an error or an abort.

Ordering: if later tool or thinking activity arrives, the existing projection moves
the same message into the process at its original position and it is rendered
exactly once. If the turn ends without later activity, the message is rendered as
normal answer prose.

### 4.2 Activity breakdown

Report the work a reader can see as non-overlapping categories:

| Category | Definition |
|---|---|
| Tool calls | `kind === "tool"` items whose `getToolAction(message.toolName)` is not `run`. Includes delegation start calls, search tools and every other tool (`lib/tool-display.ts:95-123`) |
| Command executions | `kind === "tool"` items whose `getToolAction(message.toolName)` is `run` (`lib/tool-display.ts:118-122`) |
| Search rounds | `kind === "hostedSearch"` items, one per provider-hosted round (`lib/assistant-turns.ts:253-255`, `packages/shared/src/native-web-search.ts:280-292`) |
| Thinking steps | `kind === "thinking"` items, counted per message-level entry and never per streamed chunk (`lib/assistant-turns.ts:251-252`) |
| Issues | The retained error and denial aggregation (`lib/activity-summary.ts:38-42`) |

Classification rules:

- The four work categories are a partition: every non-thinking activity item is
  counted exactly once, so a command execution is not also a tool call, and a
  hosted-search round is never counted as a tool call.
- Counts are not recursive. A delegation start call counts as one tool call; the
  work its delegate performs is never counted into the parent, matching the
  accepted header rule (`docs/adr/turn-process-and-thinking-display.md:76-78`).
- The invariant `toolCalls + commandExecutions + searchRounds` equals today's
  `tools` count (`lib/activity-summary.ts:25`, `:35`) for the same items, so the
  information in the header only grows.
- In Compact mode both levels derive the counts from the same visible projection
  the group already uses (`ActivityGroup.tsx:255`, `:398`), so reasoning that
  Compact hides is not reported as visible work. The top level does not filter
  today (`TurnProcess.tsx:45`) and must join that rule.

Presentation:

- Both header levels show the same breakdown: the non-zero categories, in a fixed
  order, dropping categories that are zero. A worked example is
  `5 tool calls · 2 command executions · 3 thinking steps`.
- Homogeneous groups read naturally from the same parts, such as `3 thinking
  steps` or `2 command executions`, without a special-case label.
- The aggregate `chat.processTools` wording (`TurnProcess.tsx:87-89`) retires in
  favour of the breakdown; the issue count keeps its current place and styling
  (`TurnProcess.tsx:81-86`).
- Each header remains a `button` whose accessible name must be the complete
  localized breakdown, because the visible text may truncate the trailing parts at
  narrow widths.

Localization:

- Every category pluralizes independently through its own key with v4 `_one` and
  `_other` suffixes. The localized parts are joined in the component with the
  shared `·` separator; no locale-owned combined template key is added, because
  every shipped language orders these noun phrases the same way and one extra
  template per language would only add a second place to keep in sync.
- `chat.activityToolCalls` is new. `chat.activityCommands`,
  `chat.activitySearches` and `chat.activityThinking` already carry the right
  meanings and are reused where the wording matches; Chinese and Traditional
  Chinese adjust the command and thinking wording to "次命令执行"/"次指令" and
  "次思考". The aggregate `chat.processTools` and the retired
  `chat.activityIncludesThinking` and `chat.activityTools` keys are removed from
  the catalogs.
- All eight shipped locales receive every new key and drop the retired ones.
  Chinese resolves its `_other` form only.

### 4.3 Whole-process folding

In Detailed mode an untouched whole-turn process closes only when all of the
following hold:

1. **Out of flight.** The turn is not running: the session's `isRunning` is false
   (`stores/slices/events-slice.ts:458-459`). `isActive === false` is not
   sufficient, because it is also false while a reader is inside the reading
   window (`ChatTranscript.tsx:95-98`, `:275`).
2. **A trailing answer exists.** The projection's `responses` is non-empty and its
   last message carries non-empty content with no `error` and no `aborted` status
   (`lib/turn-process.ts:84-98`).
3. **Success is explicit.** That trailing message carries `status: "complete"`.

Condition 1 is what makes the rule safe. Message status is per message: the
runtime maps `toolUse` to `complete` as well (`packages/agent-runtime/src/native-pi-session.ts:123`)
and emits `message_end` for every appended assistant message (`:433-450`, wired at
`:1056`). Conditions 2 and 3 alone would fold a turn that is still working, and
would hide progress exactly while it is being produced.

| Turn state | Trailing response | Untouched whole-process default |
|---|---|---|
| Detailed, running | any | Open |
| Detailed, out of flight | non-empty answer, `status: "complete"`, no error, no abort | Closed |
| Detailed, out of flight | non-empty answer with no recorded status | Open, because success is unproven |
| Detailed, out of flight | assistant error, or a stopped or aborted partial answer | Open, preserving diagnostic visibility |
| Detailed, out of flight | no non-empty trailing answer, including tool-only completion | Open |
| Compact, any state | any | Keep the current closed default and active-failure exception (`lib/turn-process.ts:69-76`) |
| Any state, and an explicit choice or search reveal owns the disclosure | any | Keep that open or closed choice |

Supporting rules:

- Turn results do not participate: `latestTurnResults` is keyed by session id and
  overwritten each turn (`stores/app-state.ts:143`, `ChatTranscript.tsx:96-98`),
  so it cannot identify a historical turn.
- A recovered tool failure does not block folding. The aggregate issue count stays
  on the visible header so the failure is discoverable, and the answer stays
  outside the process and visible after the fold.
- Reload re-derives the default, so a turn whose recorded status is `complete`
  loads folded (written at `crates/host-core/src/sessions.rs:293`, read at `:436`
  and `:2063`). A manual open made before a reload is not restored, because
  disclosure choices are pane-owned and deliberately not persisted; the spec and
  the E2E scenario must say so instead of gaining persistence.
- Folding uses the existing anchor path: the automatic close notifies the owning
  scroller before the body is hidden, through the notifier in
  `lib/disclosure-anchor-context.ts` that every scroll owner provides. The
  notification carries a reason, so a scroller can tell the two cases apart: a
  manual disclosure always holds the title, while the completion fold holds it only
  for a reader who left the tail. A reader still pinned to the bottom is exempt,
  because holding the collapsed header there would drag the answer out of view.
  Focus and an active selection still win outright and keep the row open.
- Nested activity groups keep their current completion behavior. This design only
  adds the same treatment to the previously persistent top-level parent, so the
  hierarchy keeps one rule instead of two.
- `useAutomaticDisclosure()` ownership stays authoritative: an explicit open stays
  open, an explicit close stays closed, a search reveal is not silently closed, and
  a descendant interaction still claims its ancestors without toggling them.

## 5. Implementation boundaries

| Area | Responsibility |
|---|---|
| `apps/desktop/src/lib/activity-summary.ts` | Produce the four-category partition plus the retained issue count, from a caller-supplied visible projection. This changes an internal renderer contract already shared by `ProcessActivityGroup` and `TurnProcess` |
| `apps/desktop/src/lib/turn-process.ts` | Provide the out-of-flight and confirmed-answer predicates. Response and process ordering, the visibility gate and the Compact failure rule stay as they are. `shouldAutoOpenTurnProcess()` gains inputs, so its call site and the tests that pin its signature move with it |
| `apps/desktop/src/features/chat/transcript/AssistantTurn.tsx` | Apply interim presentation only to an eligible trailing candidate, keep it rendered exactly once, and pass the trailing response and the running signal to `TurnProcess`, which today receives only `processParts`, `turnParts`, `isActive` and `delegationStatuses` (`TurnProcess.tsx:25-39`) |
| `apps/desktop/src/features/chat/transcript/TurnProcess.tsx` | Render the shared breakdown, summarize the same visible projection as the group, derive the new default, and keep the issue marker and the accessible name |
| `apps/desktop/src/features/chat/transcript/ProcessActivityGroup.tsx` | Render the breakdown from the same shared parts instead of the aggregate label plus boolean note |
| `apps/desktop/src/features/chat/transcript/disclosure.tsx`, `apps/desktop/src/lib/disclosure-anchor-context.ts`, `apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll.ts` | Route automatic folding through the existing anchor notifier and keep the focus and selection protection |
| `apps/desktop/src/styles/messages.css` | Add the scoped process narration tone, with tokens only, without changing answer prose or nested header widths |
| `packages/i18n/src/locales/*/index.ts` | Add the per-category plural keys and the combined template in all eight locales, and retire the boolean thinking note |
| `apps/desktop/test/` and `scripts/e2e/` | Move the pinned defaults and wording, and add the cases in §7 |

No new persisted state, IPC, host-core change, setting, or dependency is
indicated.

## 6. Acceptance criteria

1. Interim presentation applies only to a streaming, non-error, non-aborted
   trailing message in a running turn, with a distinct earlier tool or
   hosted-search item present and the process passing the
   `visibleProcessSteps()` gate.
2. Answer-only turns, pure reasoning followed by an answer, a single message
   carrying thinking plus answer text, Compact turns with no visible process, and
   error or aborted candidates keep their existing presentation.
3. Process narration and the interim candidate are visually distinguishable from
   the answer, and answer prose keeps its current tone.
4. When more activity follows, the message is rendered exactly once at its
   original process position. When the turn ends without later activity, it is
   rendered as normal answer prose, and that transition does not move the reader's
   viewport.
5. Both header levels report tool calls, command executions, search rounds and
   thinking steps as separate non-overlapping counts, dropping only zero
   categories, and the tool, command and search counts sum to today's `tools`
   count for the same items.
6. Counts never include delegated child work, and in Compact mode both levels
   count the same visible projection.
7. Every category pluralizes through its own key, the breakdown is localized as
   parts in all eight locales, and the disclosure button's accessible name is
   the complete localized breakdown.
8. In Detailed mode an untouched process closes only when the turn is out of
   flight, a non-empty non-error answer exists, and its status is `complete`. A
   running turn never folds, and a missing status, an error, an abort or a
   tool-only completion stays open. Compact defaults are unchanged.
9. Manual toggles and search reveals stay authoritative, focused or selected
   content is never hidden, a pinned reader follows the answer, and a reader who
   scrolled away keeps the process header position when folding hides the body.
10. Compact reasoning suppression, active-failure behavior, subagent topology,
    nested disclosure independence, and answer visibility after a fold are
    unchanged.

## 7. Validation plan

- Unit tests for the count model: mixed tool, command, search-round and thinking
  items, pure single-category groups, issue counts, Compact visibility, delegated
  work excluded, and the sum invariant of §6.5. `apps/desktop/test/` has no summary
  coverage today, so these are new tests.
- Unit tests for the folding predicate: a running turn whose message is already
  `complete`, an explicit `complete` status with the turn out of flight, a missing
  status, no non-empty answer, an assistant error, an aborted or stopped partial
  answer, and a recovered tool failure. Extend
  `apps/desktop/test/turn-process.test.mjs`, whose Detailed-open assertion at
  `:102-112` pins the current default.
- Extend `scripts/e2e/turn-process.tsx`, which runs through
  `pnpm test:e2e:transcript`, for interim presentation and its removal at
  completion, folding at turn end, the breakdown at both header levels, Compact
  visibility, and manual and search-reveal ownership. Its `"2 tools"` assertion at
  `:207` and its Detailed-open assertion at `:113-120` move with the new wording
  and default.
- Extend `scripts/e2e/transcript-disclosure-anchor.tsx`, run through
  `pnpm test:e2e:transcript-disclosure`, for folding both while pinned at the
  bottom and while reading above the tail; its Detailed-open assertion at
  `:280-283` moves with the new default.
- Add a style assertion for the process narration tone and for answer prose
  keeping its tone, extending `apps/desktop/test/transcript-style.test.mjs` and
  leaving its existing no-tile-background assertion at `:184-191` intact.
- Run `pnpm --filter @pi-desktop/desktop typecheck`,
  `pnpm --filter @pi-desktop/desktop lint` (style tokens), the focused unit tests
  under `apps/desktop/test/`, `pnpm test:e2e:transcript`,
  `pnpm test:e2e:transcript-disclosure` and `pnpm docs:check`. This is the minimum
  sufficient set for a renderer-only change; `verify:ui:*` is not authorized by
  this task, and no live provider or host protocol is exercised.

Run for this implementation:

- `node --test test/{activity-summary,turn-process,transcript-style,transcript-disclosure-reading}.test.mjs` — passed.
- `pnpm --filter @pi-desktop/desktop typecheck` — passed.
- `pnpm --filter @pi-desktop/desktop lint` — `style tokens OK`.
- `pnpm test:e2e:transcript` — passed, including the new folding, breakdown and
  narration checks.
- `pnpm test:e2e:transcript-disclosure` — passed. Its process fixture needed one
  correction: the fixture scroller did not declare `overflow-anchor: none`, which
  the product sets on `.thread-scroll` and `.subagent-run-rows`. Without it the
  browser's own scroll anchoring competed with the held position and the asserted
  geometry was flaky (about one run in three); with it the scenario is stable.
- `node docs/scripts/check-docs.mjs` — 512 pages verified.

## 8. Specification and decision impact

This design changes an accepted default, so it was implemented with an ADR
amendment.

Synchronized in this change:

- `docs/adr/turn-process-and-thinking-display.md`: the `Amended` header, the
  Detailed default, the header count rule for the new categories, the interim
  narration rule next to the existing no-final-answer-marker text, the completion
  fold's anchor rule, the Consequences restatement and the Validation scope;
- `docs/spec/04-ux/08-component-spec.md`: the turn-process section, the group
  header wording and the two wireframes that carried the aggregate label;
- `docs/spec/04-ux/09-interaction-patterns.md`: the collapse-indicator list and the
  reading-position contract, which now carries the completion fold's anchor rule;
- `docs/spec/04-ux/06-settings-ia.md`: the thinking-display-mode row, which stated
  the old Detailed default;
- `docs/spec/06-delivery/04-e2e-test-plan.md`: scenario
  `E2E-CHAT-turn-process-and-thinking-display` and `E2E-040`, both of which asserted
  the Detailed open default and the aggregate summary wording;
- `docs/superpowers/specs/2026-09-20-nested-thinking-process-disclosure-design.md`:
  marked superseded, with a dated note on each recommendation this design replaces,
  so the earlier document no longer reads as a live recommendation;
- the mirrored pages under `docs/zh-CN/`.

`docs/spec/00-baseline.md` has no turn-process entry, so no baseline bump is
expected.

## 9. Decisions and consequences

Settled by the request:

| Decision | Choice | Consequence |
|---|---|---|
| Counting model | Tool calls, command executions and thinking steps are counted as separate categories, and a command execution is no longer part of a "tools" total | The header stops reporting one number that mixed kinds of work. Nothing is lost: the tool, command and search counts sum to today's `tools` count for the same items |
| Breakdown scope | Both the group header and the whole-turn header show the full breakdown | The top-level header is longer, so its visible text may truncate while the accessible name keeps the whole breakdown. The aggregate `chat.processTools` label retires |

Confirmed during implementation:

| Decision | Choice and rationale |
|---|---|
| Search rounds as a fourth category | A provider-hosted search round stays its own count instead of folding into tool calls. The request named three categories, so this was put to the user and confirmed: a hosted-search round is not a tool call, and the retired aggregate is precisely what conflated the two |
| Localized joining | The localized category parts are joined in the component with the shared `·` separator, with no per-locale combined template key. Every shipped language orders these noun phrases the same way, and one extra template per language would add a second place to keep in sync; confirmed by the user over the alternative in §4.2 |
| Process narration tone | Narration inside the process body and the interim candidate use the secondary tone. The reported defect is that interim text reads as the answer, so distinguishing it by indentation alone does not fix it; applying the tone only to the candidate would make narration more prominent than the candidate the moment the text moves into the process |
| Folding trigger | Turn-level running state is required in addition to a completed answer. Message status alone would fold a running turn at its first `message_end`, which is the failure the request asks to remove |

## 10. References

- `apps/desktop/src/lib/turn-process.ts`: response and process projection, the
  visibility gate, the current process default, and turn timing.
- `apps/desktop/src/lib/activity-summary.ts`: current aggregate counts, the
  visible-item projection, and the issue rules.
- `apps/desktop/src/lib/tool-display.ts:95-123`: `getToolAction()` classification,
  including the `run` aliases.
- `apps/desktop/src/lib/assistant-turns.ts:210-262`: how thinking, hosted-search
  rounds and tool activity parts are built.
- `apps/desktop/src/features/chat/transcript/AssistantTurn.tsx:320-378`: process
  and response composition and active-part selection.
- `apps/desktop/src/features/chat/transcript/TurnProcess.tsx:25-104`: props,
  summary, disclosure state and header markup.
- `apps/desktop/src/features/chat/transcript/ActivityGroup.tsx:250-261`, `:398`:
  group live state and the visible-item projection.
- `apps/desktop/src/features/chat/transcript/ProcessActivityGroup.tsx:25-67`:
  current group header composition.
- `apps/desktop/src/features/chat/transcript/disclosure.tsx`: choice ownership,
  automatic close, and the manual anchor notification.
- `apps/desktop/src/lib/disclosure-anchor-context.ts`: the scroll-anchor notifier.
- `apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll.ts`:
  transcript scroll-owner integration.
- `apps/desktop/src/features/chat/transcript/ChatTranscript.tsx:95-98`, `:275`:
  running and active derivation, including the reading window.
- `apps/desktop/src/stores/slices/events-slice.ts:458-459`: turn-level running
  state.
- `apps/desktop/src/stores/app-state.ts:143`: `latestTurnResults` shape.
- `apps/desktop/src/styles/messages.css:3021-3034` and
  `apps/desktop/src/styles/prose.css:15-16`: process layout and the effective text
  tone.
- `apps/desktop/package.json:23`: the style-token lint that constrains new CSS.
- `packages/shared/src/types/messages.ts:81`: `UiMessage.status` values.
- `packages/shared/src/native-web-search.ts:280-292`: hosted-search round
  extraction.
- `packages/agent-runtime/src/native-pi-session.ts:110-126`, `:395-450`, `:1056`:
  message status projection and `message_end` emission.
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:316`: `StopReason`.
- `crates/host-core/src/sessions.rs:293`, `:436`, `:2063`;
  `crates/host-core/src/transcripts.rs:41-55`;
  `crates/host-core/src/db/schema.rs:143-155`: persisted status and the statusless
  SQLite index.
- `packages/i18n/src/locales/en/index.ts:467-478`,
  `packages/i18n/src/locales/zh-CN/index.ts:425-427`,
  `apps/desktop/src/main.tsx:42-47`: current summary keys and plural behavior.
- `apps/desktop/test/turn-process.test.mjs:102-112`,
  `apps/desktop/test/transcript-style.test.mjs:184-191`: current focused coverage.
- `scripts/e2e/turn-process.tsx:113-120`, `:194-209`, `:219-240` and
  `scripts/e2e/transcript-disclosure-anchor.tsx:269-303`: existing probes and the
  defaults they pin.
- `docs/adr/turn-process-and-thinking-display.md:21-25`, `:36-41`, `:76-78`,
  `:84-85`: accepted decision text.
- `docs/spec/04-ux/08-component-spec.md:815-857`,
  `docs/spec/04-ux/09-interaction-patterns.md:820-853`, `:1320-1331`: current UX
  contract.
- `docs/spec/06-delivery/04-e2e-test-plan.md:2301`, `:14340`: scenarios to
  synchronize.
- `docs/superpowers/specs/2026-09-20-nested-thinking-process-disclosure-design.md:5`,
  `:124`: the superseded recommendation.
