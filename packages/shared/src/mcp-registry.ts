/**
 * Adapter from the official MCP Registry (registry.modelcontextprotocol.io)
 * server records to market catalog templates.
 *
 * Pure mapping only — the network lives in the Electron main process, the
 * same split models.dev uses. A record the registry lists but that carries no
 * runnable form (no npm/pypi package and no https remote) maps to null: the
 * market never saves a template it could not start.
 */
import {
  catalogEntryError,
  type McpCatalogCategory,
  type McpCatalogEntry,
  type McpCatalogRequiredEnv,
} from "./mcp-catalog.js";
import { isPublicHttpsUrl } from "./public-network.js";
export { isPublicHostname, isPublicIpLiteral } from "./public-network.js";

export type RegistryEnvVar = {
  name?: string;
  description?: string;
  isRequired?: boolean;
  /** Registry-side fixed value / default: becomes the install form's prefilled value. */
  value?: string;
  default?: string;
};

export type RegistryArgument = {
  type?: string;
  name?: string;
  value?: string;
};

export type RegistryPackage = {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryEnvVar[];
};

/**
 * A registry input: the shape shared by a remote header, a package environment
 * variable and an entry of a header's `variables` map.
 */
export type RegistryInput = {
  description?: string;
  format?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
  default?: string;
  variables?: Record<string, RegistryInput>;
};

export type RegistryRemote = {
  type?: string;
  url?: string;
  headers?: Array<RegistryInput & { name?: string }>;
};

export type RegistryServer = {
  name?: string;
  title?: string;
  description?: string;
  homepage?: string;
  repository?: { url?: string } | string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
};

export type RegistryRecord = { server?: RegistryServer };

/** reverse-DNS registry name → id-safe slug (`com.pulsemcp/foo` → `com-pulsemcp-foo`). */
export function registryIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) return "mcp-server";
  return /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.slice(0, 64);
}

function envSpecs(pkg: RegistryPackage): McpCatalogRequiredEnv[] {
  return (pkg.environmentVariables ?? [])
    .filter((variable): variable is RegistryEnvVar & { name: string } => typeof variable.name === "string" && !!variable.name)
    .map((variable) => ({
      name: variable.name,
      ...(typeof variable.description === "string" && variable.description ? { description: variable.description } : {}),
      ...(variable.isRequired ? {} : { optional: true }),
      ...(typeof variable.value === "string"
        ? { defaultValue: variable.value }
        : typeof variable.default === "string"
          ? { defaultValue: variable.default }
          : {}),
    }));
}

/**
 * Registry arguments split into launcher-level (runtime) and package-level.
 * `named` arguments keep their name (and value); `positional` keep values —
 * so `--port 8080` style flags survive the mapping.
 */
export function argumentValues(
  args?: RegistryArgument[],
): string[] {
  const out: string[] = [];
  for (const argument of args ?? []) {
    if (!argument || typeof argument !== "object") continue;
    const named = argument.type === "named" || (!!argument.name && argument.type !== "positional");
    if (named) {
      if (typeof argument.name === "string" && argument.name) out.push(argument.name);
      if (typeof argument.value === "string" && argument.value) out.push(argument.value);
    } else if (typeof argument.value === "string" && argument.value) {
      out.push(argument.value);
    }
  }
  return out;
}

function envTemplates(pkg: RegistryPackage): Record<string, string> | undefined {
  const names = (pkg.environmentVariables ?? [])
    .filter((variable): variable is RegistryEnvVar & { name: string } => typeof variable.name === "string" && !!variable.name)
    .map((variable) => variable.name);
  return names.length ? Object.fromEntries(names.map((name) => [name, `\${${name}}`])) : undefined;
}

function packageSpecifier(pkg: RegistryPackage, separator: "@" | "=="): string | undefined {
  if (typeof pkg.identifier !== "string" || !pkg.identifier.trim()) return undefined;
  const identifier = pkg.identifier.trim();
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  return version ? `${identifier}${separator}${version}` : identifier;
}

/*
 * The official registry schema wraps a header variable in `{curly_braces}`,
 * spelled without the dollar sign the builtin catalog uses, and it does not
 * require upper-case names. Values in the wild carry both spellings, so the
 * matcher accepts any brace-wrapped identifier and only extracts its name —
 * substitution stays with the caller.
 */
