# Nested Thinking and Tool Process Disclosure

## Status and scope

- Status: Proposed for review; implementation is not authorized by this document.
- Date: 2026-09-20.
- Branch: `feat/thinking-process-collapse`, directly in the project checkout as requested.
- Inspected baseline: `aad46adb` (local `main` and cached `origin/main` at intake). Fetching remote `main` failed with SSH `Permission denied (publickey)`; this proposal does not claim verification against the latest remote revision.
- Deliverable: interaction design, implementation boundaries, and acceptance criteria only. No runtime, UI, settings, or accepted specification changes are included.
- Validation scope, per the user's explicit instruction: static checks and compilation only. Runtime tests are not required for this proposal or its implementation; section 8 defines the scoped validation commands.
- Reference: the three screenshots supplied with the request. They demonstrate whole-process and command-group disclosure; they do not establish Codex's live defaults, persistence rules, or internal implementation. Those details below are PI-Desktop design decisions.

## 1. Problem and verified current behavior

In the supplied PI-Desktop screenshot, consecutive search/tool and thinking rows remain visible between assistant progress paragraphs. Users can inspect individual details, but cannot collapse the entire block of rows as one unit in detailed mode. A long operation therefore makes progress narration and the final answer harder to scan.

The gap is at the container levels, not an absence of all disclosure controls:

| Surface | Verified implementation | Consequence |
| --- | --- | --- |
| Whole process | `shouldGroupTurnProcess()` returns true only for compact mode | Detailed mode has no whole-process disclosure |
| Ordinary activity group | `AssistantTurn` passes `embedded`; `ActivityGroup` returns rows directly for embedded groups without subagents | There is no group header to hide a cluster of tool/thinking rows |
| Individual tool/search/thinking | `ToolRow`, `HostedSearchRow`, and `ThinkingRow` already have disclosure behavior | Preserve these controls and their payload rendering |
| Automatic opening | Only the literal final item of the last activity group receives the tool/search auto-open flag; failed/denied tools suppress it. If that final item is thinking, no earlier tool is selected instead | Preserve this positional rule; nesting must not open every payload |
| User ownership | `useAutomaticDisclosure()` stops automatic changes after manual interaction for that component's lifetime | Preserve and extend this principle across ancestors |
| Existing specification | The accepted turn-process ADR explicitly says detailed mode does not wrap a process | This proposal intentionally changes that presentation decision; it is not an already-approved contract |

Source references are listed in section 10. Findings are based on source and test inspection; the running desktop was not used to reproduce the screenshots.

## 2. Recommended interaction model

Use three independent disclosure levels:

1. **Turn process:** all process content belonging to one existing assistant-turn entry, with a duration/status header. The trailing response and assistant errors remain outside it.
2. **Activity group:** one contiguous segment of tools, provider-hosted searches, and reasoning rows between assistant progress paragraphs. Collapsing it hides all its item headers and details, leaving one summary row.
3. **Item details:** the existing tool arguments/results, command output, search results, or reasoning text for one item.

Progress narration remains between groups within the turn process. Users can read the explanation with execution details folded away, expand one group, then inspect one result. Closing the outer process hides the complete process with one action.

“Process” is a UI umbrella term. Provider reasoning, assistant progress text, tool execution, and the final answer remain distinct data and are not merged into one reasoning field.

### Example: the user's search sequence

Fully collapsed process:

```text
> Processed for 9m 36s · 4 tools

The final answer remains visible here.
```

Process expanded, activity groups collapsed:

```text
v Processed for 9m 36s · 4 tools
  I will locate the compression threshold and its defaults.

  > Searched code · 2 searches · includes thinking

  I found the core file and will inspect its defaults.

  > Searched code · 2 searches · includes thinking

The final answer remains visible here.
```

One activity group expanded, followed by an explicit click to expand one search item:

```text
v Processed for 9m 36s · 4 tools
  I will locate the compression threshold and its defaults.

  v Searched code · 2 searches · includes thinking
    > Search  (compact|compress).*threshold
    v Search  autoCompact|auto_compact
      Search arguments and results...
    > Thinking  Inspect the shared context settings...

  I found the core file and will inspect its defaults.
  > Searched code · 2 searches · includes thinking

The final answer remains visible here.
```

