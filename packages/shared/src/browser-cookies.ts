/**
 * User-triggered import of signed-in Chrome cookies into the work browser.
 *
 * The renderer only sees profile names and counts. Cookie names and values
 * never cross the IPC boundary.
 */
export type ChromeCookieProfile = {
  /** Directory name under Chrome's user data dir, e.g. "Default" or "Profile 1". */
  id: string;
  /** Display name from Chrome's Local State, falling back to `id`. */
  name: string;
};

export type BrowserCookieImportStatus = {
  /** False on platforms where Chrome cookie decryption is not implemented. */
  supported: boolean;
  profiles: ChromeCookieProfile[];
};

export type BrowserCookieImportRequest = {
  profile: string;
};

export type BrowserCookieImportResult = {
  imported: number;
  /** Expired cookies. */
  skipped: number;
  /** Rows that could not be decrypted or that Electron rejected. */
  failed: number;
};

/** Validate an untrusted import request at the IPC boundary. */
export function validateBrowserCookieImportRequest(input: unknown): BrowserCookieImportRequest {
  if (!input || typeof input !== "object") throw new Error("Invalid cookie import request.");
  const { profile } = input as Record<string, unknown>;
  if (typeof profile !== "string" || !/^[A-Za-z0-9 _.-]{1,64}$/.test(profile) || profile.startsWith(".")) {
    throw new Error("Invalid Chrome profile.");
  }
  return { profile };
}
