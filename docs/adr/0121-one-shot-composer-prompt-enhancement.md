# ADR 0121: Keep Composer prompt enhancement one-shot and main-owned

- Status: Accepted
- Date: 2026-08-24
- Updated: 2026-09-20 (one Prompt enhancement card on Settings → AI)
- Related: Issue #14, Issue #562

## Context

The Composer needs a convenient way to improve a draft without sending a
message, changing the conversation transcript, or exposing provider
credentials to the renderer. The feature also needs to honor the model shown
in the Composer while remaining safe when that selection changes during an
in-flight request.

The first version shipped one fixed system prompt plus a `Draft:\n<draft>`
user message. Users found the rewrite weak, asked for the prompt itself to be
adjustable, and asked to run the rewrite on a cheaper or stronger model than the
conversation's.

## Decision

Prompt enhancement is an allowlisted renderer-to-Electron IPC operation. The
renderer sends the draft and a provider/model/thinking snapshot. Electron main
validates the draft, resolves the effective provider and credentials through
the existing runtime launch resolver, and calls agent-runtime directly for a
single completion. The completion has no session history, tools, attachments,
durable turn, or transcript side effect.

The completion context is a built-in system prompt plus one user message built
from a user template whose `{{draft}}` placeholder receives the draft. The user
template is overridable through `AppSettings.promptEnhancementUserTemplate`, and
its default lives in `packages/shared/src/prompt-enhancement.ts` so the runtime,
the settings UI, and the restore-default action read one copy.
`AppSettings.promptEnhancementCustomTemplate` gates whether the stored template
applies. The switch is enabled only when a usable template exists, so it cannot
choose between two identical states, and saving a template turns it on. Turning
it off keeps the text so turning it back on restores it, and a blank or unusable
template resolves to the default. host-core validates the override before it persists:
it must be a string within `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH` and carry the
draft variable, and a stored system-prompt override is dropped. The renderer
substitutes every occurrence of the placeholder and strips one matching pair of
wrapping quotation marks from the model's answer.

The system prompt is deliberately not overridable, and it is edited only in
source. It carries the rewrite contract the feature is verified against —
proper-noun preservation, language following without meta notes, the length
brake, and the output contract — so a user-editable copy would let a stored
value silently drop a rule the E2E scenario asserts.

The enhancement carries its own reasoning level through
`AppSettings.promptEnhancementThinkingLevel`, defaulting to `off`, and never
inherits the conversation's effort: a rewrite rarely benefits from reasoning and
reasoning is the slow path. The row lists only the levels the selected model
supports and still shows `Off (no reasoning)` when that set is empty, resolving
them exactly as a turn does (binding, then catalog, then provider default). The
chosen level is clamped by that ladder, and switching model re-clamps the stored
value. One request is bounded by a 60-second ceiling: expiry aborts the
in-flight call (best-effort) and races the promise so the renderer is released,
then fails with `TIMEOUT` rather than retrying on the session model.

The enhancement model and its reasoning level are configured on the same
Settings → AI Prompt enhancement card as the template, as rows below the
custom-template switch. The enhancement
model follows the Composer's current model unless
`promptEnhancementProviderId` / `promptEnhancementModelId` pin another. A pin
whose provider is disabled, whose account is signed out, or whose binding no
longer exists is a preference that cannot be honoured rather than a failure:
main falls back to the Composer model and logs a warning.

The renderer owns the interaction state: loading, one-level undo, dismissible
classified errors, and an edit-generation guard that discards late results.
The main process remains the only owner of API keys and vendor OAuth
resolution. Provider failures reuse the existing classification and bounded
setup retry behavior; whitespace-only output is a dedicated terminal error.

## Consequences

- Draft improvement is fast and reversible without creating hidden messages or
  agent runs.
- The provider/model snapshot makes the request deterministic relative to the
  visible selector, while main-side fallback keeps stale or incomplete
  snapshots safe.
- The renderer receives only text and classified error data, never secrets.
- The overridable user template lets a user tune the request without a new IPC
  surface. The cost is that a user template can drop the `<draft>` framing,
  which is why a missing draft variable falls back to the default rather than
  sending a prompt without the user's draft. Keeping the system prompt built in
  bounds that cost: the rewrite rules cannot be edited away.
- Sharing the defaults from `packages/shared` adds a cross-boundary read. It is
  the only arrangement in which the text the settings page shows is the text
  the model receives, and the text "restore default" restores.
- The feature has a new typed IPC contract and must keep its UX and E2E
  scenarios synchronized with the runtime behavior.

## Alternatives considered

- Reuse `agent/prompt`: rejected because it persists a user turn, uses the
  conversation context, and starts normal agent lifecycle behavior.
- Run the provider call in the renderer: rejected because credentials and
  vendor OAuth bindings are main-owned security material.
- Store enhancement history: rejected for v1; one exact undo snapshot is
  sufficient and avoids adding persistence ownership.
- Keep the template in `agent-runtime` and expose the default to the settings
  UI over a new IPC method: rejected because it adds a protocol surface purely
  to display a constant, and lets the displayed default drift from the one in
  force.
- Let the user override the system prompt as well: rejected because that text is
  part of the feature contract. A stored override could remove the proper-noun
  rule or the no-meta-note rule while the spec and E2E scenario still assert
  them, turning a supported configuration into a silent contract violation.
- Store the built-in default text as the user's value when they never edited it:
  rejected because a later product improvement to the defaults would then never
  reach those users; an empty override keeps them on the current default.
- Require the pinned enhancement model to resolve, failing otherwise: rejected
  because a stale pin would disable the action outright, long after the user
  forgot the choice; falling back with a warning keeps the action usable.