The “includes thinking” text illustrates the mixed content in the screenshot. It may be omitted when space is tight, but the accessible group name must describe the content accurately. The same structure uses “Ran 5 commands” for a command-only group.

### Grouping rules

- Reuse existing `AssistantTurnPart` activity boundaries and item order. Do not infer phases from natural-language headings, elapsed-time thresholds, or tool names.
- Assistant progress text ends an activity group. Do not combine groups across progress paragraphs merely because they run the same tool.
- Thinking may remain in the same activity group as adjacent tools, matching the user's red-box examples. A thinking row alone is a direct item disclosure; avoid an empty extra group layer.
- A single ordinary tool/search item also uses its item disclosure directly. A group header is useful for two or more visible items. Hidden compact-mode thinking does not create an otherwise redundant group.
- When a live singleton grows into a group, retain its item identity and any manual choice. A manually opened item makes the new group open and user-owned, so newly introduced nesting does not hide content being read.
- Keep existing Task topology boundaries. Do not fold parent tools into a subagent's work or duplicate subagent rows in an ordinary activity group. The existing topology card serves as that segment's second-level container. Keep its detail-panel presentation; extend navigation into that existing panel as specified in section 5.
- User/system messages and compaction dividers keep their existing turn boundaries. Only loaded history is grouped; no reconstruction of unloaded turns is implied.

## 3. Default states and manual ownership

The setting remains `thinkingDisplayMode: detailed | compact`, with absent/unknown values resolving to detailed. No additional settings are needed.

The table describes untouched controls. Explicit user choices override these defaults.

| Level | Detailed: active | Detailed: completed/history | Compact |
| --- | --- | --- | --- |
| Whole process | Open | Open | Closed, except an untouched active turn containing any recorded failed/denied tool remains open, even after later successful tools |
| Ordinary activity group | Open while it owns the active execution segment | Closed | Closed |
| Tool/search payload | Preserve the literal-last-item rule described below | Preserve that same rule inside closed ancestors | Closed |
| Reasoning item | Keep existing live reasoning behavior | Closed | No reasoning text or excerpt; active thinking indicator only |
| Task topology | Retain current live/manual policy | Retain current policy | Retain current policy |

Detailed mode keeps completed progress narration visible by default, preserving its purpose. It gains a whole-process collapse control while completed execution groups become easier to scan. Adopting Codex-like nesting does not require silently changing detailed mode into compact mode.

The preserved leaf default applies only when the literal final item of the last activity group is a tool or hosted-search row, with that row's existing failure/denial guards. It does not scan backward past a thinking item to find a tool. Opening an untouched completed group exposes its precomputed leaf defaults; it does not reset them closed. Thus a group ending in an eligible tool can reveal that tool's output immediately, while the screenshot example ending in thinking reveals only headers until an item is explicitly opened.

### State transition rules

- Clicking a header changes only that level. Opening a group never means “expand all descendants.” Closing a parent does not reset any child choices.
- Opening a previously closed parent restores child states. Sibling groups remain independent; this is not an exclusive accordion.
- A manual action on an item claims the containing group and turn as user-owned, without toggling either ancestor. Completion must not close the container around an output the user explicitly opened.
- If a user closes an active group or the whole process, new tool calls, streaming text, retries, and completion do not reopen it. Only summary/status information changes.
- Automatic completion may close an untouched active group. It must not close a group whose output is being selected, whose body holds keyboard focus, or whose body was explicitly interacted with. Those actions establish user ownership.
- A tool error does not imply that the assistant turn failed. A later successful recovery does not erase the earlier tool's failure marker.
- Show a collapsed group's running or failure summary even when its payload is hidden. If the whole process is closed, propagate the aggregate to its visible header. Do not reopen manually closed ancestors to show an error. Preserve the compact outer exception: while the turn is active, any recorded failed/denied tool keeps an untouched outer process open through later progress or successful recovery. It closes automatically on turn completion only if still untouched. Inner groups remain closed with issue counts visible; raw error output requires explicit opening. The design must account for failure -> progress -> successful tool -> turn completion, both untouched and manually closed; review this path statically.
- No timer-based auto-collapse and no automatic “collapse everything when the answer arrives.” The default detailed process remains open unless the user closes it.

### State lifetime

