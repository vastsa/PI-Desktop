# Local Voice Input

## Scope

Local voice input is an optional, offline transcription path for the Composer.
It is separate from the host `speech/*` capability documented in
[`20-speech.md`](20-speech.md): host speech remains an IPC/plugin capability,
while this feature owns microphone capture, local model management, and draft
insertion for the desktop application.

The feature is disabled by default. It does not require a provider account,
API key, or network request after the selected model has been downloaded.

## Ownership and topology

```text
Composer / Settings
        ↓ preload bridge
Renderer voice IPC wrapper
        ↓ validated Electron IPC
Electron main VoiceService
        ├─ PvRecorderBackend (microphone)
        ├─ VoiceController (lifecycle and cancellation)
        └─ ModelManager → transcribe-cpp (local inference)
```

Raw audio and the transcription engine stay in the main process. The renderer
receives bounded state, progress, and final text through the preload bridge.

## Persisted settings

`AppSettings.voice` has the following shape:

| Field | Meaning |
|---|---|
| `enabled` | Enables the Composer microphone control; default `false` |
| `deviceId` | Selected input device, or `null` for the system default |
| `languages` | Ordered language codes used for transcription; default `zh`, `en` |
| `chineseVariant` | `simplified`, `traditional-taiwan`, or `traditional-hong-kong` |
| `modelId` | ID from the immutable local model catalog |

The main-process IPC boundary accepts only the known fields, validates scalar
types and bounded lengths, and rejects malformed model IDs and settings.

## IPC contract

The preload bridge exposes these invoke operations:

| Operation | Purpose |
|---|---|
| `voiceStart` | Prepare the selected model and begin capture |
| `voiceStop` | Stop capture and transcribe the captured PCM |
| `voiceCancel` | Cancel capture, preparation, or transcription |
| `voiceGetState` | Read the current lifecycle state |
| `voiceGetDevices` | List input devices |
| `voiceGetModels` | List catalog models and local status |
| `voiceDownloadModel` / `voiceDeleteModel` | Manage one catalog artifact |
| `voiceUpdateSettings` | Update validated voice settings |
| `voiceCheckPermission` / `voiceRequestPermission` | Inspect or request microphone permission |

Events are `voiceStateChanged` and `voiceModelProgress`. Renderer-side event
payloads are runtime-checked before being passed to UI code.

## Recording lifecycle

The controller transitions through `idle`, `preparing`, `ready`, `starting`,
`listening`, `transcribing`, `done`, `error`, and `cancelling`.

While listening it reports elapsed duration and a bounded volume level. Stop
flushes the captured PCM and returns a result containing text, speech duration,
transcription duration, and the detected language. A cancel increments the
operation generation, aborts the active work, cleans up capture/stream state,
and prevents late preparation or transcription results from changing the UI.

Only one recording operation is active at a time. Model loading is lazy and
only one model is held in memory; disposing the service releases capture,
transcription, and model resources.

## Model catalog and storage

The catalog is immutable application data. Each model pins its Hugging Face
repository, 40-character commit revision, filename, expected byte size, and
64-character SHA-256 checksum. The current catalog contains Whisper Large V3
Turbo, Whisper Small, Whisper Medium, and SenseVoice Small GGUF artifacts.

Models are cached below the application data directory at
`voice-models/<modelId>/<filename>`. Downloads stream into a `.partial` file,
apply backpressure, honor cancellation, and verify the checksum before an
atomic rename. A failed or cancelled download removes the partial file and
never exposes it as an installed model.

## User experience

Settings exposes a Voice destination with the enable switch, microphone
permission action, device selector, language list, Chinese output variant, and
model download/delete controls. The Composer microphone is rendered only when
voice input is enabled. The recording overlay shows preparation, listening
duration/volume, transcription, cancellation, and error states. A successful
result is inserted into the active draft; cancellation inserts nothing.

## Security and compatibility

- Microphone permission is requested explicitly and is owned by the desktop
  main process.
- Raw audio, model files, and provider credentials are not sent to the
  renderer or to a remote transcription service.
- Untrusted renderer inputs are schema-checked at the main-process boundary.
- Existing `AppSettings.speech` and host `speech/*` IPC behavior is unchanged;
  local voice input uses the independent `AppSettings.voice` namespace.
