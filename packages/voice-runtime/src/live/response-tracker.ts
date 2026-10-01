const MAX_ACTIVE_RESPONSES = 64;
const MAX_INTERRUPTED_RESPONSES = 128;

/** Keeps late Realtime audio and completion events from reviving interrupted playback. */
export class RealtimeResponseTracker {
  private readonly active = new Set<string>();
  private readonly interrupted = new Set<string>();

  add(responseId: string): void {
    this.active.add(responseId);
    while (this.active.size > MAX_ACTIVE_RESPONSES) this.active.delete(this.active.values().next().value as string);
  }

  interrupt(): void {
    for (const responseId of this.active) this.interrupted.add(responseId);
    while (this.interrupted.size > MAX_INTERRUPTED_RESPONSES) this.interrupted.delete(this.interrupted.values().next().value as string);
  }

  finish(responseId: string): boolean {
    this.active.delete(responseId);
    return this.interrupted.has(responseId);
  }

  shouldSendCancel(): boolean {
    return this.active.size > 0;
  }

  shouldAcceptAudio(responseId: string): boolean {
    return !this.interrupted.has(responseId);
  }

  clear(): void {
    this.active.clear();
    this.interrupted.clear();
  }
}
