# ADR 0281: Host speech capability

- Status: Accepted for implementation (amended by [ADR 0291](0291-remove-speech-settings-ui.md))
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0257](0257-plugin-real-time-capabilities.md) ·
  [03-runtime/20-speech](../spec/03-runtime/20-speech.md)

## Context

Chat models, image generation, transcription, and speech synthesis are different
jobs. `@earendil-works/pi-ai` has no TTS/ASR surface, and Whisper / MIMO TTS
must not appear in the chat model picker.

## Decision

1. The host owns a speech capability independent of chat: `transcribe(audio) →
   text` and `synthesize(text) → audio`.
2. Bindings live on optional `AppSettings.speech` (no schema bump).
3. Built-in protocols: `openai_audio` (REST `/audio/transcriptions` and
   `/audio/speech`) and `openai_chat_audio` (chat completions `audio` field;
   MIMO `mimo-v2.5-tts`).
4. Plugins may register a protocol with `pi.speech.registerAdapter` under
   high-risk `speech.adapter.register`.
5. v1 product entry is the host API only: the `speech/*` IPC and plugin
   adapters.
6. Out of scope: microphone / `pi.audio` device backend, Realtime, agent
   `transcribe`/`speak` tools, audio as LLM content blocks, changing pi-ai.

## Consequences

An unconfigured role fails `SPEECH_NOT_CONFIGURED`.