Disclosure state belongs to the transcript presentation, keyed by session, stable turn identity, activity identity, and item identity. Do not use array indexes or localized labels as keys.

The initial implementation should retain choices while the owning session pane is retained, including streaming, completion, mode changes, and row remounts within its mounted-history window. Evicting the session pane, deleting the session, or restarting the renderer releases those choices and reapplies defaults. Cross-restart persistence is out of scope.

Use one authoritative pane-owned disclosure map for retained state; component-local state cannot satisfy remount and reparenting guarantees. Each node records its effective `open` value, ownership (`automatic` or `user`), and last applied reveal request. Stable item keys use message ID plus kind; hosted search adds its round ID. Group identity derives from its first unfiltered activity item. Mode filtering cannot change keys. Keep this map out of persisted messages and the central workflow store.

When a singleton gains a group wrapper, reuse its item record unchanged. Create the group record from the mode default unless a manually opened or focused/selected child requires an open, user-owned group; an explicitly closed ancestor still wins. When filtering removes a redundant wrapper, retain its record for later restoration. Explicit reveal/toggle events apply in event order; automatic updates never overwrite user-owned records. Search applies only once per new request. Release records on session-pane eviction/deletion/restart and prune nodes authoritatively removed from the transcript, not nodes merely outside the mounted window.

Mode switches preserve explicit choices for surviving nodes and reapply defaults only to untouched nodes. Compact still suppresses all reasoning text, regardless of a retained thinking-item open state. Switching back to detailed restores that item's choice within the retained pane.

## 4. Headers, hierarchy, and status

### Whole-process header

Use one lightweight header with a consistent chevron, status/duration, a count, and an issue marker when necessary. Use the existing recorded timing helpers; UI clocks must not introduce persisted timing fields or invent a precise historical duration when evidence is absent.

Suggested localized labels:

| Meaning | English | Simplified Chinese |
| --- | --- | --- |
| Reasoning is currently active | Thinking for {time} | 思考中 {time} |
| Tools or preparation are active | Processing for {time} | 处理中 {time} |
| Process has ended | Processed for {time} | 用时 {time} |
| Homogeneous command group | Ran {count} commands | 运行了 {count} 条命令 |
| Homogeneous search group | Searched code · {count} searches | 搜索代码 · {count} 次 |
| Mixed group | Tool activity · {count} tools | 工具操作 · {count} 项 |
| Mixed group with reasoning | Includes thinking | 含思考 |
| Group contains failure | {count} failed | {count} 项失败 |

Final wording goes through existing i18n/pluralization conventions. The process count should name what it counts: tools/search rounds rather than silently including progress paragraphs under a “tools” label. Count each direct tool invocation and hosted search round once; do not double-count delegated child work. If there are no tools, omit the tool count. Detailed thinking-only processes remain collapsible; completed compact thinking-only processes leave no empty header.

### Group and item headers

- Derive group labels from existing action categories; use a neutral mixed label rather than calling every tool a command. Multiple reasoning-only items use a Thinking group with a reasoning-item count, never a zero-tool activity label. Compact omits completed reasoning-only groups entirely.
- A collapsed group shows count, running state, and issue count as applicable. Live updates remain bounded to the summary row; do not print raw output or long reasoning excerpts beneath a folded group.
- Keep command text, file/search summary, output preview links, copy actions, status and duration on item headers as currently supported. Long commands truncate in the header; full content remains available through existing detail/copy surfaces.
- Failed, denied, cancelled and running states use text/icon distinctions, not color alone. Status aggregation must reuse existing command exit-code and delegation outcome logic; a tool transport success with a nonzero shell exit remains a failed command.
- Preserve existing single-owner live-status selection. The new group must not add another independent “working” indicator beside the transcript's current authoritative status.

### Visual treatment

Use existing typography, color, radius and motion tokens with lightweight rows. Indent each container level modestly; avoid three nested cards or deep indentation that consumes command-output width. Keep chevrons visible at rest, pointing right when closed and down when open. Hover treatment supplements the chevron rather than being the only discovery cue.

Each header and optional collapse rail controls its own container. Nested CSS selectors must be scoped to direct children so opening the outer process does not rotate every inner chevron or expand every descendant body. Expanded output may retain its existing bounded scrolling; do not add a second scrollable container for ordinary groups.

