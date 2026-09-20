# ADR 0281: Host speech capability

- Status: Accepted for implementation (amended by [ADR 0291](0291-remove-speech-settings-ui.md))
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0257](0257-plugin-real-time-capabilities.md) ·
  [03-runtime/20-speech](../spec/03-runtime/20-speech.md)

## Context

Chat models, image generation, transcription, and speech synthesis are different
jobs. `@earendil-works/pi-ai` has no TTS/ASR surface, and Whisper / MIMO TTS
must not appear in the chat model picker. Local OpenAI-Audio-compatible servers
(Speaches, whisper.cpp, LocalAI) should work through an existing
`openai_compatible` provider.

## Decision

1. The host owns a speech capability independent of chat:
   `transcribe(audio) → text` and `synthesize(text) → audio`.
2. Bindings live on optional `AppSettings.speech` (no schema bump). Each role
   names an existing provider, a model id, and an open protocol id.
3. Built-in protocols: `openai_audio` (REST `/audio/transcriptions` and
   `/audio/speech`) and `openai_chat_audio` (chat completions `audio` field;
   MIMO `mimo-v2.5-tts`). New vendors add an adapter, not a new IPC channel.
4. Plugins may register a protocol with `pi.speech.registerAdapter` under
   high-risk `speech.adapter.register`. Handles stay in the guest; HTTP plans
   are executed by the host with the bound provider's key and must stay on that
   origin. Built-in protocol ids are reserved.
5. v1 product entry is the host API only: the `speech/*` IPC and plugin
   adapters. No Settings card and no Composer transcription / draft-speech
   control exists (ADR 0291 withdrew both). Audio bytes never enter the renderer
   (path in, scratch out).
6. Out of scope: microphone / `pi.audio` device backend, Realtime, agent
   `transcribe`/`speak` tools, audio as LLM content blocks, changing pi-ai.

## Consequences

An unconfigured role fails `SPEECH_NOT_CONFIGURED`. Provider
deletion makes the binding fail `NOT_FOUND`. Plugin unload drops its protocols.