const REMOTE_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function remoteHeaderTemplates(remote: RegistryRemote): {
  headers: Record<string, string>;
  requiredEnv?: McpCatalogRequiredEnv[];
} {
  const headers = Object.fromEntries(
    (remote.headers ?? [])
      .filter((header) => typeof header.name === "string" && !!header.name && typeof header.value === "string")
      .map((header) => [header.name!, header.value!]),
  );
  const declared = new Map<string, RegistryInput>();
  for (const header of remote.headers ?? []) {
    for (const [name, variable] of Object.entries(header.variables ?? {})) {
      if (variable && typeof variable === "object" && !declared.has(name)) declared.set(name, variable);
    }
  }
  const names = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(REMOTE_PLACEHOLDER)) names.add(match[1]);
  }
  const requiredEnv = [...names].sort().map((name) => {
    const variable = declared.get(name);
    return {
      name,
      ...(typeof variable?.description === "string" && variable.description
        ? { description: variable.description }
        : {}),
      ...(variable && variable.isRequired === false ? { optional: true } : {}),
    };
  });
  return { headers, ...(requiredEnv.length ? { requiredEnv } : {}) };
}

/*
 * The registry publishes no taxonomy, but the market's category filters are
 * useless if every remote entry lands in "all" only. This keyword pass is a
 * deliberately cheap guess — wrong-guessing a handful of entries costs less
 * than hiding them from every filter. Order matters: specific families first,
 * docs last because "docker"/"docs" share a prefix.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [McpCatalogCategory, string[]]> = [
  ["data", ["database", "sql", "postgres", "mysql", "mongo", "redis", "sqlite", "dataset", "warehouse", "analytics", "supabase", "snowflake"]],
  ["productivity", ["todo", "task", "calendar", "email", "mail", "remind", "schedule", "slack", "notion", "jira", "linear", "asana", "habit", "time"]],
  ["web", ["search", "scrape", "crawl", "browser", "fetch", "playwright", "puppeteer", "seo", "web", "surf"]],
  ["devtools", ["github", "gitlab", "git ", "docker", "kubernetes", "k8s", "deploy", "terminal", "shell", "code", "repo", "issue", "build", "lint", "test", "ci ", "ide", "api", "sentry", " observability"]],
  ["docs", ["doc", "wiki", "knowledge", "context", "reference", "manual", "library", "framework", "changelog", "arxiv", "paper"]],
];

export function guessCategory(server: RegistryServer): McpCatalogCategory {
  const haystack = `${server.name ?? ""} ${server.title ?? ""} ${server.description ?? ""}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }
  return "devtools";
}

/**
 * Map one registry record to an installable template.
 * npm wins over pypi over remote; oci-only records are dropped because this
 * app has no docker runner for user servers.
 */
