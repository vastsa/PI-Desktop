/**
 * Copies decrypted Chrome cookies into the work browser's cookie jar.
 *
 * Dependencies are injected so the whole flow runs in tests against a
 * synthetic cookie database and an in-memory jar.
 */
import type { BrowserCookieImportRequest, BrowserCookieImportResult } from "@pi-desktop/shared";
import {
  chromeExpiryToUnixSeconds,
  decryptChromeCookieValue,
  deriveChromeKey,
  toCookieSetDetails,
  type CookieSetDetails,
} from "./chrome-crypto";
import { chromeCookiesPath, readChromeCookieDatabase } from "./chrome-source";

export type CookieImportDependencies = {
  userDataDir: string;
  readPassword: () => Promise<string>;
  setCookie: (details: CookieSetDetails) => Promise<void>;
  now?: () => number;
};

export class ChromeProfileNotFoundError extends Error {
  readonly errorCode = "CHROME_PROFILE_NOT_FOUND";
}

export async function importChromeCookies(
  request: BrowserCookieImportRequest,
  { userDataDir, readPassword, setCookie, now = Date.now }: CookieImportDependencies,
): Promise<BrowserCookieImportResult> {
  const cookiesPath = await chromeCookiesPath(userDataDir, request.profile);
  if (!cookiesPath) throw new ChromeProfileNotFoundError(`Chrome profile "${request.profile}" has no cookie store.`);
  const database = await readChromeCookieDatabase(cookiesPath);
  const result: BrowserCookieImportResult = { imported: 0, skipped: 0, failed: 0 };
  if (database.rows.length === 0) return result;

  // Ask for the Keychain only once there is something to decrypt.
  const key = deriveChromeKey(await readPassword());
  const nowSeconds = now() / 1000;
  for (const row of database.rows) {
    const expires = chromeExpiryToUnixSeconds(row.expires_utc);
    if (expires !== undefined && expires <= nowSeconds) {
      result.skipped += 1;
      continue;
    }
    const value = decryptChromeCookieValue(row, key, database.version);
    if (value === null) {
      result.failed += 1;
      continue;
    }
    try {
      await setCookie(toCookieSetDetails(row, value));
      result.imported += 1;
    } catch {
      // Chromium rejects some combinations (e.g. SameSite=None without Secure).
      result.failed += 1;
    }
  }
  return result;
}
