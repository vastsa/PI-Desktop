export type MicrophoneOwner = "dictation" | "live";

export class MicrophoneLeaseRegistry {
  private lease: { owner: MicrophoneOwner; token: string } | null = null;

  constructor(private readonly isDictationActive: () => boolean) {}

  acquire(owner: MicrophoneOwner, token: string): () => void {
    if (this.lease?.owner === "dictation" && !this.isDictationActive()) this.lease = null;
    if (this.lease && (this.lease.owner !== owner || this.lease.token !== token)) {
      throw Object.assign(new Error("The microphone is already in use"), { errorCode: "LIVE_MICROPHONE_BUSY" });
    }
    this.lease = { owner, token };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.lease?.owner === owner && this.lease.token === token) this.lease = null;
    };
  }

  isHeld(): boolean {
    if (this.lease?.owner === "dictation" && !this.isDictationActive()) this.lease = null;
    return this.lease !== null;
  }
}
