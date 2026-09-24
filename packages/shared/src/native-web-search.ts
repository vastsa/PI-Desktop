import { nativeWebSearchTransport } from "./native-web-search-transport.js";

/**
 * Evaluation helpers for the provider-hosted web search tool.
 *
 * - `nativeWebSearchSupportedOn` gates the settings checkbox. It accepts
 *   stored apiStyle (`responses`, `openai_codex_responses`, `anthropic_messages`)
 *   and resolved wire APIs (`openai-responses`, `openai-codex-responses`,
 *   `azure-openai-responses`, `anthropic-messages`).
 * - `resolveNativeWebSearch` is the runtime decision: capable wire AND the
 *   binding opt-in. Adapters then key on `model.webSearch`, which
 *   `modelConfigWithBinding` copies from that opt-in.
 * - `hostedSearchFromMessage` is what the runtime persists: display rounds
 *   plus raw `replay` blocks for convertMessages after a restart.
 *
 * Published official endpoint routes are resolved before the wire gate, using
 * nativeWebSearchTransport. Vendor display names and model-id substrings never
 * establish endpoint support. Unknown gateways retain their configured wire.
 */

export const NATIVE_WEB_SEARCH_WIRE_APIS = new Set([
  "anthropic-messages",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

/** Tool definition attached to an anthropic-messages request. */
export const ANTHROPIC_WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
} as const;

/** Tool definition attached to OpenAI Responses-compatible requests. */
export const OPENAI_RESPONSES_WEB_SEARCH_TOOL = {
  type: "web_search",
} as const;

export type NativeWebSearchDecision = "on" | "off";

export function resolveNativeWebSearch(input: {
  wireApi: string;
  modelWebSearch?: boolean;
}): NativeWebSearchDecision {
  const wire = input.wireApi.trim().toLowerCase();
  if (!NATIVE_WEB_SEARCH_WIRE_APIS.has(wire)) return "off";
  return input.modelWebSearch === true ? "on" : "off";
}

/** The tool definition a wire API expects, or undefined when unsupported. */
export function nativeWebSearchToolFor(
  wireApi: string,
):
  | { type: "web_search_20250305"; name: "web_search" }
  | { type: "web_search" }
  | undefined {
  const wire = wireApi.trim().toLowerCase();
  if (wire === "anthropic-messages") return { ...ANTHROPIC_WEB_SEARCH_TOOL };
  if (
    wire === "openai-responses" ||
    wire === "azure-openai-responses" ||
    wire === "openai-codex-responses"
  ) {
    return { ...OPENAI_RESPONSES_WEB_SEARCH_TOOL };
  }
  return undefined;
}

const NATIVE_WEB_SEARCH_API_STYLES = new Set(["responses", "anthropic_messages", "openai_codex_responses"]);

/**
 * Whether a stored apiStyle or a resolved wire API can carry the hosted
 * search tool. Settings UI gates the checkbox with this; it accepts both
 * spellings because the pane sees `responses` / `anthropic_messages` while
 * the runtime sees `openai-responses` / `anthropic-messages`.
 */
export function nativeWebSearchSupportedOn(api: string | undefined, baseUrl?: string): boolean {
  const route = nativeWebSearchTransport({ apiStyle: api, baseUrl, enabled: true });
  const value = (route.apiStyle ?? "").trim().toLowerCase();
  if (!value) return false;
  if (NATIVE_WEB_SEARCH_WIRE_APIS.has(value)) return true;
  if (NATIVE_WEB_SEARCH_API_STYLES.has(value)) return true;
  return NATIVE_WEB_SEARCH_WIRE_APIS.has(value.replace(/_/g, "-"));
}

/**
 * Capture the adapter's hostedSearch content parts for convertMessages
 * replay. Streaming scratch (`index`, `inputJson`) is dropped; unknown
 * shapes are ignored. Display normalization is `hostedSearchFromBlocks`.
 */
export function hostedSearchReplayBlocks(
  content: unknown,
): import("./types/messages.js").HostedSearchReplayBlock[] {
  if (!Array.isArray(content)) return [];
  const replay: import("./types/messages.js").HostedSearchReplayBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "hostedSearch") continue;
    const phase = typeof block.phase === "string" ? block.phase.trim() : "";
    if (!phase) continue;
    const next: import("./types/messages.js").HostedSearchReplayBlock = {
      type: "hostedSearch",
      phase,
    };
    if (typeof block.blockId === "string" && block.blockId) next.blockId = block.blockId;
    if (typeof block.name === "string" && block.name) next.name = block.name;
    if (block.input !== undefined) next.input = block.input;
    if (typeof block.status === "string") next.status = block.status;
    if (block.isError === true) next.isError = true;
    if (block.wire && typeof block.wire === "object") next.wire = block.wire;
    replay.push(next);
  }
  return replay;
}

