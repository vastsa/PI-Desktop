import type { NotificationSoundSettings } from "@pi-desktop/shared";

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

export type NotificationAudioElement = Pick<
  HTMLAudioElement,
  "currentTime" | "play" | "pause"
> & { volume: number };

export type NotificationAudioElementFactory = (
  source: string,
) => NotificationAudioElement | undefined;

const CHIME_FREQUENCY_HZ = 660;
const CHIME_PEAK_GAIN = 0.022;
const CHIME_DURATION_SECONDS = 0.16;
const MIN_CHIME_INTERVAL_MS = 140;
/** Keep settings portable without allowing an unexpectedly large data URL. */
export const MAX_CUSTOM_NOTIFICATION_SOUND_BYTES = 5 * 1024 * 1024;
export const MAX_CUSTOM_NOTIFICATION_SOUND_DATA_URL_LENGTH = 8 * 1024 * 1024;

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

function browserAudioElement(
  source: string,
): NotificationAudioElement | undefined {
  const AudioConstructor = (
    globalThis as typeof globalThis & {
      Audio?: new (source?: string) => HTMLAudioElement;
    }
  ).Audio;
  if (typeof AudioConstructor !== "function") return undefined;
  try {
    const audio = new AudioConstructor(source);
    audio.volume = 1;
    return audio;
  } catch {
    return undefined;
  }
}

function validCustomDataUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CUSTOM_NOTIFICATION_SOUND_DATA_URL_LENGTH &&
    /^data:audio\/[a-z0-9.+-]+;base64,/i.test(value)
  );
}

/** Normalize old, missing, or malformed values to the safe built-in chime. */
export function normalizeNotificationSoundSettings(
  value: unknown,
): NotificationSoundSettings {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const customDataUrl = validCustomDataUrl(object.customDataUrl)
    ? object.customDataUrl
    : undefined;
  const customName =
    typeof object.customName === "string" && object.customName.trim()
      ? object.customName.trim().slice(0, 256)
      : undefined;
  return {
    mode: object.mode === "custom" && customDataUrl ? "custom" : "system",
    ...(customDataUrl ? { customDataUrl } : {}),
    ...(customName ? { customName } : {}),
  };
}

export function createNotificationSoundPlayer(
  createSystemChime: () => void = createNotificationChime(),
  createAudio: NotificationAudioElementFactory = browserAudioElement,
): {
  play: () => void;
  setSettings: (value: unknown) => NotificationSoundSettings;
  getSettings: () => NotificationSoundSettings;
} {
  let settings = normalizeNotificationSoundSettings(undefined);
  let audioSource: string | undefined;
  let audio: NotificationAudioElement | undefined;

  const playCustom = (source: string) => {
    if (source !== audioSource) {
      audioSource = source;
      audio = createAudio(source);
    }
    if (!audio) {
      createSystemChime();
      return;
    }
    try {
      audio.pause();
      audio.currentTime = 0;
      const result = audio.play();
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => createSystemChime());
      }
    } catch {
      createSystemChime();
    }
  };

  return {
    play: () => {
      if (settings.mode === "custom" && settings.customDataUrl) {
        playCustom(settings.customDataUrl);
      } else {
        createSystemChime();
      }
    },
    setSettings: (value) => {
      settings = normalizeNotificationSoundSettings(value);
      if (settings.customDataUrl !== audioSource) {
        audio = undefined;
        audioSource = undefined;
      }
      return settings;
    },
    getSettings: () => settings,
  };
}

const notificationSoundPlayer = createNotificationSoundPlayer();

/** Apply the persisted preference without making notification callers know about settings. */
export function setNotificationSoundSettings(value: unknown): void {
  notificationSoundPlayer.setSettings(value);
}

export const playNotificationChime = () => notificationSoundPlayer.play();

export function shouldPlayToastSound(
  toast: { id: number; sound?: boolean },
  visibleToastIds: ReadonlySet<number>,
): boolean {
  return toast.sound !== false && !visibleToastIds.has(toast.id);
}
