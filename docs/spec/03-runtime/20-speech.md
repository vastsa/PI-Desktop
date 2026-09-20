# 20. Host speech

> Source of truth: `packages/shared/src/types/speech.ts`,
> `packages/agent-runtime/src/speech/`,
> `apps/desktop/electron/main/services/speech-service.ts`.
> ADR: [0281-host-speech-capability](../../adr/0281-host-speech-capability.md).

## 1. Capability

Independent of chat streams and the model picker:

```
transcribe({ sessionId, path, mimeType?, language? }) → { text }
synthesize({ sessionId, text, voice?, format? }) → { path, mimeType, dataUrl? }
```

Input is a session-scratch file path. Output audio is written to that session's
scratch. The renderer never receives a provider secret. TTS `dataUrl` is omitted
when the file is larger than 8 MiB. Input is capped at 25 MiB
(`SPEECH_INPUT_TOO_LARGE`).

## 2. Bindings

`AppSettings.speech` is optional and does not bump the storage schema:

```
{
  transcribe?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
  synthesize?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
}
```

Protocol ids match `^[a-z][a-z0-9._-]{0,63}$`. Absent/empty speech is a valid
unconfigured state. No app surface reads it: callers are plugins and IPC
consumers (ADR 0291).

## 3. Built-in protocols

| id | transcribe | synthesize |
|---|---|---|
| `openai_audio` | `POST {baseUrl}/audio/transcriptions` multipart | `POST {baseUrl}/audio/speech` JSON |
| `openai_chat_audio` | unsupported | `POST {baseUrl}/chat/completions` with `audio:{format,voice}`; read `choices.0.message.audio.data` |

Local OpenAI-Audio-compatible servers use an `openai_compatible` provider and
`openai_audio`. Suggested models: OpenAI `whisper-1` / `tts-1`, Groq
`whisper-large-v3`, Xiaomi `mimo-v2.5-tts`.

## 4. IPC

```
pi-desktop/speech/getStatus → SpeechStatus (no secrets)
pi-desktop/speech/transcribe
pi-desktop/speech/synthesize
```

Errors: `SPEECH_NOT_CONFIGURED`, `SPEECH_PROTOCOL_UNSUPPORTED`,
`SPEECH_INPUT_TOO_LARGE`. Network/auth reuse `NETWORK_ERROR` /
`PROVIDER_UNAUTHORIZED`. A missing or disabled provider returns `NOT_FOUND`.

## 5. Plugin adapters

`pi.speech.registerAdapter({ protocol, label, roles, handle })` requires
`speech.adapter.register` (high risk). The handle stays in the plugin process.
The host stores metadata only and calls `speech.handle`. A handle may return
`{ kind: "text" }`, `{ kind: "audio", mimeType, data }`, or
`{ kind: "http", call }` for the host to execute with the bound key. HTTP URLs
must stay on the provider origin. Built-in protocol ids are reserved. Unload
unregisters.

## 6. Product

Settings exposes **no** speech surface (ADR 0291). A binding is written by a
caller through the host settings API; plugins and the `speech/*` IPC are its
only consumers, and the renderer has no transcription or speech control.
Whisper / TTS models must not appear in the chat model picker.

v1 does not implement microphone capture, Realtime, or agent tools.
