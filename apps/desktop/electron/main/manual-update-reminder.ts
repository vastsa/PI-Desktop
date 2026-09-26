export type ManualUpdateReminderDecision = {
  show: boolean;
  persist: boolean;
};

/** Keeps manual update notices to one visible announcement per release. */
export class ManualUpdateReminderTracker {
  private lastNotifiedVersion?: string;
  private activeVersion?: string;
  private activeReminder = false;

  constructor(lastNotifiedVersion?: string) {
    this.lastNotifiedVersion = lastNotifiedVersion;
  }

  hydrate(lastNotifiedVersion?: string): void {
    if (lastNotifiedVersion) this.lastNotifiedVersion = lastNotifiedVersion;
  }

  observe(version: string): ManualUpdateReminderDecision {
    if (this.activeVersion === version) {
      return { show: this.activeReminder, persist: false };
    }
    this.activeVersion = version;
    this.activeReminder = version !== this.lastNotifiedVersion;
    if (this.activeReminder) this.lastNotifiedVersion = version;
    return { show: this.activeReminder, persist: this.activeReminder };
  }
}