On narrow windows, preserve status and disclosure controls; truncate optional summaries first. Cover light, dark, and plugin themes and reduced-motion preferences using existing tokens.

## 5. Search, accessibility, and reading position

### Search and navigation

For an existing search/navigation target, reveal the ancestor path needed to expose it: turn, containing group, then item detail when the target is in that detail. The current renderer `TranscriptSearchTarget` carries only `messageId`, which cannot distinguish thinking, response text and multiple hosted-search rounds. Add a renderer-local target descriptor with item kind (`message`, `thinking`, `tool`, `hostedSearch`), message ID, hosted-search round ID where applicable, and the owning task/delegation identity for delegated children. Preserve the current session/query/request fields. Existing message-only search results continue to target message content; a more precise kind is supplied only when the navigation source can identify that surface. Do not invent a target from an ambiguous message ID or change host indexing as part of this design.

Give each target a stable item DOM anchor using the same item identity as disclosure state, rather than selecting the first matching message ID. Apply the reveal request to its ancestor path, await the React commit and target registration in the owning scroll surface, then highlight/focus/anchor it. Use layout/registration synchronization rather than a fixed delay. A newer request, session change or pane disposal invalidates outstanding focus work.

For a delegated-child target, reveal the owning Task topology and select the existing subagent detail panel; do not introduce an additional inline task rendering. Resolve the latest owning task in a resumed delegation chain, then reveal the child's item inside the panel and focus it through the panel's own scroll owner. Extend the panel's reveal input and item anchors for this purpose. If the owning task or child cannot be loaded through existing navigation, report that the target is unavailable rather than focusing an unrelated main-turn row.

A new explicit reveal request may override a previous manual close. Re-rendering the same request must not repeatedly force-open a node after the user closes it. Closing search does not collapse the path automatically.

This proposal does not expand search indexing scope. Compact-mode reasoning remains hidden: a reasoning-only target should offer the existing mode switch to detailed rather than silently revealing text or changing the saved setting. If the target is not loaded, use existing history loading before resolving the disclosure path.

### Keyboard and assistive technology

- Use real buttons for disclosure headers with `aria-expanded`, stable `aria-controls`, localized names and visible focus treatment. Enter and Space toggle only the focused header.
- Closed descendants are hidden/inert or unmounted, excluded from tab order and accessibility traversal. Do not nest buttons inside buttons.
- Copy, file-preview and link actions do not bubble into a parent toggle. Text selection does not toggle a disclosure.
- Before hiding content that contains focus, move focus to its visible controlling header. If an ancestor is also closing, focus the nearest remaining visible ancestor header.
- Announce material status changes politely through the existing status owner; do not announce every token or every elapsed second.
- Collapse rails must have distinct accessible labels, such as “Collapse tool group” and “Collapse command output.” They supplement the header control.

### Scroll ownership

Preserve the existing disclosure anchor mechanism. Capture the clicked level's header and viewport offset before changing height, and keep that header stable through layout/animation. Only the initiating disclosure claims the scroll anchor; claiming ancestors for manual ownership must not also claim their scroll positions.

If the user has scrolled away from the bottom, expanding/collapsing does not jump to the latest output. Stream-follow resumes only through existing follow/jump behavior. Opening ancestors for search uses the search target as its final anchor. Parent visibility changes do not reset a retained child output's reading position.

## 6. Responses, errors, and actionable content

Reuse `projectTurnProcess()` semantics: the trailing assistant text is provisionally visible outside the process while streaming. If later activity proves it was progress, move it into the process in original order. Do not infer a final answer from its wording. Preserve its identity and reading anchor during reclassification, and do not reopen a manually closed process.

Assistant errors and stopped trailing partial answers remain visible outside the process. Keep user messages, permission requests, ask/question interactions, plan/goal approval surfaces and outcome cards reachable according to their existing ownership. Never make a pending decision accessible only by expanding a hidden ancestor.

Review/change cards need an explicit placement check during implementation: completed informational cards may remain with their tool, while any card requiring a user action must have an always-reachable existing action surface. Do not duplicate approval controls or change their execution semantics to solve visibility.

Parent process collapse does not close an already-open subagent detail panel or cancel work. Folding is purely presentational: no effect on tool execution, permissions, retries, cancellation, stored reasoning, context use, export or copy payloads.

## 7. Implementation outline and compatibility

