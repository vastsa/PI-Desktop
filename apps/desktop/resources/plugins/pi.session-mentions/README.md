# Session Mentions (`pi.session-mentions`)

A bundled first-party plugin, on by default (Extensions lists it as bundled;
it can be disabled, not uninstalled). Type `@` in the composer to reference
another local session. It owns the `@` trigger (`composerTrigger`) with
`placement: "first"`: its group leads the list, its first session is
highlighted (Enter picks it), and the host's file rows follow. A pick puts a
chip labelled with the session title in the draft; on send the chip becomes a
`<referenced-chat>` block with that session's first and most recent complete
Q&A, in a fence tagged `pi.session-mentions:chat`, drawn in the transcript as
a one-line card.

Plain ES modules, no build step: `main.js` + `service.js` (headless),
`renderer.js` + `card.js` (renderer), `lib/` (pure logic from PR #447).
Tests: `apps/desktop/test/plugin-session-mentions*.test.mjs`.

## What a reference contains

- The session's **first complete Q&A turn**, always, then its **most recent**
  turns, at most **max turns** in all (the first counts: 3 is the first + the
  2 most recent), in chronological order. A turn is a parent question and
  every eligible parent answer row after it.
- Recent turns are taken newest-first, whole, within the reference budget. A
  marker stands for the turns left out: `[… 7 turns omitted here]`, or `…
  were not read` when the reader did not reach them.
- The reader pages back from the newest rows (400 at a time, at most 4 pages)
  until it has 21 turns; a longer session's first turn comes from one read of
  its first 48 rows, used only once a later question closes it.
- A first turn past the 32 KB mark limit is clipped, and the block says so.
- Thinking, tools, delegated rows, streaming/error/aborted answers and
  attachment contents are never included; referenced chats inside the session
  (fenced, bare, #447 envelopes) become a one-line placeholder.
- The block says it is reference material, not an instruction or tool
  authorization; its tag carries `turns`, `first-turn`, `omitted`, `unread`.

## Settings › AI › Session references

The plugin has no settings of its own. The host's **Session references**
group (会话引用) sends both choices with each query as
`sessionReferences: { budgetPercent, maxTurns }`:

- **Reference budget**: 10%, **25%** (default), 50% or 100% of the remaining context.
- **Max turns per reference**: 3, 5, **10** (default) or 20.

Without the field (an older host, or a value outside the choices): 25% and
10. A budget saved under the former plugin setting is ignored. One reference
may use `min(32 KB, pct × (contextWindow − usedTokens − 8192) × 3 bytes)`,
from the query's `context` (the composer's context ring), rounded down to
512 bytes; with no usage reported yet the budget is 32 KB.

When not even the first turn fits the context share, the row shows
`⚠ <title>` with the hint "上下文剩余不足：先 /compact 压缩，或在 设置 › AI 里调高引用预算"
/ "Not enough context left: run /compact, or raise the reference budget in
Settings › AI" (at 100%: "上下文快满了，先 /compact 压缩再引用"); picking it
sends only a one-line note. The plugin never compacts.

## The list and the card

At most 8 sessions, newest first, filtered by title and id. Only local
desktop sessions; the session being typed in and sessions without a complete
turn are left out. The label is the session title, an untitled session named
as the app names it (新建任务 / New task); equal titles get the short update
time (`New task · 10-09 21:17`), then an id prefix. The second line reads
`<update time> · “<first question>” · <coverage>`.

Row texts follow the app's UI language, the query's `locale` (else
`pi.app.getLocale()`): Chinese for `zh*`, English otherwise. A snapshot
cached in another language is built again.

The card shows the title and, e.g., `first + 9 recent turns · 4 between
omitted · ~12.3 KB`; a click opens the full block. The message is unchanged:
the model reads the same text, and Copy and edit use the full message.

## How it works

- `renderer.js` asks the headless entry (`plugin.call` `sessions.items`, then
  `sessions.snapshots` for pending rows) for the list with its snapshots,
  passing the query's `context`, `sessionReferences` and `locale`, and caches
  snapshots by `id@updatedAt#bytes/maxTurns`; only ready rows are listed.
- `service.js` reads only `session/list` and `session/get`
  (`pi.desktop.invoke`, `desktop.control`) and keeps answers under the host's
  64 KB `plugin.call` limit and 2 s budget.

## Boundaries

- The referenced Q&A is part of the sent message (#447 rewrote only the
  model's copy in a Before Send hook main lacks); the snapshot is taken when
  the list is shown. Clicking a chip does not open the session.
- `desktop.control` is broader than needed; a read-only cross-session API
  would let the plugin drop it.
