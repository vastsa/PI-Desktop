# ADR 0301: Per-model context pressure settings and a silent idle compaction pass

- Status: Accepted for implementation
- Date: 2026-09-21
- Deciders: PI-Desktop core
- Amends: ADR 0064 (adds a configurable pressure point and an off-critical-path
  pass); extends ADR 0030 (the hard boundary itself is unchanged)
- Related: ADR 0049 (retained-tail recovery), ADR 0136 (active task boundary),
  ADR 0282 (summary retry and sizing), ADR 0299 (delegate context budget),
  ADR 0300 (reversible boundary with recall)

## Context

Every threshold that decides *when* context protection acts was a constant.
The hard limit derives from the model window (`contextBudget`,
`packages/agent-runtime/src/runtime.ts`), tool results are bounded by per-tool
limits (spec 16), and compaction runs inline at the boundary or when the model
calls `new_context` (ADR 0064).

That is the right default and it is not right for every model. A 1M-token window
and a 128k window reach pressure at very different points of *work remaining*,
and a session that is already going to compact pays for it either way. The only
decision left to the user was whether to keep working until the hard boundary,
where the summary request lands on the critical path, or to spend it while idle.

Two more facts were unaddressed:

- Tool results were bounded per result but never as a set, so a long session
  carried whole old tool outputs whose content the task had already moved past.
- A summary request that never returns leaves the next window with nothing that
  describes where the work stood.

## Decision

1. **Three settings live on the model binding.** `ModelBinding` gains optional
   `dynamicContext {enabled, thresholdPercent}` (`packages/shared/src/types/models.ts:137`),
   `earlyCompaction {enabled, thresholdPercent, delaySeconds, silent}` (`:184`) and
   `sleepTime {enabled, maxRunsPerHour}` (`:239`). Absent means the shipped
   defaults, so every binding written before this change keeps its behavior.

2. **Defaults are window-aware where the window is known.** The narrowing gate
   defaults to `100% − max(100k, 15% × window) / window`, clamped to 40–95
   (`defaultDynamicContextPercent`, `:156`); a flat 60 is used only when no
   window is known (`DYNAMIC_CONTEXT_DEFAULT_PERCENT`, `:148`). Early compaction
   defaults to 75 % of the hard limit after 120 s of idleness, silent
   (`EARLY_COMPACTION_DEFAULT_*`, `:196`–`:202`), and the sleep digest is off by
   default with a quota of 2 runs per hour (`SLEEP_TIME_DEFAULT_RUNS_PER_HOUR`,
   `:247`). Both the settings controls and the runtime clamp against the same
   exported bounds.

3. **One gate decides the pressure point.** `dynamicContextGate()`
   (`packages/agent-runtime/src/runtime.ts:5903`) is the single source of the
   threshold. The outgoing request (`:2047`), the hard-boundary check and the
   idle pass all read it, so what narrowing saves is visible to compaction
   instead of compaction firing while real room remained. With the gate off,
   nothing is narrowed.

4. **Tool-result tiering sits behind that gate.** Old tool results are shortened
   to a head plus a recovery pointer only once the outgoing view is under
   pressure (`narrowToolResults`, `packages/agent-runtime/src/tool-result-tier.ts`).
   Results for files the session re-opened stay whole
   (`workingSetPathsFrom`, `:340`), so the newest file-touching calls define the
   working set. The full text of every narrowed result remains reachable through
   the pointer the pass embeds, and per-tool limits (spec 16) are unchanged.

5. **The idle pass runs off the critical path and yields to the user.**
   `scheduleIdleCompaction` (`runtime.ts:5936`) arms when a run settles; the
   timer fires only after `delaySeconds` without new activity, and any new prompt
   sets the stand-down flag. The pass re-checks the same narrowed view before it
   spends a summary request (`runIdleCompaction`, `:5959`), so narrowing
   postpones it rather than hiding it.

6. **Silence covers one channel.** A *successful* idle pass emits
   `compaction_end` with `idle` and `silent` (`runtime.ts:6369`); the renderer
   skips the routine toast. The transcript row, the context inspector, the
   checkpoint record and the recall surface are unaffected. A degraded or failed
   pass and the inline hard-boundary path always warn; `silent: false` restores
   the toast.

7. **The digest is taken before the attempt, not after it.** The idle arm writes
   a deterministic digest of the session's state through
   `session.appendSleep` (`runtime.ts:6018`, `takeSleepDigest` `:5956`): a
   `sleep` transcript line built by the same model-free pass the degradation
   ladder uses (ADR 0300 clause 8). It costs no provider request and exists even
   when the summary request never returns.

8. **The settings reach the runtime the way other model settings do.** They are
   persisted with the binding, carried on the launch payload
   (`apps/desktop/electron/main/runtime/session-launch.ts:635`–`:638`) and
   editable in Settings → Models → Advanced, where each binding row gains the
   three controls and their read-outs.

9. **The hard boundary stays fixed.** It is the safety net on the critical path
   and is not configurable (ADR 0030). These settings move the point at which
   *optional* work happens, never the point at which a request is refused.

## Consequences

- A long session can shed old tool output before the boundary instead of
  compacting at it, so the expensive pass happens while the user is not waiting.
- The number the user sees and the number the runtime compares must be the same
  one. Both now come from the shared bounds; a settings read-out that disagrees
  with the gate is a bug, not a display choice.
- Narrowing is lossy for the model but reversible for the user: the pointer keeps
  the full text one call away (ADR 0300).
- A silent successful pass removes a toast some users used as a cue. The row,
  the inspector and the record still show the checkpoint, and the failed paths
  still warn.
- The window-aware default means two models in the same session cross the gate
  at different absolute token counts. That is the intent, and it is why the
  read-out prints the share rather than only the percentage.
- The digest spends bounded transcript space; the hourly quota bounds it.

## Not decided here / out of scope

- **Recalibrating the estimate.** The gate compares an estimate against the hard
  limit; making that estimate track measured request sizes is a separate change
  with its own safety review.
- **Per-session overrides.** These settings are per model binding; there is no
  session-level override.
- **Automatic tuning.** No adaptive threshold; the defaults are derived from the
  window and stay put unless the user moves them.
- **Semantic narrowing.** Tiering is deterministic text surgery, not a model
  call.
- **Subagents.** Delegates derive their own budget from their own model and do
  not carry these settings (ADR 0299).

## References

- `docs/adr/0064-codex-parity-context-compaction.md`
- `docs/adr/0030-*`, `docs/adr/0136-*`, `docs/adr/0282-*`, `docs/adr/0299-*`,
  `docs/adr/0300-reversible-compaction-boundary-with-recall.md`
- `docs/spec/03-runtime/02-agent-runtime.md` §5.1
- `docs/spec/03-runtime/16-tool-result-limits.md` §6a
- `docs/spec/04-ux/06-settings-ia.md` §2 Model configuration
- `docs/spec/06-delivery/04-e2e-test-plan.md` — E2E-CONTEXT-idle-compaction-is-silent-and-yields,
  E2E-CONTEXT-tool-results-tier-under-pressure, E2E-SETTINGS-per-model-context-thresholds
