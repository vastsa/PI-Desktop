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
 * cursor, so the host prefix has to be long enough to make the merged ordering
 * deterministic.
 *
 * That prefix is requested in one host call per page rather than one call per
 * already-emitted page. Walking it thirty rows at a time issued
 * `offset / 30 + 1` calls for page `offset / 30` — quadratic in the number of
 * pages — and the statement behind them aggregates the whole `messages` table
 * regardless of `OFFSET`, so every one of those calls paid a full scan. The
 * host clamps a single request to a bounded prefix, so the loop below asks only
 * for the rows it is still missing: one call for every prefix that cap covers.
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
  while (hostHits.length < requiredHostRows) {
    const page = await host.call<SessionSearchPage>("search.sessions", {
      ...request,
      // Rows come back in one stable global order, so the number already
      // accumulated is the offset of the next missing row.
      offset: hostHits.length,
      limit: requiredHostRows - hostHits.length,
    });
    hostHits.push(...page.hits);
    hostNextOffset = page.nextOffset;
    // A short page means the host ran out, and `nextOffset` is null with it.
    if (hostNextOffset === null || page.hits.length === 0) break;
  }

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
