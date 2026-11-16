# ADR 0291: Remove the speech settings UI

- Status: Accepted
- Date: 2026-09-19
- Deciders: PI-Desktop core
- Amends: [ADR 0281](0281-host-speech-capability.md) (its v1 product entry)
- Related: [04-ux/06-settings-ia.md](../spec/04-ux/06-settings-ia.md) ·
  [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [03-runtime/20-speech.md](../spec/03-runtime/20-speech.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

ADR 0281 added the host speech capability: `transcribe` / `synthesize` over an
optional `AppSettings.speech`, two built-in protocols, a high-risk
`speech.adapter.register` plugin adapter, and no audio bytes in the renderer.
Its item 5 named the v1 product entry as a **Voice** card in Settings → AI plus
Composer transcription and draft speech.

## Decision

1. **Remove the Voice card.** Settings → AI renders no speech surface.
2. **Remove the renderer leftovers.** The AI destination in
   `lib/settings-search.ts` no longer indexes `settings.speechTitle`,
   `settings.speechTranscribe`, or `settings.speechSynthesize`; the
   `.settings-row:has(.settings-speech-fields)`, `.settings-speech-fields`, and
   `.settings-speech-lead` rules leave `styles/settings.css`; the thirteen
   `settings.speech*` keys leave all eight shipped locale catalogs; and the
   seven unreferenced `chat.transcribe*` / `chat.speak*` keys written for the
   withdrawn Composer controls leave them too.
3. **Keep the capability.** ADR 0281 items 1–4 and 6 stay in force:
   `speech/getStatus`, `speech/transcribe`, `speech/synthesize`,
   `validateSpeechSettings`, the built-in `openai_audio` / `openai_chat_audio`
   protocols, the plugin `speech.adapter.register` permission, and the renderer
   API bridge in `lib/api.ts` are unchanged.
4. **Bindings stay written by a caller.** `AppSettings.speech` keeps its shape,
   validation, and persisted semantics; a binding is written through the host
   settings API (`settings/set`), and its consumers are plugins and IPC calls.
5. **Keep the Composer entry points withdrawn and correct their claims.** ADR
   0281 item 5's Composer transcription and draft-speech actions stay withdrawn:
   the controls they describe were already removed in `344ef4ec2`, so their copy
   is retired and `04-ux/08-component-spec.md` §2.5 no longer describes them.

## Consequences

- A user can no longer configure a transcription or speech provider from the
  app.
- Removing the renderer's only speech consumer also removes its use of the
  protocol catalog: `speech/getStatus` is now called by no renderer module,
  while the IPC channel and its contract stay.
- The renderer sheds the card, its styles, its search keywords, and its locale
  keys in eight catalogs; no host, protocol, permission, or schema change
  accompanies it.
- The user-visible speech vocabulary (Whisper, TTS, voices) no longer appears in
  the app shell at all, so the chat model picker is the only model surface.

## Alternatives considered

### Keep the card and hide it behind a developer flag

Rejected: a hidden surface still owns styles, locale keys, and a provider
protocol catalog, and it would keep a second provider picker alive in an app
whose speech consumers are plugins.

### Remove the host capability with the UI

Rejected: the capability is a shipped contract with an ADR, an IPC surface, and
a high-risk plugin permission.

### Keep the card and ship the Composer actions

Rejected: the Composer controls were built and deliberately removed in the same
release cycle (`344ef4ec2`, PR #555).
