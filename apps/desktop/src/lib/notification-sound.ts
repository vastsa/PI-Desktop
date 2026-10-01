/** Soft, best-effort in-app chime for notification and toast surfaces. */
export type NotificationAudioContext = Pick<
  AudioContext,
  | "state"
  | "currentTime"
  | "destination"
  | "createOscillator"
  | "createGain"
  | "resume"
  | "close"
>;

export type NotificationAudioContextFactory =
  () => NotificationAudioContext | undefined;

const CHIME_FREQUENCY_HZ = 660;
const CHIME_PEAK_GAIN = 0.022;
const CHIME_DURATION_SECONDS = 0.16;
const MIN_CHIME_INTERVAL_MS = 140;

function browserAudioContext(): NotificationAudioContext | undefined {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return undefined;
  }
  try {
    return new window.AudioContext();
  } catch {
    return undefined;
  }
}

export function createNotificationChime(
  createContext: NotificationAudioContextFactory = browserAudioContext,
  now: () => number = Date.now,
): () => void {
  let lastPlayedAt = Number.NEGATIVE_INFINITY;

  return () => {
    const playedAt = now();
    if (playedAt - lastPlayedAt < MIN_CHIME_INTERVAL_MS) return;
    const context = createContext();
    if (!context) return;
    lastPlayedAt = playedAt;

    const closeQuietly = () => {
      try {
        void context.close().catch(() => undefined);
      } catch {
        // Audio is optional feedback; a platform teardown failure is non-fatal.
      }
    };

    const startTone = () => {
      try {
        const startAt = context.currentTime;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(CHIME_FREQUENCY_HZ, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(CHIME_PEAK_GAIN, startAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          startAt + CHIME_DURATION_SECONDS,
        );
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = closeQuietly;
        oscillator.start(startAt);
        oscillator.stop(startAt + CHIME_DURATION_SECONDS + 0.01);
      } catch {
        closeQuietly();
      }
    };

    if (context.state === "running") startTone();
    else void context.resume().then(startTone).catch(closeQuietly);
  };
}

export const playNotificationChime = createNotificationChime();

export function shouldPlayToastSound(
  toast: { id: number; sound?: boolean },
  visibleToastIds: ReadonlySet<number>,
): boolean {
  return toast.sound !== false && !visibleToastIds.has(toast.id);
}