This is a renderer presentation change. No new dependency, host API, database migration, provider protocol change, or settings enum is needed for the proposed core behavior.

| Area | Proposed work |
| --- | --- |
| `lib/turn-process.ts` | Enable the process container in both modes; separate container availability from mode-specific defaults and visible-item counts; preserve response projection |
| `AssistantTurn.tsx` | Compose one process plus responses; retain stable identities and existing delegation status ownership |
| `ActivityGroup.tsx` | Restore ordinary group disclosure when there are multiple visible items; preserve singleton and topology treatments; keep presentation logic separate from delegation/runtime status |
| `shared.tsx` / disclosure hook | Preserve manual ownership, add precise ancestor claiming and any necessary pane-owned state; keep scroll anchoring under its current owner |
| `ToolRow.tsx`, `HostedSearchRow.tsx`, `ThinkingRow` | Reuse item rendering; connect precise reveal paths and retained item states without duplicating payload logic |
| Transcript pane/search integration | Scope state lifecycle and reveal identity; retain existing loading and live-status authority |
| `styles/messages.css`, i18n | Add scoped nested-container styles, meaningful localized headers and accessible names |

Do not add all new state and policy to the already-large transcript components. Extract only the directly required pure grouping/default-state logic or disclosure hook. Avoid a generic arbitrary-depth tree framework: the product needs the three levels defined here and the existing subagent panel.

Implementation sequence after design agreement:

1. Review the current source against the screenshot sequence and singleton, compact, error and delegation behavior requirements.
2. Implement deterministic container/default rules and stable disclosure identities; review pure logic and state transitions statically.
3. Wire both modes to the outer process and restore ordinary activity groups, preserving existing item details and user actions.
4. Statically review interaction paths, search, focus, scrolling and stream updates; complete the compilation and static checks listed in section 8.
5. Update the accepted turn-process ADR, directly affected UX specs, translations and release notes in the implementation change. Synchronize existing scenario documentation only where necessary to avoid contradicting the new behavior; this does not require adding or running runtime tests.

The current proposal does not overwrite accepted specs to make them claim that the feature already exists. The following documents need coordinated updates when implemented:

- `docs/adr/turn-process-and-thinking-display.md`: revise the “detailed does not wrap a process” decision and explain compatibility/default choices.
- `docs/spec/04-ux/08-component-spec.md`: hierarchy, defaults, state lifetime and headers.
- `docs/spec/04-ux/09-interaction-patterns.md`: nested disclosure, search reveal, focus and scroll rules.
- `docs/spec/04-ux/06-settings-ia.md`: update the descriptions of Detailed/Compact without adding settings.
- `docs/spec/06-delivery/04-e2e-test-plan.md`: if existing scenario descriptions contradict the new behavior, synchronize their text and record this task's static-only validation scope. This is documentation alignment, not a requirement to add or execute E2E tests.
- Corresponding documentation translations and user-facing release notes.

## 8. Acceptance and validation

Per the user's explicit instruction, acceptance for this task and its implementation is limited to static checks and compilation. The user path and edge cases below define intended product behavior for source/design review; they are not executable test requirements or a manual runtime test checklist. Do not add or run unit, mounted-component, integration, browser, Electron or E2E tests for this task, and do not start or attach to a desktop instance for validation.

### Representative user path

Given a detailed-mode turn containing progress paragraph A, two searches plus thinking, progress paragraph B, two commands plus thinking, and a final response:

1. Both progress paragraphs and the final response are readable with completed groups collapsed.
2. Open the search group: only that group's item headers appear.
3. Open one search result: only its details appear; its siblings remain closed.
4. Close and reopen the group: the selected search result retains its state.
5. Open the command group independently; copy its command without collapsing any level.
6. Close the whole process: all progress/groups disappear; the final response stays visible.
7. Reopen the process: both groups and item choices are restored.
8. The clicked header remains at its reading position throughout manual toggles.

### Edge cases for static design review

