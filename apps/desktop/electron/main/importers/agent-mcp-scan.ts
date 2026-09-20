/**
 * Scan third-party AI-tool config files for MCP server definitions.
 *
 * Every source produces `McpCandidate` records; ids and shapes are normalized
 * enough for the UI to display them, but the actual host-core admission gates
 * still run at upsert time. Failures during read/parse become `sources[].error`
 * so the UI can show one row per source instead of dropping the entry.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpImportId } from "@pi-desktop/shared";

export type McpSourceKind =
  | "claude-desktop"
  | "claude-code"
  | "cursor-global"
  | "cursor-project"
  | "codex"
  | "opencode"
  | "chatgpt-desktop";

export interface McpCandidate {
  source: McpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  warnings: string[];
}

export interface McpSourceReport {
  kind: McpSourceKind;
  path: string;
  exists: boolean;
  error?: string;
  count: number;
}

export interface McpScanResult {
  candidates: McpCandidate[];
  sources: McpSourceReport[];
}

export interface McpScanOptions {
  projectPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

async function readText(filePath: string): Promise<{ text: string | null; error?: string }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { text };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: null };
    return { text: null, error: `${code ?? "ERR"}: ${(err as Error).message}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Turn one config entry into a candidate. The rules mirror `parseMcpImport` in
 * `@pi-desktop/shared` but produce the richer scan shape and never throw.
 */
function toCandidate(
  source: McpSourceKind,
  sourcePath: string,
  rawKey: string,
  index: number,
  raw: Record<string, unknown>,
): McpCandidate {
  const warnings: string[] = [];
  const id = mcpImportId(rawKey, index);
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : id;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : undefined;

  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const declared =
    typeof raw.type === "string"
      ? raw.type.toLowerCase()
      : typeof raw.transport === "string"
        ? raw.transport.toLowerCase()
        : "";
  const declaredSse = declared.includes("sse");
  if (declaredSse) warnings.push("declared sse mapped to http");
  const wantsHttp = url ? true : declared.includes("http") || declaredSse;
  const disabled = raw.disabled === true || raw.enabled === false ? true : undefined;

  if (wantsHttp) {
    if (!url) warnings.push("http server missing url");
    else if (!/^https?:\/\//i.test(url)) warnings.push("url is not http(s)");
    return {
      source,
      sourcePath,
      id,
      rawKey,
      label,
      description,
      transport: "http",
      url: url || undefined,
      headers: stringMap(raw.headers),
      disabled,
      warnings,
    };
  }

  if (!command) warnings.push("stdio server missing command");
  return {
    source,
    sourcePath,
    id,
    rawKey,
    label,
    description,
    transport: "stdio",
    command: command || undefined,
    args: stringList(raw.args) ?? [],
    env: stringMap(raw.env) ?? {},
    disabled,
    warnings,
  };
}

function dedupeById(candidates: McpCandidate[]): McpCandidate[] {
  const seen = new Set<string>();
  const out: McpCandidate[] = [];
  for (const cand of candidates) {
    if (seen.has(cand.id)) continue;
    seen.add(cand.id);
    out.push(cand);
  }
  return out;
}

interface MapScan {
  candidates: McpCandidate[];
  count: number;
}

function scanServerMap(
  source: McpSourceKind,
  sourcePath: string,
  map: Record<string, unknown>,
): MapScan {
  const collected: McpCandidate[] = [];
  let index = 0;
  for (const [key, value] of Object.entries(map)) {
    if (!isRecord(value)) continue;
    collected.push(toCandidate(source, sourcePath, key, index, value));
    index += 1;
  }
  const deduped = dedupeById(collected);
  return { candidates: deduped, count: deduped.length };
}

function parseJson(text: string): { value: unknown | null; error?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    return { value: null, error: `invalid json: ${(err as Error).message}` };
  }
}

