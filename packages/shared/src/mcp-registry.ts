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
  type McpCatalogEntry,
  type McpCatalogRequiredEnv,
} from "./mcp-catalog.js";

export type RegistryEnvVar = {
  name?: string;
  description?: string;
  /** Registry-side default: becomes the install form's prefilled value. */
  default?: string;
};

export type RegistryPackage = {
  registryType?: string;
  identifier?: string;
  runtimeHint?: string;
  runtimeArguments?: Array<{ value?: string; type?: string }>;
  environmentVariables?: RegistryEnvVar[];
};

export type RegistryRemote = {
  type?: string;
  url?: string;
  headers?: Array<{ name?: string; value?: string }>;
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
    .filter((variable): variable is RegistryEnvVar & { name: string } => !!variable.name)
    .map((variable) => ({
      name: variable.name,
      ...(variable.description ? { description: variable.description } : {}),
      ...(variable.default !== undefined ? { defaultValue: variable.default } : {}),
    }));
}

function envTemplates(pkg: RegistryPackage): Record<string, string> | undefined {
  const names = (pkg.environmentVariables ?? [])
    .filter((variable): variable is RegistryEnvVar & { name: string } => !!variable.name)
    .map((variable) => variable.name);
  return names.length ? Object.fromEntries(names.map((name) => [name, `\${${name}}`])) : undefined;
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
  };

  const npm = server.packages?.find((pkg) => pkg.registryType === "npm" && pkg.identifier);
  if (npm) {
    const runtimeArgs = (npm.runtimeArguments ?? [])
      .map((argument) => argument.value ?? "")
      .filter(Boolean);
    const args = npm.identifier && !runtimeArgs.includes(npm.identifier)
      ? [...runtimeArgs, npm.identifier]
      : runtimeArgs;
    const entry: McpCatalogEntry = {
      ...base,
      transport: "stdio",
      command: npm.runtimeHint?.trim() || "npx",
      args,
      ...(envTemplates(npm) ? { env: envTemplates(npm) } : {}),
      ...(npm.environmentVariables?.length
        ? { requiredEnv: envSpecs(npm) }
        : {}),
    };
    return catalogEntryError(entry) ? null : entry;
  }

  const pypi = server.packages?.find(
    (pkg) => pkg.registryType?.toLowerCase() === "pypi" && pkg.identifier,
  );
  if (pypi) {
    const entry: McpCatalogEntry = {
      ...base,
      transport: "stdio",
      command: pypi.runtimeHint?.trim() || "uvx",
      args: [pypi.identifier!],
      prerequisites: ["Requires uv/uvx on PATH"],
      ...(envTemplates(pypi) ? { env: envTemplates(pypi) } : {}),
      ...(pypi.environmentVariables?.length ? { requiredEnv: envSpecs(pypi) } : {}),
    };
    return catalogEntryError(entry) ? null : entry;
  }

  const remote = server.remotes?.find((candidate) => /^https:/i.test(candidate.url ?? ""));
  if (remote) {
    const headers = Object.fromEntries(
      (remote.headers ?? [])
        .filter((header) => header.name && header.value !== undefined)
        .map((header) => [header.name!, header.value!]),
    );
    const entry: McpCatalogEntry = {
      ...base,
      transport: "http",
      url: remote.url!,
      ...(Object.keys(headers).length ? { headers } : {}),
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
