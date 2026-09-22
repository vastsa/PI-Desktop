# ADR 0304: Canonical tool names with a decoupled display label

- Status: Accepted for implementation
- Date: 2026-09-22
- Deciders: PI-Desktop core
- Amends: ADR 0062 (the `Task` tool and its lifecycle tools are renamed, not
  redesigned); extends ADR 0048 (deferred-tool activation names), ADR 0087
  (the `edit` line-anchored contract), ADR 0089 (delegation lifecycle tools)
- Related: D618 (the canonical list and the normalization function), D619
  (host-core dispatch), D620 (agent-runtime registration), D621 (this decision),
  `docs/spec/03-runtime/23-tool-names.md`

## Context

PI-Desktop spelled a tool name the way it displayed it: `Read`, `Bash`,
`TaskWait`, `BrowserPreview`. That spelling reached the model as the tool schema
name, reached permission rules, reached subagent tool lists, and was written into
transcripts.

The pi runtime this desktop embeds never agreed. pi declares its own tools
lowercase (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) and branches on
those names in helpers such as `extractFileOpsFromMessage`, the skill activator,
compaction's file-operation collection, and the extension type guards. A name pi
does not recognize does not fail loudly — it quietly matches nothing. That is how
`details.readFiles`, `details.modifiedFiles`, and the summary's `<read-files>`
section stayed empty until issue #827 chased the trail while fixing the
compaction fallback.

Three things had to be true at once, and the first two pull against each other:

1. the name on the wire has to be the lowercase name pi knows;
2. the label in the transcript has to stay the capitalized one a reader already
   recognizes — a rename that re-letters every tool row in every historical
   session is a user-visible regression, not a refactor;
3. nothing already on disk, in user configuration, or in a third party's
   manifest may stop working.

The tempting shortcut — keep the capitalized name everywhere and translate only
at the pi boundary — was rejected: the capitalized name is what a model sees, and
a model that reads `Read` in the prompt while pi's own helpers look for `read`
keeps producing the silent miss the issue reported.

The other shortcut — rename and rewrite storage — was rejected too: transcripts,
audit rows, `deny` / `allow` rules, plugin manifests, and subagent documents are
user-owned bytes, and a migration that rewrites them has to be perfect or it
loses history.

## Decision

**Separate identity from label, and normalize only on the way in.**

1. **A tool name is a wire identity, and every identity is lowercase
   `snake_case`** (`read`, `bash`, `task_wait`) with multi-word names joined by
   `_`. The canonical list lives in exactly two places that must agree,
   `crates/host-core/src/tools/names.rs` and `packages/shared/src/tool-names.ts`,
   and `apps/desktop/test/tool-names-sync.test.mjs` fails when they drift.

2. **The display label is derived from the canonical name, never the reverse.**
   The desktop resolves every tool name it is handed through
   `canonicalToolName` (`apps/desktop/src/lib/tool-display.ts`) and builds the
   capitalized label from that. Because the label is a pure function of the
   canonical name, the rename changed no visible string: `read` renders as
   `Read`, `task_wait` as `Task Wait`, and the pre-rename `Read` / `TaskWait`
   spellings render exactly the same. No wire field, permission rule, or tool
   schema carries the label.

3. **Normalization happens at the read boundary and never in storage.** A name
   may arrive spelled the old way from a transcript, a saved rule, a subagent
   whitelist, or an imported archive; it is translated where it is read. A
   canonical name returns unchanged (the call is idempotent), a known legacy name
   resolves in any letter case, and anything else — `plugin_*`, `mcp_*`, an
   MCP-reported name, a shell id such as `PowerShell` — returns untouched. An
   unknown name is not an error, and a write path always writes the canonical
   name.

4. **A third-party identity is never rewritten.** `plugin_*` and `mcp_*` tools
   keep the name their contributor or server chose, in storage and in the UI. The
   permission prompt is the one surface where that matters most: it shows our own
   tools under their capitalized label (`getToolPromptName`) and leaves a
   third-party name exactly as reported, because a prompt the user is asked to
   approve must not hide which tool is asking.

5. **The host's own plugin-development tools are not prefixed `plugin_`.**
   `plugin_` is the reserved marker for a tool a third-party plugin contributes
   and host-core branches on it, so the host's authoring tools are named
   verb-first: `check_plugin`, `scaffold_plugin`, `pack_plugin`.

6. **Every equality check normalizes first.** A comparison that read a tool name
   as a string is a defect after the rename even when the UI still looks right:
   the review change tools (`write` / `edit`), the generated-image row
   (`generate_images`), the context-inspector grouping key, the desktop RPC
   timeout budgets (`bash`, `generate_images`), the subagent tool whitelists and
   presets, and the local tools Electron main registers (`skill`,
   `browser_preview`, `generate_images`, `check_plugin`, `scaffold_plugin`,
   `pack_plugin`).

The contract itself — the 27 canonical names, the legacy-to-canonical table, and
the "where a name must be normalized" list — is specified in
`docs/spec/03-runtime/23-tool-names.md` and is not restated here.

## Consequences

- The model sees the names pi's own helpers look for, so the silent-miss class of
  bug (the one #827 found) closes at the source rather than being special-cased
  per helper.
- **No user-visible label changes and no user data is migrated.** Historical
  transcripts, saved permission rules, subagent documents, and plugin manifests
  keep their bytes and keep working; the compatibility path is proven by
  dedicated legacy-name cases in `packages/shared`,
  `apps/desktop/test/tool-name-compat.test.mjs`, and `scripts/e2e-subagents.mjs`.
- Storage keeps the spelling it was written with, so the same tool can appear
  under two spellings on disk. Every read boundary therefore has to normalize —
  a new read path that forgets to is a bug that shows up as "two rows for one
  tool", which is why the normalization boundary is enumerated in the contract
  page instead of being left to each call site.
- Two implementations of the same function (`names.rs`, `tool-names.ts`) now
  exist in production code. They are pinned against each other by the sync test,
  and case comparison is deliberately ASCII-only so a non-ASCII name cannot make
  them disagree.
- Renaming the wire name is an API break for anything outside this repository
  that hardcodes a tool name — a plugin manifest is fine (it names its own
  tools), but an external automation driving `tools.execute` with `"Bash"` only
  keeps working if it goes through a read boundary that normalizes. host-core
  dispatch (D619) is the boundary that covers it.
- `tool_search`, `check_plugin`, `scaffold_plugin`, `pack_plugin`, and the four
  `scheduled_task_*` names are added to the canonical list rather than being left
  as-is; `Review` was dropped from it because it turned out to be a skill display
  name in test fixtures, not a tool.
