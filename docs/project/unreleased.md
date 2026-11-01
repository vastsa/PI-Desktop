# Unreleased changes

- Fixed the composer context ring staying at the pre-compaction figure after
  `/compact` or an automatic compaction until another turn ran (#2015). The
  ring now shows the compacted context's estimated size as soon as the
  checkpoint is installed, and after reopening the session.
- Refine autonomous Goal: one Goal budget row in Settings → AI with turn/token
  inputs (non-cap values normalize to Unlimited on blur/Enter), compact height,
  silent autosave and no helper/validation text, switches or advanced row. Inset
  the Goal header behind Composer while retaining the original rounded input edge;
  use compact nonzero d/h/m/s units, circle-ellipsis Details and one bottom Close in removal confirmation.
  TaskDock is hidden without deleting AI todos; deletion restores it. Saved edits update the header immediately and execution scope on the next Host round, without pausing;
  deletion preserves chat/tasks and safe late settlement. New completion reports
  require the current model's full-scope audit, not independent host proof.
  Existing permissions, finite budgets, historical approvals and restart pause remain.

- Decouple autonomous Goal execution from Composer mode. Accepted Goal submission
  returns to Agent; mode changes and immediate user guidance do not pause work.
  Resume succeeds after ordinary Agent tasks. Explicit new Goals replace unfinished
  ones safely, retaining old claim accounting and independent new budgets. Host
  turn snapshots preserve Plan restrictions across input preference changes.

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

## Goal live refinement candidate

- Separate autonomous execution rounds without synthetic user input; show natural
  elapsed units and ordinary running feedback instead of legacy Goal planning.
- Edit objectives without pausing, distinguish finish-round pause from immediate
  Composer Stop, and edit per-goal limits for the next round independently of defaults.
- Allow optional private Goal planning/self-review with no user approval stage,
  retaining normal permissions and ordinary Plan approval. Schema v31 preserves
  pending budget and finish-round pause intent. Local candidate awaits user review.
