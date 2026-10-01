import { Buffer } from "node:buffer";
import type { LiveTranscriptEvent } from "@pi-desktop/shared";
import type { LiveWireEvent } from "@pi-desktop/voice-runtime/live";
import type { Slot } from "./call-service-internals";

const MAX_TRANSCRIPT_SEGMENTS = 200;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;

export function pushLiveTranscript(
  slot: Slot,
  event: Extract<LiveWireEvent, { kind: "transcript" }>,
  sendTranscript: (owner: Slot["owner"], event: LiveTranscriptEvent) => void,
  now: () => number,
): void {
  const text = event.text.slice(0, 16_384);
  if (!text) return;
  const key = `${event.role}\u0000${event.id.slice(0, 256)}`;
  const bytes = Buffer.byteLength(text, "utf8");
  const priorBytes = slot.transcriptLengths.get(key) ?? 0;
  while (
    (!slot.transcriptLengths.has(key) && slot.transcriptLengths.size >= MAX_TRANSCRIPT_SEGMENTS) ||
    [...slot.transcriptLengths.values()].reduce((sum, size) => sum + size, 0) - priorBytes + bytes > MAX_TRANSCRIPT_BYTES
  ) {
    const oldest = slot.transcriptLengths.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    slot.transcriptLengths.delete(oldest);
  }
  slot.transcriptLengths.set(key, bytes);
  sendTranscript(slot.owner, {
    callId: slot.callId,
    segment: { id: event.id.slice(0, 256), role: event.role, text, final: event.final, timestamp: now() },
  });
}
