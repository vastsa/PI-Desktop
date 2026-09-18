# ADR 0121: Keep Composer prompt enhancement one-shot and main-owned

- Status: Accepted
- Date: 2026-08-24
- Updated: 2026-09-18 (user-overridable templates; enhancement model pin)
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

The completion context is a system prompt plus one user message built from a
user template whose `{{draft}}` placeholder receives the draft. Both templates
are user-overridable through `AppSettings` (`promptEnhancementSystemPrompt`,
`promptEnhancementUserTemplate`); their defaults live in
`packages/shared/src/prompt-enhancement.ts` so the runtime, the settings UI, and
the restore-default action read one copy. A blank override means "use the
default", so restoring the default and never having customized are the same
stored state. host-core validates an override before it persists: it must be a
string within `PROMPT_ENHANCEMENT_TEMPLATE_MAX_LENGTH`, and a user template must
carry the draft variable. The renderer substitutes every occurrence of the
placeholder and strips one matching pair of wrapping quotation marks from the
model's answer.

The enhancement model follows the Composer's current model unless
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
- Overridable templates let a user tune the rewrite without a new IPC surface.
  The cost is that a user template can drop the `<draft>` framing, which is why
  a missing draft variable falls back to the default rather than sending a
  prompt without the user's draft.
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
- Keep the templates in `agent-runtime` and expose the defaults to the settings
  UI over a new IPC method: rejected because it adds a protocol surface purely
  to display a constant, and lets the displayed default drift from the one in
  force.
- Store the built-in default text as the user's value when they never edited it:
  rejected because a later product improvement to the defaults would then never
  reach those users; an empty override keeps them on the current default.
- Require the pinned enhancement model to resolve, failing otherwise: rejected
  because a stale pin would disable the action outright, long after the user
  forgot the choice; falling back with a warning keeps the action usable.
