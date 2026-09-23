/**
 * Skill market source aggregation without Electron I/O.
 *
 * Catalog JSON sources and GitHub repo auto-scans share one request function
 * (the public-HTTPS client). One failing source only costs itself.
 */
import {
  PUBLIC_NETWORK_POLICY_ERROR,
  isProxyFakeIpAddress,
  isSafePublicHttpsUrl,
  isSafeSkillSourceUrl,
  publicNetworkRefusalDetail,
  sanitizeSkillCatalogId,
  splitSkillDocument,
  validateSkillCatalogFile,
  type EndpointOrigin,
  type PublicNetworkAddressKind,
  type PublicNetworkRefusalReason,
  type PublicNetworkRoute,
  type SkillCatalogCategory,
  type SkillCatalogEntry,
  type SkillMarketSource,
  type SourcedSkillEntry,
} from "@pi-desktop/shared";

export type CatalogRequest = (
  url: string,
  kind: "json" | "text",
  origin?: EndpointOrigin,
) => Promise<unknown>;

/**
 * Why a source failed. `policy` means the guard judged an address (or the URL
 * itself) and refused it, and the address is the target's own. `fake-ip` is a
 * refusal of an address the *local proxy* invented for the name — Clash's
 * `198.18.0.0/15`, refused exactly as any other non-public address, but a
 * condition of the local network rather than a fact about the source.
 * `unresolved` means the local resolver produced no answer at all, so nothing
 * was judged — also an environment condition, and likewise never an
 * address-check block. `network` is everything else (issue #419).
 */
export type SkillMarketFailureKind = "policy" | "fake-ip" | "unresolved" | "network";

/** Everything the panel and the log may say about one failed source. */
export type SkillMarketFailureDetail = {
  kind: SkillMarketFailureKind;
  /**
   * The host that actually failed. For a GitHub scan that is `api.github.com`
   * or `cdn.jsdelivr.net`, not the repository URL the user typed, so the
   * diagnostics name the host the guard really refused.
   */
  host?: string;
  /** The guard's structured reason, when a guard refusal produced this. */
  reason?: PublicNetworkRefusalReason;
  /**
   * The address the guard resolved `host` to, when a policy check judged one.
   * This is the local resolver's answer — not user input, not a URL component —
   * and it is the most diagnostic field a refusal has: `198.18.0.1` reads as a
   * proxy in fake-IP mode at a glance, which is exactly the case issue #419 is
   * about. Only a well-formed IP literal is carried (see
   * `publicNetworkRefusalDetail`).
   */
  address?: string;
  /**
   * The class of that address — `benchmark` for a TUN fake-IP, `private` for
   * RFC1918, `loopback` for a redirect to localhost. The class is what a caller
   * decides on; the address is what the user recognises.
   */
  addressKind?: PublicNetworkAddressKind;
  /**
   * The route the guard judged the failing address on, when the transport could
   * name one. A fake-IP answer is tolerated on a proxied route because this app
   * never dials it, and refused on a direct or unreadable one because it would
   * (ADR 0272).
   */
  route?: PublicNetworkRoute;
};

export type SkillMarketSearchResult = {
  entries: SourcedSkillEntry[];
  failedSources: string[];
  /**
   * `failedSources` alone cannot tell the user why the market went quiet. Keyed
   * by the same display name so the panel can explain a policy refusal apart
   * from a source that is merely unreachable, or from a host the *local
   * resolver* never answered. Repeated names collapse, exactly as they already
   * do in `failedSources`, keeping the most specific explanation.
   */
  failureKinds: Record<string, SkillMarketFailureKind>;
  /**
   * The same keys as `failureKinds`, with the host and the structured reason —
   * what the panel and the diagnostics log need to name the refused host
   * instead of just the source label (issue #419).
   */
  failureDetails: Record<string, SkillMarketFailureDetail>;
};

export type SkillMarketDocument = {
  name?: string;
  description?: string;
  body: string;
  resources?: Array<{ path: string; body: string }>;
};

