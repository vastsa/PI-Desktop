/**
 * Aggregator for user-configured MCP market sources.
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections — the same reason models.dev fetching sits here. Two source
 * kinds are supported: registry endpoints speaking the official MCP registry
 * protocol (`/v0/servers`) and static catalog JSON files in the market's
 * built-in schema. Sources are fetched in parallel; one failing source only
 * costs itself, and a total outage degrades to the built-in catalog.
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
/** Cursor pages per registry source: enough breadth, still a snappy load. */
const MAX_PAGES = 2;
const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

export type McpRegistrySearchResult = {
  entries: SourcedCatalogEntry[];
  /** Sources that could not be fetched (unsafe URL, offline, bad payload). */
  failedSources: string[];
};

function registryUrl(endpoint: string, params: URLSearchParams): string {
  return endpoint.includes("?") ? `${endpoint}&${params}` : `${endpoint}?${params}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`source responded ${response.status}`);
  return (await response.json()) as T;
}

async function fetchRegistrySource(
  source: MarketSource,
): Promise<SourcedCatalogEntry[]> {
  const records: RegistryRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ version: "latest", limit: String(PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const body = await fetchJson<{
      servers?: RegistryRecord[];
      metadata?: { nextCursor?: string };
    }>(registryUrl(source.url, params));
    records.push(...(body.servers ?? []));
    if (!body.metadata?.nextCursor) break;
    cursor = body.metadata.nextCursor;
  }
  const entries: SourcedCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const entry = mapRegistryServer(record);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push({ ...entry, sourceId: source.id });
  }
  return entries;
}

async function fetchCatalogSource(source: MarketSource): Promise<SourcedCatalogEntry[]> {
  const body = await fetchJson<unknown>(source.url);
  const { catalog } = validateMcpCatalogFile(body);
  return catalog.servers.map((entry) => ({ ...entry, sourceId: source.id }));
}

function searchRegistrySource(
  source: MarketSource,
  query: string,
): Promise<SourcedCatalogEntry[]> {
  const params = new URLSearchParams({
    version: "latest",
    search: query,
    limit: String(PAGE_SIZE),
  });
  return fetchRegistrySourcePage(source, registryUrl(source.url, params));
}

async function fetchRegistrySourcePage(
  source: MarketSource,
  url: string,
): Promise<SourcedCatalogEntry[]> {
  const body = await fetchJson<{
    servers?: RegistryRecord[];
    metadata?: { nextCursor?: string };
  }>(url);
  const entries: SourcedCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const record of body.servers ?? []) {
    const entry = mapRegistryServer(record);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push({ ...entry, sourceId: source.id });
  }
  return entries;
}

async function searchCatalogSource(
  source: MarketSource,
  query: string,
): Promise<SourcedCatalogEntry[]> {
  // Catalog JSON has no server-side search: fetch whole file, filter locally.
  const trimmed = query.trim().toLowerCase();
  const entries = await fetchCatalogSource(source);
  if (!trimmed) return entries;
  return entries.filter((entry) =>
    [entry.name, entry.description, entry.author]
      .filter(Boolean)
      .some((text) => text!.toLocaleLowerCase().includes(trimmed)),
  );
}

export function createMcpMarketAggregator() {
  const cache = new Map<string, { at: number; entries: SourcedCatalogEntry[] }>();

  async function fetchSource(
    source: MarketSource,
    query: string,
  ): Promise<SourcedCatalogEntry[]> {
    const trimmed = query.trim().toLowerCase();
    const key = `${source.id}|${source.url}|${trimmed}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const entries =
      source.kind === "registry"
        ? trimmed
          ? await searchRegistrySource(source, trimmed)
          : await fetchRegistrySource(source)
        : await searchCatalogSource(source, trimmed);
    cache.set(key, { at: Date.now(), entries });
    return entries;
  }

  async function search(
    query: string,
    sources: MarketSource[],
  ): Promise<McpRegistrySearchResult> {
    const safe = sources.filter((source) => isSafeMarketSourceUrl(source.url));
    const failedSources = sources
      .filter((source) => !isSafeMarketSourceUrl(source.url))
      .map((source) => source.name);
    const settled = await Promise.allSettled(safe.map((source) => fetchSource(source, query)));
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
    return { entries, failedSources };
  }

  return { search };
}

/** Shared main-process instance so the cache survives across IPC calls. */
const aggregator = createMcpMarketAggregator();

export function searchMcpMarket(
  query: string,
  sources: MarketSource[],
): Promise<McpRegistrySearchResult> {
  return aggregator.search(query, sources);
}
