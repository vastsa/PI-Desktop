/**
 * Aggregator for user-configured MCP market sources.
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections — the same reason models.dev fetching sits here. Two source
 * kinds are supported: registry endpoints speaking the official MCP registry
 * protocol (`/v0/servers`) and static catalog JSON files in the market's
 * built-in schema.
 *
 * Registry sources stream in incrementally: the first browse loads two pages
 * so the market paints fast, and each "load more" extends the window by
 * another batch from the remembered cursor. The registry holds thousands of
 * servers — more than any user will scroll — so there is deliberately no
 * "load everything". Searches always hit the registry server-side and see the
 * whole catalog regardless of what is cached. One failing source only costs
 * itself, and a total outage degrades to the built-in catalog.
 */
import {
  isSafeMarketSourceUrl,
  mapRegistryServer,
  validateMcpCatalogFile,
  type MarketSource,
  type McpCatalogEntry,
  type RegistryRecord,
  type SourcedCatalogEntry,
} from "@pi-desktop/shared";

const PAGE_SIZE = 100;
/** First browse paints two pages; every "load more" appends this many. */
const INITIAL_PAGES = 2;
const MORE_PAGES = 10;
const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

export type McpRegistrySearchResult = {
  entries: SourcedCatalogEntry[];
  /** Sources that could not be fetched (unsafe URL, offline, bad payload). */
  failedSources: string[];
  /** False while a registry source still has cursor pages left to stream in. */
  exhausted: boolean;
};

function registryUrl(endpoint: string, params: URLSearchParams): string {
  return endpoint.includes("?") ? `${endpoint}&${params}` : `${endpoint}?${params}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`source responded ${response.status}`);
  return (await response.json()) as T;
}

/** Per-registry-source streaming state, so "load more" continues a cursor. */
type RegistryBrowse = {
  entries: SourcedCatalogEntry[];
  cursor?: string;
  exhausted: boolean;
};

function ingest(records: RegistryRecord[], source: MarketSource, seen: Set<string>, into: SourcedCatalogEntry[]): void {
  for (const record of records) {
    const entry = mapRegistryServer(record);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    into.push({ ...entry, sourceId: source.id });
  }
}

export function createMcpMarketAggregator() {
  const registryBrowse = new Map<string, RegistryBrowse>();
  const catalogCache = new Map<string, { at: number; entries: SourcedCatalogEntry[] }>();
  const searchCache = new Map<string, { at: number; entries: SourcedCatalogEntry[] }>();

  async function extendRegistry(source: MarketSource, pages: number): Promise<RegistryBrowse> {
    let state = registryBrowse.get(source.id);
    if (!state) {
      state = { entries: [], exhausted: false };
      registryBrowse.set(source.id, state);
    }
    for (let page = 0; page < pages && !state.exhausted; page += 1) {
      const params = new URLSearchParams({ version: "latest", limit: String(PAGE_SIZE) });
      if (state.cursor) params.set("cursor", state.cursor);
      const body = await fetchJson<{
        servers?: RegistryRecord[];
        metadata?: { nextCursor?: string };
      }>(registryUrl(source.url, params));
      const seen = new Set(state.entries.map((entry) => entry.id));
      ingest(body.servers ?? [], source, seen, state.entries);
      if (body.metadata?.nextCursor) state.cursor = body.metadata.nextCursor;
      else state.exhausted = true;
    }
    return state;
  }

  async function browseRegistry(source: MarketSource, more: boolean): Promise<RegistryBrowse> {
    const state = registryBrowse.get(source.id);
    if (!state || (more && !state.exhausted)) return extendRegistry(source, more ? MORE_PAGES : INITIAL_PAGES);
    return state;
  }

  async function loadCatalog(source: MarketSource): Promise<SourcedCatalogEntry[]> {
    const hit = catalogCache.get(source.url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const body = await fetchJson<unknown>(source.url);
    const { catalog } = validateMcpCatalogFile(body);
    const entries = catalog.servers.map((entry) => ({ ...entry, sourceId: source.id }));
    catalogCache.set(source.url, { at: Date.now(), entries });
    return entries;
  }

  async function searchRegistry(source: MarketSource, query: string): Promise<SourcedCatalogEntry[]> {
    const trimmed = query.trim().toLowerCase();
    const key = `${source.id}|${trimmed}`;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const body = await fetchJson<{
      servers?: RegistryRecord[];
      metadata?: { nextCursor?: string };
    }>(registryUrl(source.url, new URLSearchParams({ version: "latest", search: trimmed, limit: String(PAGE_SIZE) })));
    const entries: SourcedCatalogEntry[] = [];
    const seen = new Set<string>();
    ingest(body.servers ?? [], source, seen, entries);
    searchCache.set(key, { at: Date.now(), entries });
    return entries;
  }

  async function search(
    query: string,
    sources: MarketSource[],
    options: { more?: boolean } = {},
  ): Promise<McpRegistrySearchResult> {
    const trimmed = query.trim().toLowerCase();
    const safe = sources.filter((source) => isSafeMarketSourceUrl(source.url));
    const failedSources = sources
      .filter((source) => !isSafeMarketSourceUrl(source.url))
      .map((source) => source.name);

    // A typed search is answered by each registry server-side, so it sees the
    // whole catalog no matter how much of the browse window has streamed in.
    if (trimmed) {
      const settled = await Promise.allSettled(
        safe.map((source) =>
          source.kind === "registry"
            ? searchRegistry(source, trimmed)
            : loadCatalog(source).then((entries) =>
                entries.filter((entry) =>
                  [entry.name, entry.description, entry.author]
                    .filter(Boolean)
                    .some((text) => text!.toLocaleLowerCase().includes(trimmed)),
                ),
              ),
        ),
      );
      const entries: SourcedCatalogEntry[] = [];
      const seen = new Set<string>();
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          failedSources.push(safe[index].name);
          return;
        }
        for (const entry of result.value) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          entries.push(entry);
        }
      });
      return { entries, failedSources, exhausted: true };
    }

    // Empty query = browse. Registry sources stream pages; catalog sources are
    // complete files and always arrive whole.
    const settled = await Promise.allSettled(
      safe.map((source) =>
        source.kind === "registry"
          ? browseRegistry(source, options.more === true).then((state) => ({
              entries: state.entries,
              exhausted: state.exhausted,
            }))
          : loadCatalog(source).then((entries) => ({ entries, exhausted: true })),
      ),
    );
    const entries: SourcedCatalogEntry[] = [];
    const seen = new Set<string>();
    let exhausted = true;
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        failedSources.push(safe[index].name);
        return;
      }
      for (const entry of result.value.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
      if (!result.value.exhausted) exhausted = false;
    });
    return { entries, failedSources, exhausted };
  }

  return { search };
}

/** Shared main-process instance so caches survive across IPC calls. */
const aggregator = createMcpMarketAggregator();

export function searchMcpMarket(
  query: string,
  sources: MarketSource[],
  options: { more?: boolean } = {},
): Promise<McpRegistrySearchResult> {
  return aggregator.search(query, sources, options);
}