const CACHE_TTL_MS = 5 * 60_000;
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/;
const JSDELIVR_GH = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/]+)@([^/]+)\/(.+)$/;
const SKILL_FILE = /(?:^|\/)SKILL\.md$/;

/**
 * Why a request failed, exported so the IPC boundary and the aggregator share
 * one classifier instead of re-deriving it (issue #419).
 */
export function classifySkillMarketFailure(error: unknown): SkillMarketFailureKind {
  // Structural check so this module keeps no dependency on the client's
  // `node:dns` import and stays testable as a pure module. A refusal that
  // cannot name its reason is still a refusal, so it stays `policy`.
  const refusal = publicNetworkRefusalDetail(error);
  if (!refusal) return "network";
  if (refusal.reason === "resolve-failed") return "unresolved";
  // A fake-IP answer is refused like any other non-public address, but the
  // address is the *proxy's* placeholder for the name rather than the target's
  // own, so it gets its own cause and its own advice (issue #419).
  if (refusal.reason === "non-public-address" && isProxyFakeIpAddress(refusal.addressKind)) {
    return "fake-ip";
  }
  return "policy";
}

/**
 * Bare hostname for a diagnostics record, or undefined when the URL cannot be
 * parsed. Never a path, query, port or credential: a catalog source URL is
 * user-supplied and the log line only needs to name the host that was refused.
 */
export function skillMarketHost(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The diagnostics payload for one failed source. Built here, not at the call
 * site, so the shape is unit-testable without Electron and so every failure
 * record carries the same fields.
 */
export function skillMarketFailureDetail(
  source: { name?: unknown; url?: unknown },
  error: unknown,
): { source?: string; host?: string; kind: SkillMarketFailureKind } & Omit<
  SkillMarketFailureDetail,
  "kind" | "host"
> {
  const refusal = publicNetworkRefusalDetail(error);
  // A guard refusal knows the host it was classifying, which is the host that
  // actually failed. The source URL is only a fallback: a GitHub `owner/repo`
  // source is scanned through `api.github.com`, and naming the repository's
  // host there would point the user at a host that was never refused.
  const host = refusal?.host ?? skillMarketHost(source.url);
  return {
    ...(typeof source.name === "string" && source.name ? { source: source.name } : {}),
    ...(host ? { host } : {}),
    kind: classifySkillMarketFailure(error),
    ...(refusal ? { reason: refusal.reason } : {}),
    ...(refusal?.address ? { address: refusal.address } : {}),
    ...(refusal?.addressKind ? { addressKind: refusal.addressKind } : {}),
    ...(refusal?.route ? { route: refusal.route } : {}),
  };
}

/** The most specific explanation wins when one display name maps to two sources. */
const FAILURE_RANK: Record<SkillMarketFailureKind, number> = {
  network: 0,
  unresolved: 1,
  "fake-ip": 2,
  policy: 3,
};

const SKILL_CATEGORY_KEYWORDS: ReadonlyArray<readonly [SkillCatalogCategory, string[]]> = [
  ["data", ["data", "sql", "database", "postgres", "mongo", "redis", "analytics", "dataset", "spreadsheet", "excel", "xlsx", "csv", "dashboard", "chart", "visualization"]],
  ["workflow", ["workflow", "review", "planning", "brainstorm", "checklist", "process", "sop", "handoff", "standup", "retro", "discernment", "verification", "triage", "audit", "security", "incident"]],
  ["coding", ["code", "test", "debug", "api", "git-", "dev", "engineer", "typescript", "python", "react", "frontend", "backend", "refactor", "deploy", "lint", "mcp", "agent", "artifact", "script", "automation", "cli"]],
  ["writing", ["writing", "write", "writer", "comms", "email", "blog", "content", "copy", "editorial", "story", "blogpost", "article", "newsletter", "social-media", "summar", "art", "design", "creative", "gif", "image", "poster", "diagram", "logo", "typography", "mentor"]],
  ["docs", ["doc", "pdf", "pptx", "docx", "word", "slide", "presentation", "report", "wiki", "manual", "guide", "readme", "changelog", "brand", "canvas", "theme"]],
];

export function guessSkillCategories(path: string): SkillCatalogCategory[] {
  const haystack = path.toLowerCase();
  for (const [category, keywords] of SKILL_CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return [category];
    }
  }
  return ["workflow"];
}

