/**
 * The merged `/` command source (builtin + template + plugin + extension + MCP
 * + skill) behind one short TTL cache, shared by the composer menu and the
 * send-time resolver.
 *
 * The cache lives outside React so the launch pre-warm (#1543) can seed it
 * before the user types the first `/`: the host assembles that list from a cold
 * MCP/skill read, so paying for it on the keystroke is what made the menu feel
 * absent on a fresh launch.
 */
import type { ComposerCommand } from "@pi-desktop/shared";
import { api } from "./api";

/** Menu and resolver share one window; both re-read after it lapses. */
const SOURCE_TTL_MS = 10_000;
/** Attempts spend their wait on a booting sidecar, so keep the cadence short. */
const PREWARM_RETRY_MS = 2_000;
const PREWARM_MAX_ATTEMPTS = 10;

type CommandCache = { key: string; at: number; commands: ComposerCommand[] };

let cache: CommandCache | null = null;
let inFlight: { key: string; promise: Promise<ComposerCommand[]> } | null = null;
/** Read order of the last cache write, so a late answer cannot win. */
let cacheWriteSeq = 0;

/**
 * The warm list for `key`, or `null` when the cache is cold or holds another
 * workspace. Callers treat `null` as "read the source".
 */
export function readComposerCommandsCache(
  key: string,
  now = Date.now(),
): ComposerCommand[] | null {
  if (!cache || cache.key !== key || now - cache.at >= SOURCE_TTL_MS) return null;
  return cache.commands;
}

/**
 * Read the source, sharing one RPC between concurrent callers (the pre-warm and
 * a typed `/` can overlap). A failed read leaves the cache cold, so the next
 * attempt re-reads instead of serving an empty menu forever.
 */
export function fetchComposerCommands(key: string): Promise<ComposerCommand[]> {
  const cached = readComposerCommandsCache(key);
  if (cached) return Promise.resolve(cached);
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const seq = ++cacheWriteSeq;
  const tracked = api
    .composerCommands()
    .then((res) => {
      // A read that started later owns the cache: a late answer for a previous
      // workspace must not re-cold the current one.
      if (!cache || cacheWriteSeq === seq) {
        cache = { key, at: Date.now(), commands: res.commands };
      }
      return res.commands;
    })
    .finally(() => {
      // Identity, not key: an older read for the same key must not clear the
      // newer one that replaced it in `inFlight`.
      if (inFlight?.promise === tracked) inFlight = null;
    });
  inFlight = { key, promise: tracked };
  return tracked;
}

/**
 * Seed the cache while the app starts, so the first `/` of a session opens
 * without a host round trip (#1543). A launch races a booting sidecar, so a
 * failed attempt retries on a short cadence; the lazy menu path stays the
 * fallback and the host list is re-read once the TTL lapses either way.
 *
 * @returns the cancel handle for the caller's effect cleanup.
 */
export function prewarmComposerCommands(key: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let attempts = 0;
  const attempt = (): void => {
    void fetchComposerCommands(key).catch(() => {
      // Expected while the host is still booting; the menu re-reads on demand.
      if (cancelled || attempts >= PREWARM_MAX_ATTEMPTS) return;
      attempts += 1;
      timer = setTimeout(attempt, PREWARM_RETRY_MS);
    });
  };
  if (!readComposerCommandsCache(key)) attempt();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/** Test seam: forget the TTL window, any tracked read and the write order. */
export function resetComposerCommandCache(): void {
  cache = null;
  inFlight = null;
  cacheWriteSeq = 0;
}
