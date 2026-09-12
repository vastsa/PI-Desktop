/**
 * Client for the official MCP Registry (registry.modelcontextprotocol.io).
 *
 * Lives in the main process because the renderer's CSP only allows localhost
 * connections — the same reason models.dev fetching sits here. Responses are
 * mapped into market templates by the pure adapter in @pi-desktop/shared and
 * cached in memory, so browsing stays instant after the first load and a
 * registry outage degrades to the built-in catalog instead of an error page.
 */
import {
  mapRegistryServer,
  type McpCatalogEntry,
  type RegistryRecord,
} from "@pi-desktop/shared";

const ENDPOINT = "https://registry.modelcontextprotocol.io/v0/servers";
const PAGE_SIZE = 100;
/** Two pages ≈ 200 servers: enough breadth, still a snappy first load. */
const MAX_PAGES = 2;
const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

export type McpRegistrySearchResult = {
  entries: McpCatalogEntry[];
  error?: "unavailable";
};

function mapRecords(records: RegistryRecord[]): McpCatalogEntry[] {
  const entries: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const entry = mapRegistryServer(record);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

async function fetchPage(
  params: URLSearchParams,
): Promise<{ records: RegistryRecord[]; nextCursor?: string }> {
  const response = await fetch(`${ENDPOINT}?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status}`);
  const body = (await response.json()) as {
    servers?: RegistryRecord[];
    metadata?: { nextCursor?: string };
  };
  return { records: body.servers ?? [], nextCursor: body.metadata?.nextCursor };
}

export function createMcpRegistryCatalog() {
  let browseCache: { at: number; entries: McpCatalogEntry[] } | null = null;
  const searchCache = new Map<string, { at: number; entries: McpCatalogEntry[] }>();

  async function loadBrowse(): Promise<McpCatalogEntry[]> {
    if (browseCache && Date.now() - browseCache.at < CACHE_TTL_MS) return browseCache.entries;
    const records: RegistryRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ version: "latest", limit: String(PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      const result = await fetchPage(params);
      records.push(...result.records);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    browseCache = { at: Date.now(), entries: mapRecords(records) };
    return browseCache.entries;
  }

  async function search(query: string): Promise<McpRegistrySearchResult> {
    const trimmed = query.trim().toLowerCase();
    try {
      if (!trimmed) return { entries: await loadBrowse() };
      const hit = searchCache.get(trimmed);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { entries: hit.entries };
      const { records } = await fetchPage(
        new URLSearchParams({ version: "latest", search: trimmed, limit: String(PAGE_SIZE) }),
      );
      const entries = mapRecords(records);
      searchCache.set(trimmed, { at: Date.now(), entries });
      return { entries };
    } catch {
      // The built-in catalog is always rendered underneath, so an outage only
      // costs the long tail — say so instead of throwing into the UI.
      return { entries: [], error: "unavailable" };
    }
  }

  return { search };
}

/** Shared main-process instance so the cache survives across IPC calls. */
const mcpRegistryCatalog = createMcpRegistryCatalog();

export function searchMcpRegistry(query: string): Promise<McpRegistrySearchResult> {
  return mcpRegistryCatalog.search(query);
}
