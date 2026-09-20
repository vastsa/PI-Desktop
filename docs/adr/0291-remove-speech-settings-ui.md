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

Two renderer surfaces were built for it. The Composer toolbar exposed mic
(transcribe) and read-aloud (speak) buttons over a `useComposerSpeech` hook, and
Settings → AI carried the **Voice** card. The Composer controls were removed on
2026-09-18 (`344ef4ec2`, PR #555) while the host services and the plugin-facing
speech API stayed. The card then became the only renderer surface: the only
consumer of `speech/getStatus`, `speech/transcribe`, and `speech/synthesize`, and
the only reader of the `settings.speech*` catalog. The copy written for the
removed controls — `chat.transcribe`, `chat.transcribing`,
`chat.transcribeFailed`, `chat.speak`, `chat.speaking`, `chat.speakFailed`,
`chat.speakSaved` — stayed in all eight catalogs with no caller, and the claims
in `04-ux/08-component-spec.md` §2.5 and ADR 0281 item 5 outlived the controls
they described.

The product does not want a speech configuration surface in Settings. It puts a
second provider picker per role, plus Whisper / TTS vocabulary, inside the app
shell for a capability whose only customers today are plugins and direct IPC
callers.

## Decision

1. **Remove the Voice card.** Settings → AI renders no speech surface.
   `apps/desktop/src/features/settings/voice-settings.tsx` and its
   `VoiceSettingsCard` mount in `features/settings/SettingsPage.tsx` are deleted.
2. **Remove the renderer leftovers.** The AI destination in
   `lib/settings-search.ts` no longer indexes `settings.speechTitle`,
   `settings.speechTranscribe`, or `settings.speechSynthesize`; the
   `.settings-row:has(.settings-speech-fields)`, `.settings-speech-fields`, and
   `.settings-speech-lead` rules leave `styles/settings.css`; the thirteen
   `settings.speech*` keys leave all eight shipped locale catalogs; and the seven
   unreferenced `chat.transcribe*` / `chat.speak*` keys written for the withdrawn
   Composer controls leave them too.
3. **Keep the capability.** ADR 0281 items 1–4 and 6 stay in force:
   `speech/getStatus`, `speech/transcribe`, `speech/synthesize`,
   `validateSpeechSettings`, the built-in `openai_audio` / `openai_chat_audio`
   protocols, the plugin `speech.adapter.register` permission, and the renderer
   API bridge in `lib/api.ts` are unchanged. Audio bytes still never enter the
   renderer.
4. **Bindings stay written by a caller.** `AppSettings.speech` keeps its shape,
   validation, and persisted semantics; a binding is written through the host
   settings API (`settings/set`), and its consumers are plugins and IPC calls.
   No migration runs and no stored binding is dropped.
5. **Keep the Composer entry points withdrawn and correct their claims.** ADR
   0281 item 5's Composer transcription and draft-speech actions stay withdrawn:
   the controls they describe were already removed in `344ef4ec2`, so their copy
   is retired and `04-ux/08-component-spec.md` §2.5 no longer describes them.
   `04-ux/06-settings-ia.md` states that speech is not a Settings surface.

## Consequences

- A user can no longer configure a transcription or speech provider from the
  app. The host capability remains reachable for plugins, for IPC callers, and
  for bindings already stored, but the desktop offers no UI to create one.
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
a high-risk plugin permission. Removing it would break plugin adapters and
invalidate stored `AppSettings.speech` bindings without a migration, for a
surface the request only asked to remove from Settings.

### Keep the card and ship the Composer actions

Rejected: the Composer controls were built and deliberately removed in the same
release cycle (`344ef4ec2`, PR #555). Re-shipping them is a product decision that
was already reversed, and the request is to remove the settings surface, not to
grow the feature. The stale claims are corrected instead, so no spec describes a
control that does not exist.