async function scanJsonMcpServers(
  source: McpSourceKind,
  filePath: string,
  container: (root: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<{ report: McpSourceReport; candidates: McpCandidate[] }> {
  const report: McpSourceReport = { kind: source, path: filePath, exists: false, count: 0 };
  const { text, error } = await readText(filePath);
  if (error) {
    report.error = error;
    return { report, candidates: [] };
  }
  if (text == null) return { report, candidates: [] };
  report.exists = true;
  const { value, error: parseErr } = parseJson(text);
  if (parseErr) {
    report.error = parseErr;
    return { report, candidates: [] };
  }
  if (!isRecord(value)) {
    report.error = "root is not an object";
    return { report, candidates: [] };
  }
  const map = container(value);
  if (!map) return { report, candidates: [] };
  const { candidates, count } = scanServerMap(source, filePath, map);
  report.count = count;
  return { report, candidates };
}

async function scanClaudeDesktop(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ report: McpSourceReport; candidates: McpCandidate[] }> {
  const filePath = claudeDesktopConfigPath(home, platform, env);
  return scanJsonMcpServers("claude-desktop", filePath, (root) =>
    isRecord(root.mcpServers) ? root.mcpServers : null,
  );
}

function claudeDesktopConfigPath(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appdata = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : path.join(home, "AppData", "Roaming");
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(xdg, "Claude", "claude_desktop_config.json");
}

/**
 * Claude Code writes MCP servers to either `~/.claude.json` (the older layout)
 * or `~/.claude/settings.json`. When both exist, the settings file wins for
 * shared keys — it is the one the CLI writes today.
 */
async function scanClaudeCode(
  home: string,
): Promise<{ reports: McpSourceReport[]; candidates: McpCandidate[] }> {
  const legacyPath = path.join(home, ".claude.json");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const [legacy, settings] = await Promise.all([
    scanJsonMcpServers("claude-code", legacyPath, (root) =>
      isRecord(root.mcpServers) ? root.mcpServers : null,
    ),
    scanJsonMcpServers("claude-code", settingsPath, (root) =>
      isRecord(root.mcpServers) ? root.mcpServers : null,
    ),
  ]);
  const merged = new Map<string, McpCandidate>();
  for (const cand of legacy.candidates) merged.set(cand.id, cand);
  for (const cand of settings.candidates) merged.set(cand.id, cand);
  return {
    reports: [legacy.report, settings.report],
    candidates: [...merged.values()],
  };
}

async function scanCursorGlobal(home: string) {
  const filePath = path.join(home, ".cursor", "mcp.json");
  return scanJsonMcpServers("cursor-global", filePath, (root) =>
    isRecord(root.mcpServers) ? root.mcpServers : null,
  );
}

async function scanCursorProject(projectPath: string) {
  const filePath = path.join(projectPath, ".cursor", "mcp.json");
  return scanJsonMcpServers("cursor-project", filePath, (root) =>
    isRecord(root.mcpServers) ? root.mcpServers : null,
  );
}

async function scanOpencode(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ report: McpSourceReport; candidates: McpCandidate[] }> {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  const primary = path.join(xdg, "opencode", "opencode.json");
  const fallback = path.join(home, ".opencode.json");
  const { text: primaryText, error: primaryErr } = await readText(primary);
  const chosenPath = primaryText != null || primaryErr ? primary : fallback;
  const report: McpSourceReport = { kind: "opencode", path: chosenPath, exists: false, count: 0 };
  let text: string | null;
  let err: string | undefined;
  if (primaryText != null || primaryErr) {
    text = primaryText;
    err = primaryErr;
  } else {
    const second = await readText(fallback);
    text = second.text;
    err = second.error;
  }
  if (err) {
    report.error = err;
    return { report, candidates: [] };
  }
  if (text == null) return { report, candidates: [] };
  report.exists = true;
  const { value, error: parseErr } = parseJson(text);
  if (parseErr) {
    report.error = parseErr;
    return { report, candidates: [] };
  }
  if (!isRecord(value)) {
    report.error = "root is not an object";
    return { report, candidates: [] };
  }
  const container = isRecord(value.mcp) ? value.mcp : null;
  if (!container) return { report, candidates: [] };
  const collected: McpCandidate[] = [];
  let index = 0;
  for (const [key, raw] of Object.entries(container)) {
    if (!isRecord(raw)) continue;
    const mapped = opencodeToCandidate("opencode", chosenPath, key, index, raw);
    collected.push(mapped);
    index += 1;
  }
  const deduped = dedupeById(collected);
  report.count = deduped.length;
  return { report, candidates: deduped };
}

/**
 * opencode uses `type: "local" | "remote"` and packs argv into a single
 * `command: [cmd, ...args]` array. Map it to the common candidate shape.
 */
function opencodeToCandidate(
  source: McpSourceKind,
  sourcePath: string,
  rawKey: string,
  index: number,
  raw: Record<string, unknown>,
): McpCandidate {
  const typeStr = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  const remote = typeStr === "remote" || typeof raw.url === "string";
  if (remote) {
    return toCandidate(source, sourcePath, rawKey, index, {
      ...raw,
      type: "http",
      url: typeof raw.url === "string" ? raw.url : "",
      headers: raw.headers,
    });
  }
  let command = "";
  let args: string[] = [];
  const cmdField = raw.command;
  if (Array.isArray(cmdField)) {
    const parts = cmdField.filter((v): v is string => typeof v === "string");
    command = parts[0] ?? "";
    args = parts.slice(1);
  } else if (typeof cmdField === "string") {
    command = cmdField;
    args = stringList(raw.args) ?? [];
  }
  return toCandidate(source, sourcePath, rawKey, index, {
    ...raw,
    type: "stdio",
    command,
    args,
  });
}

/**
 * Minimal TOML parser for codex `[mcp_servers.<id>]` sections. Handles the
 * subset actually used: string, bool, int, string array, inline env table.
 * Anything unrecognized is skipped rather than erroring — a real TOML crate
 * would just be extra risk here.
 */
export function parseCodexMcpToml(text: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const lines = text.split(/\r?\n/);
  let current: Record<string, unknown> | null = null;
  for (let raw of lines) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1].trim();
      const match = /^mcp_servers\.(.+)$/.exec(name);
      if (match) {
        const id = match[1].replace(/^["']|["']$/g, "").trim();
        current = {};
        result[id] = current;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = stripInlineComment(line.slice(eq + 1).trim());
    current[key] = parseTomlValue(value);
  }
  return result;
}

function stripInlineComment(value: string): string {
  // Don't strip `#` that lives inside a string; simple state machine is enough.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseTomlValue(text: string): unknown {
  if (!text.length) return "";
  const first = text[0];
  if (first === '"' || first === "'") {
    const end = text.lastIndexOf(first);
    if (end > 0) return text.slice(1, end);
    return text.slice(1);
  }
  if (first === "[") {
    const end = text.lastIndexOf("]");
    const inner = end > 0 ? text.slice(1, end) : text.slice(1);
    return splitTopLevel(inner).map((chunk) => parseTomlValue(chunk.trim()));
  }
  if (first === "{") {
    const end = text.lastIndexOf("}");
    const inner = end > 0 ? text.slice(1, end) : text.slice(1);
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevel(inner)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim().replace(/^["']|["']$/g, "");
      obj[k] = parseTomlValue(trimmed.slice(eq + 1).trim());
    }
    return obj;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start);
  if (tail.trim() || out.length) out.push(tail);
  return out;
}

async function scanCodex(
  home: string,
): Promise<{ report: McpSourceReport; candidates: McpCandidate[] }> {
  const filePath = path.join(home, ".codex", "config.toml");
  const report: McpSourceReport = { kind: "codex", path: filePath, exists: false, count: 0 };
  const { text, error } = await readText(filePath);
  if (error) {
    report.error = error;
    return { report, candidates: [] };
  }
  if (text == null) return { report, candidates: [] };
  report.exists = true;
  let parsed: Record<string, Record<string, unknown>>;
  try {
    parsed = parseCodexMcpToml(text);
  } catch (err) {
    report.error = `toml parse failed: ${(err as Error).message}`;
    return { report, candidates: [] };
  }
  const collected: McpCandidate[] = [];
  let index = 0;
  for (const [key, raw] of Object.entries(parsed)) {
    collected.push(toCandidate("codex", filePath, key, index, raw));
    index += 1;
  }
  const deduped = dedupeById(collected);
  report.count = deduped.length;
  return { report, candidates: deduped };
}

async function scanChatgptDesktop(): Promise<{
  report: McpSourceReport;
  candidates: McpCandidate[];
}> {
  // ChatGPT Desktop stores MCP config in a proprietary, undocumented location
  // (varies by channel and platform). Ship the source row so the UI can render
  // "not detected" without silently omitting it, and revisit when the layout
  // stabilizes.
  return {
    report: { kind: "chatgpt-desktop", path: "", exists: false, count: 0 },
    candidates: [],
  };
}

export async function scanExternalMcp(opts: McpScanOptions = {}): Promise<McpScanResult> {
  const home = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  const [claudeDesktop, claudeCode, cursorGlobal, opencode, codex, chatgpt] = await Promise.all([
    scanClaudeDesktop(home, platform, env),
    scanClaudeCode(home),
    scanCursorGlobal(home),
    scanOpencode(home, env),
    scanCodex(home),
    scanChatgptDesktop(),
  ]);

  const parts: Array<{ reports: McpSourceReport[]; candidates: McpCandidate[] }> = [
    { reports: [claudeDesktop.report], candidates: claudeDesktop.candidates },
    { reports: claudeCode.reports, candidates: claudeCode.candidates },
    { reports: [cursorGlobal.report], candidates: cursorGlobal.candidates },
    { reports: [opencode.report], candidates: opencode.candidates },
    { reports: [codex.report], candidates: codex.candidates },
    { reports: [chatgpt.report], candidates: chatgpt.candidates },
  ];

  if (opts.projectPath) {
    const cursorProject = await scanCursorProject(opts.projectPath);
    parts.push({ reports: [cursorProject.report], candidates: cursorProject.candidates });
  }

  const candidates = parts.flatMap((p) => p.candidates);
  const sources = parts.flatMap((p) => p.reports);
  return { candidates, sources };
}