export function createSkillMarketAggregator(
  request: CatalogRequest,
  policy: { allowInsecureUserEndpoints?: boolean | (() => boolean) } = {},
) {
  const catalogCache = new Map<string, { at: number; entries: SourcedSkillEntry[] }>();
  const documentCache = new Map<string, { at: number; document: SkillMarketDocument }>();

  async function fetchJson<T>(url: string, origin?: EndpointOrigin): Promise<T> {
    return (await request(url, "json", origin)) as T;
  }

  async function fetchText(url: string, origin?: EndpointOrigin): Promise<string> {
    return (await request(url, "text", origin)) as string;
  }

  /** Whether the stored policy accepts a plaintext hop to the user's own host. */
  function insecureUserEndpointsAllowed(): boolean {
    return typeof policy.allowInsecureUserEndpoints === "function"
      ? policy.allowInsecureUserEndpoints()
      : policy.allowInsecureUserEndpoints === true;
  }

  async function loadCatalog(source: SkillMarketSource): Promise<SourcedSkillEntry[]> {
    const hit = catalogCache.get(source.url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const body = await fetchJson<unknown>(source.url, "user");
    const { catalog } = validateSkillCatalogFile(body);
    const entries = catalog.skills.map((entry) => ({
      ...entry,
      id: sanitizeSkillCatalogId(entry.id, `skill-${source.id}`),
      sourceId: source.id,
    }));
    catalogCache.set(source.url, { at: Date.now(), entries });
    return entries;
  }

  async function loadGithubRepo(source: SkillMarketSource): Promise<SourcedSkillEntry[]> {
    const hit = catalogCache.get(source.url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries;
    const match = GITHUB_REPO.exec(source.url.split("?")[0]);
    if (!match) throw new Error(`not a GitHub repo url: ${source.url}`);
    const [, owner, repo] = match;
    const repoInfo = await fetchJson<{ default_branch?: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
      "user",
    );
    const branch = repoInfo.default_branch || "main";
    const tree = await fetchJson<{ tree?: Array<{ path: string }> }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      "user",
    );
    const entries: SourcedSkillEntry[] = [];
    const seen = new Set<string>();
    for (const path of (tree.tree ?? []).map((item) => item.path)) {
      if (!path.endsWith("SKILL.md") || path.startsWith("template/")) continue;
      const dir = path.replace(/\/SKILL\.md$/, "");
      const rawSlug = dir.split("/").pop() || `skill-${entries.length}`;
      const id = sanitizeSkillCatalogId(rawSlug, `skill-${entries.length}`);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        name: rawSlug,
        author: owner,
        homepage: `https://github.com/${owner}/${repo}/tree/${branch}/${dir}`,
        url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
        categories: guessSkillCategories(`${dir} ${rawSlug}`),
        sourceId: source.id,
      });
    }
    catalogCache.set(source.url, { at: Date.now(), entries });
    return entries;
  }

  function loadSource(source: SkillMarketSource): Promise<SourcedSkillEntry[]> {
    return GITHUB_REPO.test(source.url.split("?")[0]) ? loadGithubRepo(source) : loadCatalog(source);
  }

  async function fetchDocument(url: string): Promise<SkillMarketDocument> {
    const hit = documentCache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.document;
    const document = splitSkillDocument(await fetchText(url, "third-party")) as SkillMarketDocument;
    const match = JSDELIVR_GH.exec(url);
    if (match) {
      const [, owner, repo, ref, path] = match;
      const dir = path.replace(/SKILL\.md$/, "");
      try {
        const listing = (await fetchJson<{ files?: Array<{ name: string }> }>(
          `https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${ref}?structure=flat`,
          "third-party",
        )) as { files?: Array<{ name: string }> };
        const siblings = (listing.files ?? [])
          .map((file) => file.name)
          .filter((name) => name.startsWith(dir) && !SKILL_FILE.test(name) && name.endsWith(".md"));
        const resources: Array<{ path: string; body: string }> = [];
        for (const name of siblings.slice(0, 20)) {
          resources.push({
            path: name.slice(dir.length),
            body: await fetchText(
              `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${name}`,
              "third-party",
            ),
          });
        }
        if (resources.length) document.resources = resources;
      } catch {
        // A listing failure degrades to the single document, never blocks.
      }
    }
    documentCache.set(url, { at: Date.now(), document });
    return document;
  }

  async function search(query: string, sources: SkillMarketSource[]): Promise<SkillMarketSearchResult> {
    const trimmed = query.trim().toLocaleLowerCase();
    // A source URL the user typed may be a LAN or loopback catalog; plain http
    // needs the stored opt-in. Plaintext never reaches a document URL.
    const sourceOptions = { allowInsecureHttp: insecureUserEndpointsAllowed() };
    const usable = sources.filter((source) => isSafeSkillSourceUrl(source.url, sourceOptions));
    // A source the syntactic guard never let out is a policy refusal, not a
    // transport failure, and it must not be reported as an unreachable host.
    const refused = sources.filter((source) => !isSafeSkillSourceUrl(source.url, sourceOptions));
    const failedSources = refused.map((source) => source.name);
    // Two sources can carry the same display name (a default source and a user
    // source with the same label), and `failedSources` already cannot tell such
    // a pair apart. The most specific explanation is the one worth surfacing,
    // so `FAILURE_RANK` decides the merge. A `Map` plus `Object.fromEntries`
    // also keeps a source called `__proto__` from disappearing into the
    // prototype.
    const details = new Map<string, SkillMarketFailureDetail>();
    const markFailure = (name: string, detail: SkillMarketFailureDetail) => {
      const current = details.get(name);
      if (!current || FAILURE_RANK[detail.kind] > FAILURE_RANK[current.kind]) {
        details.set(name, detail);
      }
    };
    for (const source of refused) {
      // Nothing left the process, so the syntactic check is the reason and the
      // source URL is the only host this refusal is allowed to name.
      const host = skillMarketHost(source.url);
      markFailure(source.name, {
        kind: "policy",
        reason: "url-syntax",
        ...(host ? { host } : {}),
      });
    }
    const settled = await Promise.allSettled(
      usable.map(async (source) => {
        const entries = await loadSource(source);
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
        const source = usable[index];
        failedSources.push(source.name);
        const refusal = publicNetworkRefusalDetail(result.reason);
        const host = refusal?.host ?? skillMarketHost(source.url);
        markFailure(source.name, {
          kind: classifySkillMarketFailure(result.reason),
          ...(host ? { host } : {}),
          ...(refusal ? { reason: refusal.reason } : {}),
          ...(refusal?.address ? { address: refusal.address } : {}),
          ...(refusal?.addressKind ? { addressKind: refusal.addressKind } : {}),
          ...(refusal?.route ? { route: refusal.route } : {}),
        });
        return;
      }
      for (const entry of result.value) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
    });
    return {
      entries,
      failedSources,
      failureKinds: Object.fromEntries([...details].map(([name, detail]) => [name, detail.kind])),
      failureDetails: Object.fromEntries(details),
    };
  }

  async function fetchEntryDocument(entry: SkillCatalogEntry): Promise<SkillMarketDocument> {
    // A document URL arrives inside a catalog the app did not receive from the
    // user, so it keeps the public-only policy even when the source itself is a
    // LAN catalog the user added.
    if (!isSafePublicHttpsUrl(entry.url)) {
      // A document URL the syntactic guard refuses is a decision about the URL,
      // not a dead host. Carrying the shared name and reason means the one
      // classifier reports it as the policy refusal it is, instead of telling
      // the user the document was unreachable.
      throw Object.assign(new Error("document url must be a public https address"), {
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "url-syntax" satisfies PublicNetworkRefusalReason,
      });
    }
    return fetchDocument(entry.url);
  }

  return { search, fetchEntryDocument };
}