| Scenario | Expected result |
| --- | --- |
| Active group manually closed, then more tools/results arrive | Stays closed; count/status updates |
| Item manually opened, then group/turn completes | Ancestors stay open; item state retained |
| Untouched active group ends | May close according to defaults; never hides focused/selected content |
| Singleton becomes a multi-item group | No loss of manual state, duplicated payload, or hidden focused item |
| Completed history in detailed mode | Outer process open; ordinary groups closed; item defaults preserved inside |
| Parent closed while a child is open | Child state and reading position retained |
| Detailed → compact → detailed | Reasoning absent in compact; explicit choices restored for surviving nodes |
| Failure, denial, nonzero exit, cancellation or recovery | Accurate item/group status; no false whole-turn failure |
| Permission/question/proposal pending | Actionable surface remains reachable with process closed |
| Pure reasoning / pure answer / tools without answer | No redundant or empty compact containers; available details remain inspectable |
| Search targets progress vs tool output vs hosted search | Only required ancestors open; target is unambiguous and visible |
| Same search request rerenders after manual close | No repeated forced reopening |
| Retained pane switch / history row remount / pane eviction | Choices retained within pane lifetime; eviction resets deliberately |
| Delegations and later parent tools | Existing topology ownership preserved; no duplicate or misleading nesting |
| Narrow window, themes, keyboard, reduced motion | Controls usable; focus and status readable; no ancestor CSS leakage |
| Repeated streaming in a long transcript | Unchanged historical groups retain memoized boundaries; hidden payloads are not eagerly formatted |

### Static and compilation checks

After implementation, run the existing static/build commands applicable to the changed renderer surface:

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm docs:check
git diff --check
```

Review the diff for stable disclosure identities, state ownership, ancestor visibility, search-target wiring, i18n keys and scoped CSS selectors. Existing runtime-test sources may be read as evidence of prior behavior; this does not authorize running them or require expanding them.

For this document-only change, check local references, encoding, whitespace and document consistency; application compilation is deferred until implementation changes application code. Report only commands actually executed. Static checks and compilation do not prove runtime scrolling, focus, streaming or visual behavior, so do not report those paths as runtime-validated.

## 9. Alternatives and decisions to review

| Alternative | Assessment |
| --- | --- |
| Only expose ordinary activity-group headers | Fixes the red-box symptom, but leaves detailed mode without the requested whole-process collapse |
| Add only a whole-process wrapper | Lets users hide everything, but cannot retain progress narration while hiding one execution block |
| Collapse completed whole processes by default in detailed mode | Reduces height further, but hides progress narration and makes Detailed/Compact less distinct; not recommended for the initial change |
| Always add all three levels, even for one item | Creates redundant clicks and repeated labels; use singleton elision with retained item state |
| Persist every disclosure to the host | Adds storage and lifecycle complexity without a requirement; retain pane-lifetime state only |

Recommended review baseline: adopt all three independent levels, keep detailed process narration open by default, fold completed ordinary groups, and retain the current leaf-detail defaults. Do not add expand-all actions or new preferences until actual use demonstrates a need.

## 10. Inspected source and existing contracts

Paths are relative to this proposal. They describe the inspected baseline, not future guarantees.

- [Turn process projection and defaults](../../../apps/desktop/src/lib/turn-process.ts)
- [Assistant turn and activity grouping](../../../apps/desktop/src/lib/assistant-turns.ts)
- `apps/desktop/src/features/chat/transcript/AssistantTurn.tsx` — AssistantTurn composition
- `apps/desktop/src/features/chat/transcript/TurnProcess.tsx` — TurnProcess container
- `apps/desktop/src/features/chat/transcript/ActivityGroup.tsx` — ActivityGroup and embedded behavior
- `apps/desktop/src/features/chat/transcript/ToolRow.tsx` — ToolRow disclosure and command outcome
- `apps/desktop/src/features/chat/transcript/HostedSearchRow.tsx` — HostedSearchRow
- `apps/desktop/src/features/chat/transcript/shared.tsx` — Disclosure ownership and ThinkingRow
- [Transcript scroll owner](../../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll.ts)
- `scripts/e2e/turn-process.tsx` — Current turn-process interaction probe
- `scripts/e2e/transcript-disclosure-anchor.tsx` — Disclosure anchoring probe
- [Accepted turn-process ADR](../../adr/turn-process-and-thinking-display.md)
- [Transcript reading ownership ADR](../../adr/transcript-reading-ownership.md)
- [Component specification](../../spec/04-ux/08-component-spec.md)
- [Interaction specification](../../spec/04-ux/09-interaction-patterns.md)
