# ADR 0322: Configurable Session Title Generation

- Status: Accepted
- Date: 2026-10-07
- Deciders: PI-Desktop core
- Related: ADR 0186 (amended), ADR 0121, D359, D650

## Context

ADR 0186 summarizes a first-turn session title with a main-owned one-shot that
always uses the session's model, reasoning off, a fixed built-in system prompt
that asks for "under 25 characters", and a hard 80-character cut. Users want to
pick a cheaper or faster title model, tune the prompt (for example the title
language or style), and change both lengths. Prompt enhancement (ADR 0121)
already has a Settings → AI card with an editor sheet and model/reasoning rows,
so title generation should follow the same shape instead of inventing a second
pattern.

## Decision

Add a **Session title generation** card to Settings → AI, below Prompt
enhancement, with five settings stored on `AppSettings`:

| Setting | Key(s) | Default | Bound |
| --- | --- | --- | --- |
| Custom prompt | `sessionTitleCustomPrompt`, `sessionTitlePrompt` | built-in prompt | ≤ 8000 code points |
| Model | `sessionTitleProviderId`, `sessionTitleModelId` | follow the session model | — |
| Reasoning | `sessionTitleThinkingLevel` | `off` | clamped to the model's ladder |
| Ideal length | `sessionTitleIdealLength` | 25 | integer 8–60 |
| Truncation length | `sessionTitleMaxLength` | 80 | integer 16–200 |

- **The whole system prompt is overridable.** This deliberately differs from
  ADR 0121, which keeps the enhancement system prompt built in. The title
  output contract is enforced in code: sanitization, code-point truncation,
  and the empty/failed-completion fallback always apply. The conversation is
  carried by the built-in user message (`User Prompt:` / `Assistant Response
  Summary:`), so a custom prompt cannot drop the user's input.
- **The default is the shipped prompt.** `SESSION_TITLE_DEFAULT_PROMPT` in
  `packages/shared/src/session-title.ts` is the ADR 0186 prompt with the
  hard-coded `25` replaced by `{{idealLength}}`; rendered with the default it is
  byte-identical to the previous constant. `{{idealLength}}` is optional in a
  custom prompt and substituted literally (`split`/`join`). When the prompt in
  force does not reference it, the ideal-length row says so.
- **Saving the default clears the override.** The editor opens on the value in
  force; saving text equal to the default, or blank text, stores `""` and turns
  `sessionTitleCustomPrompt` off, so later improvements to the default reach
  users who never customized it.
- **Settings are read in Electron main per request.** The
  `session/summarizeTitle` request shape is unchanged. Model resolution order is
  request model > settings pin > session model; a pin that cannot launch logs a
  warning and falls back to the session model. Reasoning defaults to `off` and
  is clamped to the launched model. The one-shot is bounded by a 60-second
  timeout shared with prompt enhancement (`withOneShotTimeout`); a timeout
  leaves the fallback title in place.
- **Lengths are validated independently** by host-core and the runtime; the
  ideal length is clamped to the truncation length at use rather than rejected
  as a cross-field error. The Settings rows bound each other so the UI never
  offers an ideal length above the truncation length.
- **Host-core validates before persisting.** `rpc/one_shot_settings.rs`
  validates both one-shot prompt families (prompt enhancement and session
  title) with one template validator, rejects out-of-range lengths with
  `INVALID_PARAMS`, and normalizes blank prompts. The seven keys are portable
  application settings for config sync; `sessionTitleProviderId` is a provider
  reference checked like the prompt-enhancement pin.
- **The 48-character first-prompt fallback is not configurable.** The
  auto-title guard recognizes the fallback title by exact string equality, so
  changing its length would make existing fallback titles look manual.

Shared building blocks are extracted rather than copied: `OneShotModelRows`
(model and reasoning rows), `OneShotPromptEditorSheet` (editor sheet),
`resolvePinnedOneShotLaunch` (pin with fallback), `withOneShotTimeout`, and the
Rust template validator. Prompt enhancement uses the same blocks with
unchanged behavior.

## Consequences

- Existing users see no change until they edit a setting: all defaults
  reproduce the ADR 0186 behavior, except that a title one-shot is now bounded
  by a 60-second timeout.
- A custom prompt can produce worse titles, but never longer than the
  truncation length, never multi-line, and never blocking the turn.
- No IPC request shape, host RPC, or storage schema version changes; the new
  keys ride the existing settings document.

## Alternatives considered

- Keep the system prompt built in and expose only a user template, as in
  ADR 0121: rejected because the title output contract is fully enforced in
  code, and the prompt itself is what users want to tune.
- Pass the settings from the renderer in the IPC request: rejected because
  main already owns settings and model resolution, and it would widen the IPC
  contract.
- Reject an ideal length above the truncation length in host-core: rejected
  because the two values are saved by separate controls and a cross-field
  rejection would make one of them unsavable mid-edit.