/**
 * Display rounds plus replay payload. Runtime persistence and stream
 * updates go through this so a restart can rebuild the same content
 * parts convertMessages expects.
 */
export function hostedSearchFromMessage(input: {
  content: unknown;
  citations?: unknown;
}): import("./types/messages.js").HostedSearch | undefined {
  const search = hostedSearchFromBlocks(input);
  if (!search) return undefined;
  const replay = hostedSearchReplayBlocks(input.content);
  return replay.length > 0 ? { ...search, replay } : search;
}

/**
 * Normalize pi-ai hostedSearch content blocks and message citations into the
 * shared `HostedSearch` shape: one round per provider search call, in block
 * order. Input is untrusted provider data: every field is shape-checked and
 * unknown shapes are ignored, never thrown.
 *
 * Round pairing:
 * - anthropic-messages emits a `server_tool_use` block (query) followed by a
 *   `web_search_tool_result` block (sources); both carry the same blockId.
 * - openai-responses emits one `web_search_call` block per call; status and
 *   the action payload live on the preserved wire item.
 * Citation annotations belong to the message, not a round; citation-only URLs
 * fold into the most recent round so they still render exactly once.
 */
export function hostedSearchFromBlocks(input: {
  content: unknown;
  citations?: unknown;
}): import("./types/messages.js").HostedSearch | undefined {
  const blocks = Array.isArray(input.content) ? input.content : [];
  const rounds: import("./types/messages.js").HostedSearchRound[] = [];
  const byId = new Map<string, import("./types/messages.js").HostedSearchRound>();

  const roundFor = (
    id: unknown,
    fallback: string,
    create: boolean,
  ): import("./types/messages.js").HostedSearchRound | undefined => {
    const key = typeof id === "string" && id ? id : fallback;
    const existing = byId.get(key);
    if (existing) return existing;
    if (!create) return undefined;
    const round: import("./types/messages.js").HostedSearchRound = {
      id: key,
      status: "searching",
      sources: [],
    };
    byId.set(key, round);
    rounds.push(round);
    return round;
  };

  for (let index = 0; index < blocks.length; index++) {
    const part = blocks[index];
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: string;
      phase?: string;
      blockId?: unknown;
      name?: unknown;
      isError?: boolean;
      status?: string;
      input?: unknown;
      wire?: unknown;
    };
    if (block.type !== "hostedSearch") continue;
    const wire =
      block.wire && typeof block.wire === "object"
        ? (block.wire as Record<string, unknown>)
        : undefined;

    if (block.phase === "server_tool_use") {
      // The round stays "searching" until its result block lands.
      const round = roundFor(block.blockId, `anon-${index}`, true);
      if (!round) continue;
      // web_fetch is the Anthropic open-page call: it carries a url, no query.
      if (block.name === "web_fetch") {
        round.kind = "openPage";
        const inputUrl = (value: unknown) =>
          value && typeof value === "object"
            ? hostedSearchUrl((value as Record<string, unknown>).url)
            : undefined;
        const url = inputUrl(block.input) ?? inputUrl(wire?.input);
        if (url && !round.url) round.url = url;
        continue;
      }
      const query = hostedSearchQuery(wire, block.phase, block.input);
      if (query && !round.query) round.query = query;
      continue;
    }

    if (block.phase === "web_search_tool_result") {
      // A result whose id matches no call pairs with the latest open round;
      // a gateway that drops ids still renders one row per round.
      const round =
        roundFor(block.blockId, "", false) ??
        [...rounds].reverse().find((r) => r.status === "searching") ??
        roundFor(undefined, `anon-${index}`, true);
      if (!round) continue;
      round.status = block.isError === true || block.status === "failed"
        ? "failed"
        : "completed";
      collectHostedSearchSources(wire, round.sources);
      continue;
    }

    if (block.phase === "web_search_call") {
      const round = roundFor(block.blockId, `anon-${index}`, true);
      if (!round) continue;
      const status = typeof block.status === "string" ? block.status : wireStatus(wire);
      round.status =
        status === "completed"
          ? "completed"
          : status === "failed" || block.isError === true
            ? "failed"
            : "searching";
      // Responses actions: `search` carries a query, `open_page` a url,
      // `find_in_page` both. Items can arrive action-less mid-stream, so the
      // kind lands whenever the action finally does.
      const action =
        wire && typeof wire.action === "object" && wire.action !== null
          ? (wire.action as Record<string, unknown>)
          : undefined;
      if (action?.type === "open_page") round.kind = "openPage";
      else if (action?.type === "find_in_page") round.kind = "findInPage";
      const url = hostedSearchUrl(action?.url);
      if (url && !round.url && (round.kind === "openPage" || round.kind === "findInPage")) {
        round.url = url;
      }
      const query = hostedSearchQuery(wire, block.phase, block.input);
      if (query && !round.query) round.query = query;
      collectHostedSearchSources(wire, round.sources);
      continue;
    }
  }

  if (rounds.length === 0) return undefined;

  const citations = Array.isArray(input.citations) ? input.citations : [];
  const last = rounds[rounds.length - 1];
  for (const citation of citations) {
    if (!citation || typeof citation !== "object") continue;
    const c = citation as { url?: unknown; title?: unknown };
    if (typeof c.url !== "string" || !/^https?:\/\//i.test(c.url)) continue;
    if (rounds.some((r) => r.sources.some((s) => s.url === c.url))) continue;
    last.sources.push({
      url: c.url,
      ...(typeof c.title === "string" && c.title.trim() ? { title: c.title } : {}),
    });
  }

  return {
    status: rounds.some((r) => r.status === "failed")
      ? "failed"
      : rounds.some((r) => r.status === "searching")
        ? "searching"
        : "completed",
    rounds,
  };
}

