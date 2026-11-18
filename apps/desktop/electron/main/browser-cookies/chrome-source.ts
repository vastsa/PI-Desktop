/**
 * Reads a local Google Chrome profile's cookie store on macOS.
 *
 * Chrome keeps the database open, so the file (and its WAL/journal) is copied
 * into a private temporary directory and read from there; the copy is removed
 * before returning. The Keychain secret is read by host-core, which shows the
 * system prompt asking the user to allow access to "Chrome Safe Storage".
 */
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChromeCookieProfile } from "@pi-desktop/shared";
import type { ChromeCookieRow } from "./chrome-crypto";

export function chromeUserDataDir(home: string): string {
  return join(home, "Library", "Application Support", "Google", "Chrome");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Newer Chrome builds keep cookies under `Network/`; older ones at the profile root. */
export async function chromeCookiesPath(userDataDir: string, profile: string): Promise<string | null> {
  for (const candidate of [join(userDataDir, profile, "Network", "Cookies"), join(userDataDir, profile, "Cookies")]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** Profiles that have a cookie store, named as Chrome's profile menu names them. */
export async function listChromeProfiles(userDataDir: string): Promise<ChromeCookieProfile[]> {
  let infoCache: Record<string, { name?: unknown }> = {};
  try {
    const state = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    infoCache = state.profile?.info_cache ?? {};
  } catch {
    // No Local State: fall back to the default profile directory below.
  }
  const ids = new Set(["Default", ...Object.keys(infoCache)]);
  const profiles: ChromeCookieProfile[] = [];
  for (const id of ids) {
    if (!(await chromeCookiesPath(userDataDir, id))) continue;
    const name = infoCache[id]?.name;
    profiles.push({ id, name: typeof name === "string" && name.trim() ? name : id });
  }
  return profiles;
}

export type ChromeCookieDatabase = { version: number; rows: ChromeCookieRow[] };

export async function readChromeCookieDatabase(cookiesPath: string): Promise<ChromeCookieDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "pi-chrome-cookies-"));
  try {
    const copy = join(dir, "Cookies");
    await copyFile(cookiesPath, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (await isFile(cookiesPath + suffix)) await copyFile(cookiesPath + suffix, copy + suffix);
    }
    const { DatabaseSync } = await import("node:sqlite");
    // Not read-only: SQLite must be able to replay a copied WAL into the copy.
    const db = new DatabaseSync(copy);
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
      const version = Number(meta?.value ?? 0);
      const statement = db.prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies",
      );
      // expires_utc is microseconds since 1601 and exceeds 2^53.
      statement.setReadBigInts(true);
      const rows = statement.all() as unknown as ChromeCookieRow[];
      return { version: Number.isFinite(version) ? version : 0, rows };
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class KeychainAccessError extends Error {
  readonly errorCode: string;

  constructor(message: string, errorCode = "CHROME_KEYCHAIN_DENIED") {
    super(message);
    this.errorCode = errorCode;
  }
}

type HostCaller = { call<T>(method: string, params?: unknown, timeoutOverrideMs?: number): Promise<T> };

/** Covers the user reading and answering the macOS consent prompt. */
const KEYCHAIN_PROMPT_TIMEOUT_MS = 130_000;

/**
 * Asks host-core for Chrome's Keychain secret. The read happens in the signed
 * host binary, so the macOS prompt names PI-Desktop's host and an "Always
 * Allow" answer is bound to its code signature rather than a shared system tool.
 */
export async function readChromeSafeStoragePassword(host: HostCaller | null): Promise<string> {
  if (!host) throw new Error("host-core is unavailable");
  let result: { password?: unknown };
  try {
    result = await host.call<{ password?: unknown }>(
      "browser.chromeSafeStoragePassword",
      {},
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    const errorCode = (error as { errorCode?: unknown } | null)?.errorCode;
    if (typeof errorCode === "string" && errorCode.startsWith("CHROME_KEYCHAIN_")) {
      throw new KeychainAccessError(error instanceof Error ? error.message : String(error), errorCode);
    }
    throw error;
  }
  if (typeof result?.password !== "string" || !result.password) {
    throw new KeychainAccessError("The Chrome Safe Storage Keychain item is unreadable.", "CHROME_KEYCHAIN_INVALID");
  }
  return result.password;
}
