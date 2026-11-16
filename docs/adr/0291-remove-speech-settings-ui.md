# ADR 0291: Remove the speech settings UI

- Status: Accepted
- Date: 2026-09-19
- Amends: [ADR 0281](0281-host-speech-capability.md) (its v1 product entry)
- Related: [04-ux/06-settings-ia.md](../spec/04-ux/06-settings-ia.md) · [03-runtime/20-speech.md](../spec/03-runtime/20-speech.md) · [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

ADR 0281 added the host speech capability and named its v1 product entry as a
**Voice** card in Settings → AI plus Composer transcription and draft speech. The
Composer controls were later removed (PR #555) while the host services stayed, so
the card became the only renderer consumer of `speech/getStatus`,
`speech/transcribe`, and `speech/synthesize`, and its locale keys and spec claims
outlived the controls they described. The product does not want a speech
configuration surface in Settings for a capability whose only customers are
plugins and direct IPC callers.

## Decision

1. Remove the Voice card: Settings → AI renders no speech surface, and the card
   component and its mount are deleted.
2. Remove the renderer leftovers: the AI destination stops indexing
   `settings.speechTitle`, `settings.speechTranscribe`, and
   `settings.speechSynthesize`, the speech styles leave the settings stylesheet,
   and the `settings.speech*` keys plus the unreferenced `chat.transcribe*` and
   `chat.speak*` keys leave every shipped catalog.
3. Keep the capability: ADR 0281 items 1–4 and 6 stay in force, so
   `speech/getStatus`, `speech/transcribe`, `speech/synthesize`,
   `validateSpeechSettings`, the built-in `openai_audio` and
   `openai_chat_audio` protocols, the `speech.adapter.register` permission, and
   the renderer API bridge are unchanged, and audio bytes still never enter the
   renderer.
4. Bindings stay caller-written: `AppSettings.speech` keeps its shape, validation,
   and persisted semantics, a binding is written through `settings/set`, and no
   migration runs and no stored binding is dropped.
5. Keep the Composer entry points withdrawn and correct their claims: ADR 0281
   item 5's Composer actions stay withdrawn, and the settings and component specs
   now state that speech is not a Settings surface.

## Consequences

- Users can no longer configure a transcription or speech provider in the app,
  although plugins, IPC callers, and already stored bindings keep working.
- The renderer drops its only speech consumer together with its styles, search
  keywords, and locale keys, with no host, protocol, permission, or schema change.
- Speech vocabulary no longer appears in the app shell, leaving the chat model
  picker as the only model surface.

## Alternatives

- Hide the card behind a developer flag: rejected, a hidden surface still owns
  styles, locale keys, and a provider picker.
- Remove the host capability with the UI: rejected, it would break plugin adapters
  and stored bindings for a change that only touches Settings.
