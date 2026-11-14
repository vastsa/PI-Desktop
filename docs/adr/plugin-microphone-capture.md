# ADR: Host-owned plugin microphone capture

- Status: Proposed
- Date: 2026-11-13

## Context

The SDK declares `pi.audio` but the broker refuses capture. Composer renderer
extensions cannot use main-window `getUserMedia`: the main renderer microphone
gate belongs to live voice. Opening an isolated panel changes the interaction
and is unnecessary for dictation controls already rendered in the composer.

## Decision

Implement the existing capture contract with the host's PvRecorder backend.
Keep renderer media permissions unchanged. A plugin requests capture from its
own process, behind `audio.capture.background` and OS consent, and receives
PCM16 through the existing child-process transport. The renderer starts/stops
through its declared `plugin.call` relay. No secret, device handle or browser
media lease is exposed. Capture alone performs no transcription or network I/O.

The broker holds one plugin capture reservation, including startup. Ownership
uses the loaded instance identity, so a replacement with the same plugin ID
cannot inherit an old stream. Teardown revokes the reservation before stopping
the device. One frame may be in flight; the child acknowledges it after handlers
settle. The broker drops subsequent frames instead of accumulating transport
messages. A 60-second deadline bounds abandoned recordings independently of
plugin responsiveness. Native capture disables recording retention while the
built-in dictation backend preserves its current buffering behavior.

## Compatibility and limits

No SDK signatures, storage, permissions or renderer IPC channels change. Playback
remains unsupported. Initial input supports mono PCM16 at 16000 Hz only; requests
for unsupported formats or processing fail explicitly. Headless hosts may omit
the capture factory and retain a coded refusal. Local handler registration no
longer throws: it opens no device and cannot bypass the host permission gate.

The alternative of broadening main-window media permissions is rejected because
it would couple plugin capture to unrelated renderer code. Native hardware/OS
consent checks remain a separate release validation requirement.
