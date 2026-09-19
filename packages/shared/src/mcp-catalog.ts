/**
 * Shared vocabulary for the MCP market surface.
 *
 * A market entry is a *template* for a user MCP server: browse, fill in a few
 * values, and it becomes a regular `McpServerInput` that goes through the
 * existing upsert path. Nothing here performs I/O, so the renderer ships the
 * builtin catalog and a later main-process fetch layer shares the same rules.
 */
import type { McpServerInput } from "./types.js";
import { isPublicHttpsUrl } from "./public-network.js";

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
  /** http template. Market endpoints must use credentials-free public HTTPS. */
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

/*
 * The builtin catalog and stdio templates spell a variable `${NAME}` in upper
 * case. The official registry spells a header variable `{name}` and does not
 * require upper case, so the header pattern accepts both spellings and consumes
 * the `$`, leaving no stray dollar behind. stdio keeps its own spelling, so a
 * brace pair inside a command or an argument is never rewritten.
 */
const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const HEADER_PLACEHOLDER = /\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CATALOG_CATEGORIES = new Set<McpCatalogCategory>(["devtools", "web", "docs", "data", "productivity"]);

function placeholderPattern(transport: unknown): RegExp {
  return transport === "http" ? HEADER_PLACEHOLDER : ENV_PLACEHOLDER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function requiredEnvError(value: unknown, id: string, transport: unknown): string | null {
  if (!Array.isArray(value)) return `${id}: requiredEnv must be an array`;
  const names = new Set<string>();
  const namePattern = transport === "http" ? VARIABLE_NAME : ENV_NAME;
  for (const item of value) {
    if (!isRecord(item)) return `${id}: requiredEnv items must be objects`;
    if (typeof item.name !== "string" || !namePattern.test(item.name)) {
      return `${id}: requiredEnv names must be variable names`;
    }
    if (names.has(item.name)) return `${id}: duplicate requiredEnv name ${item.name}`;
    names.add(item.name);
    if (item.description !== undefined && typeof item.description !== "string") {
      return `${id}: requiredEnv descriptions must be strings`;
    }
    if (item.optional !== undefined && typeof item.optional !== "boolean") {
      return `${id}: requiredEnv optional must be boolean`;
    }
    if (item.defaultValue !== undefined && typeof item.defaultValue !== "string") {
      return `${id}: requiredEnv defaultValue must be a string`;
    }
  }
  return null;
}

function entryShapeError(value: unknown): string | null {
  if (!isRecord(value)) return "entry is not an object";
  const id = typeof value.id === "string" ? value.id : "unknown";
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id)) return `bad id: ${id}`;
  if (typeof value.name !== "string" || !value.name.trim()) return `${id}: name is required`;
  if (value.transport !== "stdio" && value.transport !== "http") return `${id}: transport is invalid`;

  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories) || !value.categories.every((category) => typeof category === "string" && CATALOG_CATEGORIES.has(category as McpCatalogCategory))) {
      return `${id}: categories must be an array of known categories`;
    }
  }
  if (value.args !== undefined && !isStringArray(value.args)) return `${id}: args must be an array of strings`;
  if (value.env !== undefined && !isStringRecord(value.env)) return `${id}: env must be an object of strings`;
  if (value.headers !== undefined && !isStringRecord(value.headers)) return `${id}: headers must be an object of strings`;
  if (value.prerequisites !== undefined && !isStringArray(value.prerequisites)) return `${id}: prerequisites must be an array of strings`;
  if (value.requiredEnv !== undefined) {
    const error = requiredEnvError(value.requiredEnv, id, value.transport);
    if (error) return error;
  }
  for (const field of ["description", "author", "homepage", "command", "url", "notes"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return `${id}: ${field} must be a string`;
  }
  if (value.verified !== undefined && typeof value.verified !== "boolean") return `${id}: verified must be boolean`;
  return null;
}

function templateStrings(entry: McpCatalogEntry): string[] {
  if (!isRecord(entry)) return [];
  if (entry.transport === "http") {
    return [
      typeof entry.url === "string" ? entry.url : "",
      ...(isStringRecord(entry.headers) ? Object.values(entry.headers) : []),
    ];
  }
  return [
    typeof entry.command === "string" ? entry.command : "",
    ...(isStringArray(entry.args) ? entry.args : []),
    ...(isStringRecord(entry.env) ? Object.values(entry.env) : []),
  ];
}

/** Every `${NAME}` the entry's install template needs, deduped and sorted. */
export function collectCatalogPlaceholders(entry: McpCatalogEntry): string[] {
  const names = new Set<string>();
  const pattern = placeholderPattern(entry.transport);
  for (const text of templateStrings(entry)) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

function declaredNames(entry: McpCatalogEntry): Map<string, McpCatalogRequiredEnv> {
  return new Map((entry.requiredEnv ?? []).map((item) => [item.name, item]));
}

/** Client-side mirror of the host rules, plus market-specific template checks. */
export function catalogEntryError(entry: McpCatalogEntry | unknown): string | null {
  const shapeError = entryShapeError(entry);
  if (shapeError) return shapeError;
  const candidate = entry as McpCatalogEntry;
  if (candidate.transport === "stdio") {
    if (!candidate.command?.trim()) return `${candidate.id}: stdio requires command`;
    if (candidate.command.includes("..")) return `${candidate.id}: command must not contain ..`;
  } else {
    if (!candidate.url) return `${candidate.id}: http requires url`;
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      return `${candidate.id}: url does not parse`;
    }
    if (parsed.protocol !== "https:") return `${candidate.id}: catalog endpoints must be https`;
    if (!isPublicHttpsUrl(candidate.url)) return `${candidate.id}: catalog endpoints must use a public https address`;
  }
  const declared = declaredNames(candidate);
  for (const name of collectCatalogPlaceholders(candidate)) {
    if (!declared.has(name)) return `${candidate.id}: placeholder ${name} is not declared in requiredEnv`;
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
  const pattern = placeholderPattern(entry.transport);
  const fill = (text: string): string =>
    text.replace(pattern, (whole, name: string) => {
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