/**
 * Read the rounds of a persisted/streamed `HostedSearch`, tolerating the v1
 * aggregate shape (`queries`/`sources`, no rounds) written by development
 * builds before per-round rows existed. Such transcripts collapse to a single
 * legacy round instead of losing the row entirely.
 */
export function hostedSearchRounds(
  search: import("./types/messages.js").HostedSearch | undefined,
): import("./types/messages.js").HostedSearchRound[] {
  if (!search || typeof search !== "object") return [];
  const rounds = (search as { rounds?: unknown }).rounds;
  if (Array.isArray(rounds)) {
    return rounds.filter(
      (r): r is import("./types/messages.js").HostedSearchRound =>
        !!r && typeof r === "object",
    );
  }
  const legacy = search as { queries?: unknown; sources?: unknown };
  const queries = Array.isArray(legacy.queries) ? legacy.queries : [];
  const sources = Array.isArray(legacy.sources) ? legacy.sources : [];
  if (queries.length === 0 && sources.length === 0) return [];
  return [
    {
      id: "legacy",
      status: search.status === "failed" ? "failed" : "completed",
      ...(typeof queries[0] === "string" && queries[0] ? { query: queries[0] } : {}),
      sources: sources.filter(
        (s): s is import("./types/messages.js").HostedSearchSource =>
          !!s && typeof s === "object" && typeof (s as { url?: unknown }).url === "string",
      ),
    },
  ];
}

function hostedSearchUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value)
    ? value
    : undefined;
}

function wireStatus(wire: Record<string, unknown> | undefined): string | undefined {
  if (!wire) return undefined;
  return typeof wire.status === "string" ? wire.status : undefined;
}

function hostedSearchQuery(
  wire: Record<string, unknown> | undefined,
  phase: string | undefined,
  input: unknown,
): string | undefined {
  // `query` is the Anthropic/OpenAI field; gateways that relay to a native
  // search tool (GLM web_search_prime et al.) may name it `search_query`.
  const inputRecord =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  const fromInput = inputRecord?.query ?? inputRecord?.search_query;
  if (typeof fromInput === "string" && fromInput.trim()) {
    return fromInput.trim();
  }
  if (!wire) return undefined;
  const action = wire.action as Record<string, unknown> | undefined;
  const query =
    action && typeof action === "object" && typeof action.query === "string"
      ? action.query
      : action && typeof action === "object" && typeof action.pattern === "string"
        ? action.pattern
        : typeof wire.query === "string"
          ? wire.query
          : undefined;
  if (query && query.trim()) return query.trim();
  // Anthropic server_tool_use input carries the query.
  const wireInput = wire.input as Record<string, unknown> | undefined;
  if (phase === "server_tool_use" && wireInput) {
    const wireQuery = wireInput.query ?? wireInput.search_query;
    if (typeof wireQuery === "string") return wireQuery.trim() || undefined;
  }
  return undefined;
}

function collectHostedSearchSources(
  wire: Record<string, unknown> | undefined,
  sources: { url: string; title?: string }[],
): void {
  if (!wire) return;
  const action = wire.action as Record<string, unknown> | undefined;
  const candidates = [
    ...(Array.isArray(wire.results) ? wire.results : []),
    ...(Array.isArray(wire.sources) ? wire.sources : []),
    ...(Array.isArray(wire.search_results) ? wire.search_results : []),
    // Anthropic web_search_tool_result carries web_search_result entries.
    ...(Array.isArray(wire.content) ? wire.content : []),
    // OpenAI Responses nests sources under the search action.
    ...(action && Array.isArray(action.sources) ? action.sources : []),
    ...(action && Array.isArray(action.results) ? action.results : []),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as { url?: unknown; uri?: unknown; title?: unknown };
    const url =
      typeof entry.url === "string"
        ? entry.url
        : typeof entry.uri === "string"
          ? entry.uri
          : undefined;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (sources.some((s) => s.url === url)) continue;
    sources.push({
      url,
      ...(typeof entry.title === "string" && entry.title.trim()
        ? { title: entry.title }
        : {}),
    });
  }
}
