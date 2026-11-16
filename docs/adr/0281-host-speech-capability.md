# ADR 0281: Host speech capability

- Status: Accepted for implementation (amended by [ADR 0291](0291-remove-speech-settings-ui.md))
- Date: 2026-09-17
- Related: [ADR 0257](0257-plugin-real-time-capabilities.md) ·
  [03-runtime/20-speech](../spec/03-runtime/20-speech.md)

## Context

Chat, image generation, transcription, and speech synthesis are different jobs, yet
`@earendil-works/pi-ai` has no TTS/ASR surface and Whisper or MIMO TTS must not appear
in the chat model picker.

## Decision

1. The host owns a speech capability independent of chat: `transcribe(audio) → text`
   and `synthesize(text) → audio`.
2. Bindings live on optional `AppSettings.speech` with no schema bump, each role
   naming a provider, a model id, and an open protocol id.
3. Built-in protocols are `openai_audio` (`/audio/transcriptions`, `/audio/speech`)
   and `openai_chat_audio`, which uses the chat completions `audio` field for MIMO
   `mimo-v2.5-tts`; a new vendor adds an adapter, not an IPC channel.
4. Plugins may register a protocol with `pi.speech.registerAdapter` under
   `speech.adapter.register`, while the host executes the HTTP plan and built-in ids
   stay reserved.
5. The v1 entry is the host API only — `speech/*` IPC and plugin adapters — with no
   Settings card or Composer control, since ADR 0291 withdrew both.

## Consequences

- An unconfigured role fails `SPEECH_NOT_CONFIGURED`, and deleting the bound provider
  makes the binding fail `NOT_FOUND`.
- Unloading a plugin drops its protocols.
- Audio bytes never enter the renderer.
