import { randomUUID } from "node:crypto";
import type { LiveWorkSelectionOption, SessionSource } from "@pi-desktop/shared";

export type LiveWorkSelectionEntry = {
  callId: string;
  workBindingRevision: number;
  kind: "project" | "session";
  sessionSource?: SessionSource;
  value: string;
  label: string;
  duplicateLabel: boolean;
  expiresAt: number;
};

type Candidate = Pick<LiveWorkSelectionEntry, "kind" | "value" | "label" | "sessionSource">;

const MAX_SELECTIONS_PER_CALL = 80;
const SELECTION_TTL_MS = 60_000;

/** Opaque, short-lived references scoped to one active work call. */
export class LiveWorkSelectionRegistry {
  private readonly entries = new Map<string, LiveWorkSelectionEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  issue(
    callId: string,
    workBindingRevision: number,
    candidates: Candidate[],
    action: LiveWorkSelectionOption["action"],
  ): LiveWorkSelectionOption[] {
    this.prune();
    const now = this.now();
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.label, (counts.get(candidate.label) ?? 0) + 1);
    const options = candidates.slice(0, 20).map((candidate): LiveWorkSelectionOption => {
      const selectionRef = this.createId();
      const duplicateLabel = (counts.get(candidate.label) ?? 0) > 1;
      this.entries.set(selectionRef, {
        ...candidate,
        callId,
        workBindingRevision,
        duplicateLabel,
        expiresAt: now + SELECTION_TTL_MS,
      });
      return {
        selectionRef,
        kind: candidate.kind,
        action,
        ...(candidate.sessionSource ? { sessionSource: candidate.sessionSource } : {}),
        label: candidate.label,
        ...(duplicateLabel ? { duplicateLabel: true } : {}),
      };
    });
    this.enforceCallLimit(callId);
    return options;
  }

  resolve(input: { callId: string; workBindingRevision: number; selectionRef: string }): LiveWorkSelectionEntry | undefined {
    const entry = this.entries.get(input.selectionRef);
    if (!entry) return undefined;
    if (entry.callId !== input.callId || entry.workBindingRevision !== input.workBindingRevision) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(input.selectionRef);
      return undefined;
    }
    return { ...entry };
  }

  removeCall(callId: string): void {
    for (const [selectionRef, entry] of this.entries) {
      if (entry.callId === callId) this.entries.delete(selectionRef);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [selectionRef, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(selectionRef);
    }
  }

  private enforceCallLimit(callId: string): void {
    while ([...this.entries.values()].filter((entry) => entry.callId === callId).length > MAX_SELECTIONS_PER_CALL) {
      const oldest = [...this.entries].find(([, entry]) => entry.callId === callId)?.[0];
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
