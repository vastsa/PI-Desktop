/**
 * Minimal `electron` module stub for importing voice-service.ts under
 * `node --test`: the service itself only touches `app` (in the
 * createVoiceService wrapper) and `BrowserWindow` as a type, while
 * audio-backend.ts reads `systemPreferences` for the macOS microphone
 * permission path.
 */
export const app = {
  once: () => undefined,
};

export const BrowserWindow = class BrowserWindow {};

export const systemPreferences = {
  getMediaAccessStatus: () => "granted",
  askForMediaAccess: async () => true,
};