export function mapRegistryServer(record: RegistryRecord): McpCatalogEntry | null {
  const server = record?.server;
  if (!server?.name) return null;
  const id = registryIdFromName(server.name);
  const displayName = server.title?.trim() || server.name.split("/").pop() || server.name;
  const repositoryUrl =
    typeof server.repository === "string" ? server.repository : server.repository?.url;
  const homepage = server.homepage?.trim() || repositoryUrl || undefined;
  const base = {
    id,
    name: displayName,
    description: server.description?.trim() || undefined,
    homepage,
    categories: [guessCategory(server)],
  };

  const npm = server.packages?.find(
    (pkg) => pkg.registryType?.toLowerCase() === "npm" && typeof pkg.identifier === "string" && !!pkg.identifier.trim(),
  );
  if (npm) {
    const runtimeArgs = argumentValues(npm.runtimeArguments);
    const packageArgs = argumentValues(npm.packageArguments);
    const packageName = packageSpecifier(npm, "@");
    const args = [...runtimeArgs];
    if (packageName && !args.includes(packageName) && !packageArgs.includes(packageName)) args.push(packageName);
    args.push(...packageArgs);
    const env = envTemplates(npm);
    const entry: McpCatalogEntry = {
      ...base,
      transport: "stdio",
      command: typeof npm.runtimeHint === "string" && npm.runtimeHint.trim() ? npm.runtimeHint.trim() : "npx",
      args,
      ...(env ? { env } : {}),
      ...(Array.isArray(npm.environmentVariables) && npm.environmentVariables.length
        ? { requiredEnv: envSpecs(npm) }
        : {}),
    };
    return catalogEntryError(entry) ? null : entry;
  }

  const pypi = server.packages?.find(
    (pkg) => pkg.registryType?.toLowerCase() === "pypi" && typeof pkg.identifier === "string" && !!pkg.identifier.trim(),
  );
  if (pypi) {
    const runtimeArgs = argumentValues(pypi.runtimeArguments);
    const packageArgs = argumentValues(pypi.packageArguments);
    const packageName = packageSpecifier(pypi, "==");
    const args = [...runtimeArgs];
    if (packageName && !args.includes(packageName) && !packageArgs.includes(packageName)) args.push(packageName);
    args.push(...packageArgs);
    const env = envTemplates(pypi);
    const entry: McpCatalogEntry = {
      ...base,
      transport: "stdio",
      command: typeof pypi.runtimeHint === "string" && pypi.runtimeHint.trim() ? pypi.runtimeHint.trim() : "uvx",
      args,
      prerequisites: ["Requires uv/uvx on PATH"],
      ...(env ? { env } : {}),
      ...(Array.isArray(pypi.environmentVariables) && pypi.environmentVariables.length
        ? { requiredEnv: envSpecs(pypi) }
        : {}),
    };
    return catalogEntryError(entry) ? null : entry;
  }

  const remote = server.remotes?.find(
    (candidate) => candidate?.type?.toLowerCase() === "streamable-http" && isPublicHttpsUrl(candidate.url ?? ""),
  );
  if (remote) {
    const template = remoteHeaderTemplates(remote);
    const entry: McpCatalogEntry = {
      ...base,
      transport: "http",
      url: remote.url!,
      ...(Object.keys(template.headers).length ? { headers: template.headers } : {}),
      ...(template.requiredEnv ? { requiredEnv: template.requiredEnv } : {}),
    };
    return catalogEntryError(entry) ? null : entry;
  }

  return null;

}

/** Built-in picks first; registry entries fill the tail without id collisions. */
export function mergeRegistryEntries(
  builtin: McpCatalogEntry[],
  remote: McpCatalogEntry[],
): McpCatalogEntry[] {
  const seen = new Set(builtin.map((entry) => entry.id));
  const merged = [...builtin];
  for (const entry of remote) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** One user-configurable market source. */
export type MarketSourceKind = "registry" | "catalog";

export type MarketSource = {
  id: string;
  name: string;
  url: string;
  kind: MarketSourceKind;
  /** The shipped default; the UI does not offer a remove button for it. */
  builtin?: boolean;
};

export const DEFAULT_MARKET_SOURCE: MarketSource = {
  id: "official",
  name: "Official registry",
  url: "https://registry.modelcontextprotocol.io/v0/servers",
  kind: "registry",
  builtin: true,
};

const MAX_MARKET_SOURCES = 16;
/**
 * Guard for user-entered source URLs. The same credentials-free public HTTPS
 * policy is used by renderer validation and by main-process requests.
 */
export function isSafeMarketSourceUrl(url: string): boolean {
  return isPublicHttpsUrl(url);
}

/** A catalog entry tagged with the source that produced it. */
export type SourcedCatalogEntry = McpCatalogEntry & { sourceId: string };

/** Repair whatever the renderer persisted into a usable source list. */
export function sanitizeMarketSources(value: unknown): MarketSource[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const sources: MarketSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as MarketSource;
    if (
      typeof candidate.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(candidate.id) ||
      typeof candidate.name !== "string" ||
      typeof candidate.url !== "string" ||
      (candidate.kind !== "registry" && candidate.kind !== "catalog") ||
      !isSafeMarketSourceUrl(candidate.url) ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    const official = candidate.id === DEFAULT_MARKET_SOURCE.id;
    if (
      official &&
      (candidate.url !== DEFAULT_MARKET_SOURCE.url || candidate.kind !== DEFAULT_MARKET_SOURCE.kind)
    ) {
      continue;
    }
    if (!official && sources.length >= MAX_MARKET_SOURCES - 1) continue;
    seen.add(candidate.id);
    sources.push(
      official
        ? DEFAULT_MARKET_SOURCE
        : {
            id: candidate.id,
            name: candidate.name.slice(0, 64) || candidate.id,
            url: candidate.url,
            kind: candidate.kind,
          },
    );
  }
  if (!sources.some((source) => source.id === DEFAULT_MARKET_SOURCE.id)) {
    sources.unshift(DEFAULT_MARKET_SOURCE);
  }
  return sources;
}
