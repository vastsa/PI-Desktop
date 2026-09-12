/**
 * Shared vocabulary for the MCP market surface.
 *
 * A market entry is a *template* for a user MCP server: browse, fill in a few
 * values, and it becomes a regular `McpServerInput` that goes through the
 * existing upsert path. Nothing here performs I/O, so the renderer ships the
 * builtin catalog and a later main-process fetch layer shares the same rules.
 */
import type { McpServerInput } from "./types.js";

export type McpCatalogCategory = "devtools" | "web" | "docs" | "data" | "productivity";

/** One value the install template may need, surfaced as a form row. */
export type McpCatalogRequiredEnv = {
  name: string;
  description?: string;
  optional?: boolean;
  /** Prefilled in the install form; explicit values win over it. */
  defaultValue?: string;
};

export type McpCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  categories?: McpCatalogCategory[];
  verified?: boolean;
  transport: "stdio" | "http";
  /** stdio template. `${NAME}` placeholders allowed throughout. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http template. Catalog endpoints must be https; http stays a manual choice. */
  url?: string;
  headers?: Record<string, string>;
  requiredEnv?: McpCatalogRequiredEnv[];
  prerequisites?: string[];
  notes?: string;
};

export type McpCatalogFile = {
  schemaVersion: 1;
  updatedAt: string;
  source: "builtin";
  servers: McpCatalogEntry[];
};

const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function templateStrings(entry: McpCatalogEntry): string[] {
  if (entry.transport === "http") {
    return [entry.url ?? "", ...Object.values(entry.headers ?? {})];
  }
  return [entry.command ?? "", ...(entry.args ?? []), ...Object.values(entry.env ?? {})];
}

/** Every `${NAME}` the entry's install template needs, deduped and sorted. */
export function collectCatalogPlaceholders(entry: McpCatalogEntry): string[] {
  const names = new Set<string>();
  for (const text of templateStrings(entry)) {
    for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]);
  }
  return [...names].sort();
}

function declaredNames(entry: McpCatalogEntry): Map<string, McpCatalogRequiredEnv> {
  return new Map((entry.requiredEnv ?? []).map((item) => [item.name, item]));
}

/** Client-side mirror of the host rules, plus market-specific template checks. */
export function catalogEntryError(entry: McpCatalogEntry): string | null {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id)) return `bad id: ${entry.id}`;
  if (entry.transport === "stdio") {
    if (!entry.command?.trim()) return `${entry.id}: stdio requires command`;
    if (entry.command.includes("..")) return `${entry.id}: command must not contain ..`;
  } else {
    if (!entry.url) return `${entry.id}: http requires url`;
    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol !== "https:") {
        return `${entry.id}: catalog endpoints must be https`;
      }
    } catch {
      return `${entry.id}: url does not parse`;
    }
  }
  const declared = declaredNames(entry);
  for (const name of collectCatalogPlaceholders(entry)) {
    if (!declared.has(name)) {
      return `${entry.id}: placeholder ${name} is not declared in requiredEnv`;
    }
  }
  return null;
}

/**
 * Turn a catalog entry into a real server input.
 *
 * Missing required values throw with a message the install sheet shows
 * directly; `optional` values that stay empty drop the whole env key so the
 * spawned process sees an unset variable rather than a literal template.
 */
export function resolveCatalogEntry(
  entry: McpCatalogEntry,
  values: Record<string, string> = {},
): McpServerInput {
  const error = catalogEntryError(entry);
  if (error) throw new Error(error);
  const declared = declaredNames(entry);
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (whole, name: string) => {
      const spec = declared.get(name);
      const value = values[name] ?? spec?.defaultValue ?? "";
      if (!value && !spec?.optional) {
        throw new Error(`${entry.name}: missing value for ${name}`);
      }
      return value;
    });
  const base = {
    id: entry.id,
    label: entry.name,
    description: entry.description,
    enabled: true,
  };
  if (entry.transport === "http") {
    const headers: Record<string, string> = {};
    for (const [key, template] of Object.entries(entry.headers ?? {})) {
      const value = fill(template);
      if (value) headers[key] = value;
    }
    return { ...base, transport: "http", url: fill(entry.url!), headers };
  }
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(entry.env ?? {})) {
    const value = fill(template);
    if (value) env[key] = value;
  }
  return {
    ...base,
    transport: "stdio",
    command: fill(entry.command!),
    args: (entry.args ?? []).map((arg) => fill(arg)),
    env,
  };
}

/** Lenient parse: bad entries become warnings instead of a failed load. */
export function validateMcpCatalogFile(value: unknown): {
  catalog: McpCatalogFile;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawServers = Array.isArray(root.servers) ? root.servers : [];
  if (!Array.isArray(root.servers)) warnings.push("catalog has no servers array");
  const servers: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of rawServers.entries()) {
    const entry = candidate as McpCatalogEntry;
    if (!entry || typeof entry !== "object") {
      warnings.push(`entry ${index} is not an object`);
      continue;
    }
    if (seen.has(entry.id)) {
      warnings.push(`duplicate id: ${entry.id}`);
      continue;
    }
    const error = catalogEntryError(entry);
    if (error) {
      warnings.push(error);
      continue;
    }
    seen.add(entry.id);
    servers.push(entry);
  }
  return {
    catalog: {
      schemaVersion: 1,
      updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : "",
      source: "builtin",
      servers,
    },
    warnings,
  };
}
