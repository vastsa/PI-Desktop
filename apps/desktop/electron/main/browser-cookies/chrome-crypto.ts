/**
 * Pure Chrome cookie-store decoding for macOS (and Linux v10 rows).
 *
 * Chrome on macOS encrypts each cookie value with AES-128-CBC. The key is
 * PBKDF2-SHA1 over the "Chrome Safe Storage" Keychain password, salt
 * "saltysalt", 1003 iterations; the IV is 16 spaces. From cookie database
 * version 24 the plaintext starts with SHA-256(host_key), which binds the
 * value to its domain and must be stripped.
 *
 * No I/O here, so every branch is unit-testable with synthetic rows.
 */
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";

export type ChromeCookieRow = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  /** Microseconds since 1601-01-01 UTC; 0 for session cookies. */
  expires_utc: bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  /** -1 unspecified, 0 none, 1 lax, 2 strict. */
  samesite: number | bigint;
};

/** Electron's `CookiesSetDetails` shape, kept local so this module stays Electron-free. */
export type CookieSetDetails = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20);
const V10 = Buffer.from("v10");
const DOMAIN_HASH_VERSION = 24;
/** Seconds between 1601-01-01 and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600n;

export function deriveChromeKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, "sha1");
}

/**
 * Decrypt one row's value. Returns null when the row uses a scheme this
 * module does not support (e.g. Windows v20 app-bound encryption) or when the
 * ciphertext does not decrypt under `key`.
 */
export function decryptChromeCookieValue(
  row: Pick<ChromeCookieRow, "value" | "encrypted_value" | "host_key">,
  key: Buffer,
  databaseVersion: number,
): string | null {
  const encrypted = Buffer.from(row.encrypted_value);
  if (encrypted.length === 0) return row.value;
  if (!encrypted.subarray(0, 3).equals(V10)) return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (databaseVersion >= DOMAIN_HASH_VERSION) {
    const expected = createHash("sha256").update(row.host_key).digest();
    if (plain.length < expected.length || !plain.subarray(0, expected.length).equals(expected)) return null;
    plain = plain.subarray(expected.length);
  }
  return plain.toString("utf8");
}

/** Unix seconds, or undefined for a session cookie. */
export function chromeExpiryToUnixSeconds(expiresUtc: bigint): number | undefined {
  if (expiresUtc <= 0n) return undefined;
  return Number(expiresUtc / 1_000_000n - WINDOWS_EPOCH_OFFSET_SECONDS);
}

const SAME_SITE: Record<string, CookieSetDetails["sameSite"]> = {
  "0": "no_restriction",
  "1": "lax",
  "2": "strict",
};

export function toCookieSetDetails(row: ChromeCookieRow, value: string): CookieSetDetails {
  const secure = Boolean(Number(row.is_secure));
  const host = row.host_key.replace(/^\./, "");
  const path = row.path || "/";
  const expirationDate = chromeExpiryToUnixSeconds(row.expires_utc);
  return {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    name: row.name,
    value,
    // A leading dot marks a domain cookie; host-only cookies must omit `domain`.
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    path,
    secure,
    httpOnly: Boolean(Number(row.is_httponly)),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    sameSite: SAME_SITE[String(row.samesite)] ?? "unspecified",
  };
}
