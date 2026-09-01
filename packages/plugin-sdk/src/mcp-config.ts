import type { PluginMcpServerContrib } from "./index.js";

export const MCP_SERVER_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const MCP_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MCP_HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export type McpValidationResult =
  | { ok: true; server: PluginMcpServerContrib }
  | { ok: false; error: string };

/** Identify loopback hosts for callers that want to explain local endpoints. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function checkRelativePath(value: string, field: string): string | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return `${field} must not be an absolute path`;
  }
  if (value.split(/[\\/]/).includes("..")) {
    return `${field} must not contain ".."`;
  }
  return undefined;
}

function checkRefRecord(
  record: Record<string, string | { setting: string }> | undefined,
  keyPattern: RegExp,
  field: string,
): string | undefined {
  if (record === undefined) return undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return `${field} must be an object`;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!keyPattern.test(key)) return `${field} key "${key}" is not allowed`;
    if (typeof value === "string") continue;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { setting?: unknown }).setting === "string" &&
      (value as { setting: string }).setting.length > 0
    ) {
      continue;
    }
    return `${field}.${key} must be a string or { setting: "<key>" }`;
  }
  return undefined;
}

/**
 * Validate one `contributes.mcpServers` entry.
 *
 * stdio servers may only name a bare executable or a plugin-relative one, and
 * remote servers may use either HTTP or HTTPS; callers should warn about
 * non-loopback HTTP because its requests are not encrypted.
 */
export function validateMcpServer(raw: unknown): McpValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "mcp server entry must be an object" };
  }
  const server = raw as PluginMcpServerContrib;
  if (typeof server.id !== "string" || !MCP_SERVER_ID.test(server.id)) {
    return { ok: false, error: "mcp server id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}" };
  }
  if (server.transport !== "stdio" && server.transport !== "http") {
    return { ok: false, error: `mcp server "${server.id}" transport must be "stdio" or "http"` };
  }
  const label = `mcp server "${server.id}"`;

  if (server.transport === "stdio") {
    if (server.url !== undefined || server.headers !== undefined) {
      return { ok: false, error: `${label} must not set url or headers` };
    }
    if (typeof server.command !== "string" || !server.command.trim()) {
      return { ok: false, error: `${label} requires command` };
    }
    const command = server.command.trim();
    const pathError = checkRelativePath(command, `${label} command`);
    if (pathError) return { ok: false, error: pathError };
    if (!/[\\/]/.test(command) && !BARE_COMMAND.test(command)) {
      return { ok: false, error: `${label} command "${command}" is not a valid executable name` };
    }
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")) {
        return { ok: false, error: `${label} args must be an array of strings` };
      }
    }
    const envError = checkRefRecord(server.env, MCP_ENV_KEY, `${label} env`);
    if (envError) return { ok: false, error: envError };
    return { ok: true, server };
  }

  if (server.command !== undefined || server.args !== undefined || server.env !== undefined) {
    return { ok: false, error: `${label} must not set command, args or env` };
  }
  if (typeof server.url !== "string" || !server.url.trim()) {
    return { ok: false, error: `${label} requires url` };
  }
  let parsed: URL;
  try {
    parsed = new URL(server.url);
  } catch {
    return { ok: false, error: `${label} url is not a valid absolute url` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `${label} url must use http or https` };
  }
  const headerError = checkRefRecord(server.headers, MCP_HEADER_KEY, `${label} headers`);
  if (headerError) return { ok: false, error: headerError };
  return { ok: true, server };
}

export type McpRefResolution =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/**
 * Resolve literal values and `{ setting: "<key>" }` references against the
 * plugin's own settings. Host process environment is never consulted.
 */
export function resolveMcpRefs(
  record: Record<string, string | { setting: string }> | undefined,
  settings: Record<string, unknown>,
): McpRefResolution {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === "string") {
      values[key] = value;
      continue;
    }
    const raw = settings[value.setting];
    if (raw === undefined || raw === null || raw === "") {
      return { ok: false, error: `setting "${value.setting}" is not configured` };
    }
    if (typeof raw === "object") {
      return { ok: false, error: `setting "${value.setting}" must be a scalar` };
    }
    values[key] = String(raw);
  }
  return { ok: true, values };
}
