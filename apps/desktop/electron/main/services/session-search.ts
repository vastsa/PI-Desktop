import type { SessionSearchPage } from "@pi-desktop/shared";

type RpcClient = {
  call<T>(method: string, input?: unknown): Promise<T>;
};

const SEARCH_PAGE_SIZE = 30;

function compareHits(
  left: SessionSearchPage["hits"][number],
  right: SessionSearchPage["hits"][number],
): number {
  return (
    String(right.session.updatedAt).localeCompare(String(left.session.updatedAt)) ||
    left.session.id.localeCompare(right.session.id)
  );
}

/**
 * Merge Desktop SQLite search with the sidecar's canonical native-session
 * search while keeping the existing 30-item global-search cursor contract.
 * Native search returns its complete bounded catalog because it has no SQLite
 * cursor; the host is read from the beginning until enough rows are available
 * to make the merged ordering deterministic.
 */
export async function searchSessionsAcrossSources(
  host: RpcClient,
  sidecar: RpcClient | null,
  input: unknown,
): Promise<SessionSearchPage> {
  const request = input && typeof input === "object" ? input : {};
  const rawOffset = Reflect.get(request, "offset");
  const offset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
  const requiredHostRows = offset + SEARCH_PAGE_SIZE;

  const nativeSearch = sidecar
    ? sidecar
        .call<SessionSearchPage>("native.session.search", {
          query: Reflect.get(request, "query"),
        })
        .catch(() => ({ hits: [], nextOffset: null }))
    : Promise.resolve<SessionSearchPage>({ hits: [], nextOffset: null });

  const hostHits: SessionSearchPage["hits"] = [];
  let hostNextOffset: number | null = null;
  let hostOffset = 0;
  do {
    const page = await host.call<SessionSearchPage>("search.sessions", {
      ...request,
      offset: hostOffset,
    });
    hostHits.push(...page.hits);
    hostNextOffset = page.nextOffset;
    if (hostNextOffset === null || hostHits.length >= requiredHostRows) break;
    hostOffset = hostNextOffset;
  } while (true);

  const nativePage = await nativeSearch;
  const hitsById = new Map<string, SessionSearchPage["hits"][number]>();
  for (const hit of [...hostHits, ...nativePage.hits]) {
    if (!hitsById.has(hit.session.id)) hitsById.set(hit.session.id, hit);
  }
  const merged = [...hitsById.values()].sort(compareHits);
  const end = offset + SEARCH_PAGE_SIZE;
  const hits = merged.slice(offset, end);
  const hasMore = merged.length > end || hostNextOffset !== null;

  return {
    hits,
    nextOffset: hasMore ? end : null,
  };
}
