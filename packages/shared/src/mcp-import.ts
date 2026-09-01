import type { McpServerInput } from "./types.js";

/**
 * Parse a pasted MCP configuration block into server drafts.
 *
 * Every MCP client in circulation writes some variant of the same JSON, so the
 * paste box accepts what the user already has rather than asking them to
 * retype it: a full `{"mcpServers": {...}}` document, the bare map inside it, or
 * a single server object. Keys become ids, `command`/`args`/`env` mean stdio,
 * and `url` means http.
 */
export type McpImportResult = {
  servers: McpServerInput[];
  /** Entries that were understood but rejected, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
};

const MAX_ENTRIES = 32;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Turn a config key into an id host-core will accept. */
export function mcpImportId(key: string, index: number): string {
  const cleaned = key.trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+/, "");
  const id = cleaned.slice(0, 64);
  return /^[a-zA-Z]/.test(id) ? id : `server-${index + 1}`;
}

function toInput(id: string, raw: Record<string, unknown>): McpServerInput | string {
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  // `type`/`transport` are advisory: what the entry actually carries decides,
  // because half the configs in the wild omit the field entirely.
  const declared =
    typeof raw.type === "string"
      ? raw.type.toLowerCase()
      : typeof raw.transport === "string"
        ? raw.transport.toLowerCase()
        : "";
  const wantsHttp = url ? true : declared.includes("http") || declared.includes("sse");
  if (wantsHttp) {
    if (!url) return "an http server requires url";
    return { id, label, description, transport: "http", url, headers: stringMap(raw.headers) };
  }
  if (!command) return "a stdio server requires command";
  return {
    id,
    label,
    description,
    transport: "stdio",
    command,
    args: stringList(raw.args) ?? [],
    env: stringMap(raw.env) ?? {},
  };
}

export function parseMcpImport(text: string): McpImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  const root = asRecord(parsed);
  if (!root) throw new Error("expected a JSON object");

  // `{"mcpServers": {...}}`, `{"servers": {...}}`, the bare map, or one server.
  const container =
    asRecord(root.mcpServers) ?? asRecord(root.servers) ?? (isServerLike(root) ? null : root);
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (container) {
    for (const [key, value] of Object.entries(container)) {
      const record = asRecord(value);
      if (record) entries.push([key, record]);
    }
  } else {
    const id = typeof root.id === "string" ? root.id : "server";
    entries.push([id, root]);
  }
  if (!entries.length) throw new Error("no MCP servers found");

  const servers: McpServerInput[] = [];
  const skipped: McpImportResult["skipped"] = [];
  entries.slice(0, MAX_ENTRIES).forEach(([key, raw], index) => {
    const id = mcpImportId(key, index);
    if (raw.disabled === true) {
      skipped.push({ id, reason: "marked disabled" });
      return;
    }
    const result = toInput(id, raw);
    if (typeof result === "string") skipped.push({ id, reason: result });
    else servers.push(result);
  });
  for (const [key, _raw] of entries.slice(MAX_ENTRIES)) {
    skipped.push({ id: key, reason: `over the ${MAX_ENTRIES} server import limit` });
  }
  return { servers, skipped };
}

/** A bare single-server object, rather than a map of them. */
function isServerLike(root: Record<string, unknown>): boolean {
  return (
    typeof root.command === "string" ||
    typeof root.url === "string" ||
    typeof root.transport === "string"
  );
}

/** Whether an endpoint is on this machine, for UI risk messaging. */
export function isLoopbackMcpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Whether a valid-looking endpoint uses unencrypted HTTP outside loopback. */
export function isNonLoopbackHttpMcpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && !isLoopbackMcpUrl(url);
}
