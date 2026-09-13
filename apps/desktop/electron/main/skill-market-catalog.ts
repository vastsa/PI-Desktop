/**
 * Aggregator for user-configured skill market sources.
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections. Skill sources are catalog JSON files in the market schema;
 * they are fetched whole (a catalog is complete by nature), filtered locally,
 * cached briefly, and tagged per source. One failing source only costs
 * itself, and a total outage degrades to the built-in catalog.
 *
 * Document fetching (for preview and install) also sits here for the same
 * CSP reason; the actual write goes through the existing `skills.create`
 * path on the renderer's side.
 */
import { net } from "electron";
import {
  isSafeSkillSourceUrl,
  splitSkillDocument,
  validateSkillCatalogFile,
  type SkillCatalogEntry,
  type SkillMarketSource,
  type SourcedSkillEntry,
} from "@pi-desktop/shared";

const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

// net.fetch rides Chromium's network stack, so system/user proxy settings
// apply — plain undici fetch would ignore them and raw.githubusercontent is
// unreachable directly from some networks. Three attempts ride out flaps.
async function request(url: string, kind: "json" | "text"): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`responded ${response.status}`);
      return kind === "json" ? ((await response.json()) as unknown) : await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await request(url, "json")) as T;
}

async function fetchText(url: string): Promise<string> {
  return (await request(url, "text")) as string;
}

export type SkillMarketSearchResult = {
  entries: SourcedSkillEntry[];
  failedSources: string[];
};

export type SkillMarketDocument = {
  name?: string;
  description?: string;
  body: string;
};

export function createSkillMarketAggregator() {
  const catalogCache = new Map<string, { at: number; entries: SourcedSkillEntry[] }>();
  const documentCache = new Map<string, { at: number; document: SkillMarketDocument }>();

  async function loadCatalog(source: SkillMarketSource): Promise<SourcedSkillEntry[]> {
    const hit = catalogCache.get(source.url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const body = await fetchJson<unknown>(source.url);
    const { catalog } = validateSkillCatalogFile(body);
    const entries = catalog.skills.map((entry) => ({ ...entry, sourceId: source.id }));
    catalogCache.set(source.url, { at: Date.now(), entries });
    return entries;
  }

  async function fetchDocument(url: string): Promise<SkillMarketDocument> {
    const hit = documentCache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.document;
    const document = splitSkillDocument(await fetchText(url));
    documentCache.set(url, { at: Date.now(), document });
    return document;
  }

  async function search(
    query: string,
    sources: SkillMarketSource[],
  ): Promise<SkillMarketSearchResult> {
    const trimmed = query.trim().toLocaleLowerCase();
    const usable = sources.filter((source) => isSafeSkillSourceUrl(source.url));
    const failedSources = sources
      .filter((source) => !isSafeSkillSourceUrl(source.url))
      .map((source) => source.name);
    const settled = await Promise.allSettled(
      usable.map(async (source) => {
        const entries = await loadCatalog(source);
        if (!trimmed) return entries;
        return entries.filter((entry) =>
          [entry.name, entry.description, entry.author]
            .filter(Boolean)
            .some((text) => text!.toLocaleLowerCase().includes(trimmed)),
        );
      }),
    );
    const entries: SourcedSkillEntry[] = [];
    const seen = new Set<string>();
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        failedSources.push(usable[index].name);
        return;
      }
      for (const entry of result.value) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
    });
    return { entries, failedSources };
  }

  async function fetchEntryDocument(entry: SkillCatalogEntry): Promise<SkillMarketDocument> {
    if (!isSafeSkillSourceUrl(entry.url)) throw new Error("document url must be a public https address");
    return fetchDocument(entry.url);
  }

  return { search, fetchEntryDocument };
}

/** Shared main-process instance so caches survive across IPC calls. */
const aggregator = createSkillMarketAggregator();

export function searchSkillMarket(
  query: string,
  sources: SkillMarketSource[],
): Promise<SkillMarketSearchResult> {
  return aggregator.search(query, sources);
}

export function fetchSkillMarketDocument(
  entry: SkillCatalogEntry,
): Promise<SkillMarketDocument> {
  return aggregator.fetchEntryDocument(entry);
}
