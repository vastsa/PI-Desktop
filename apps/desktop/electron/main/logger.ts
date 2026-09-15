import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// NDJSON file logging per docs/spec/03-runtime/09-logging-and-observability.md.
// Each channel is split into focused category files instead of one crowded
// app.log/host.log/agent.log stream. The audit channel lives in host-core
// SQLite (see the logging specification's channel notes).

export type LogChannel = "app" | "host" | "agent";

export type LogCategory =
  | "lifecycle"
  | "session"
  | "tool"
  | "permission"
  | "plugin"
  | "provider"
  | "persistence"
  | "updater"
  | "diagnostics"
  | "runtime"

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = {
  traceId?: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  agentName?: string;
  pluginId?: string;
  executionId?: string;
  code?: string;
  /** Optional stable machine-readable event name. */
  event?: string;
  data?: unknown;
};

export type LogRecord = {
  ts: string;
  level: LogLevel;
  channel: LogChannel;
  category: LogCategory;
  event: string;
  message: string;
  traceId?: string;
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  agentName?: string;
  pluginId?: string;
  executionId?: string;
  code?: string;
  data?: unknown;
};

export type LoggerOptions = {
  mirrorConsole?: boolean;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 2;
const MAX_MESSAGE_CHARS = 512;
const MAX_DATA_BYTES = 8 * 1024;
const MAX_DATA_STRING_CHARS = 1_024;
const MAX_DATA_DEPTH = 5;
const MAX_DATA_KEYS = 48;
const MAX_DATA_ITEMS = 32;
const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

let stdioGuarded = false;

/** Closed stdout/stderr from a Linux AppImage or GUI launch without a TTY. */
export function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "EIO";
}

/**
 * Keep a closed stdout/stderr from becoming Electron's uncaught-exception
 * dialog. Console writes throw synchronously (`write EPIPE`); stream `error`
 * events fire asynchronously. Both must be ignored for a GUI app.
 */
export function ignoreBrokenStdio(): void {
  if (stdioGuarded) return;
  stdioGuarded = true;

  const ignore = (error: NodeJS.ErrnoException) => {
    if (isBrokenPipeError(error)) return;
    throw error;
  };
  process.stdout?.on?.("error", ignore);
  process.stderr?.on?.("error", ignore);

  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    console[method] = (...args: Parameters<typeof original>) => {
      try {
        original.apply(console, args);
      } catch (error) {
        if (!isBrokenPipeError(error)) throw error;
      }
    };
  }
}

const SECRET_KEY_RE =
  /token|secret|password|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret/i;
const SECRET_VALUE_RE =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b|\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|ya29\.)[A-Za-z0-9._-]{8,}\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;&}"']+/gi;
const BEARER_RE = /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi;
const URL_CREDENTIAL_RE = /(https?:\/\/)[^/\s:@]+:[^@\s]+@/gi;
const PATH_KEY_RE = /(?:path|cwd|root|file|filename|directory|dir|workspace|project|datadir|logdir)$/i;
const ABSOLUTE_PATH_RE = /(^|[\s("'=])((?:\/|[A-Za-z]:[\\/]|\\\\)[^\s"'=,;)}]*)/g;
const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_REDACTION_ROOTS = [homedir()]
  .filter((root) => root !== "/")
  .map((path) => ({ path, label: "<home>" }));

export type RedactionOptions = {
  roots?: ReadonlyArray<{ path: string; label: string }>;
  maxStringChars?: number;
};

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}…[truncated ${omitted} chars]`;
}

function redactString(value: string, options: RedactionOptions): string {
  let safe = stripAnsi(value);
  safe = safe.replace(URL_CREDENTIAL_RE, "$1***:***@");
  safe = safe.replace(BEARER_RE, (match) => `${match.split(/\s+/, 1)[0]} ***REDACTED***`);
  safe = safe.replace(SECRET_ASSIGNMENT_RE, "$1***REDACTED***");
  safe = safe.replace(SECRET_VALUE_RE, "***REDACTED***");
  const roots = [...(options.roots ?? [])].sort(
    (left, right) => right.path.length - left.path.length,
  );
  for (const root of roots) {
    if (!root.path || root.path === "/") continue;
    const escapedPath = root.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safe = safe.replace(
      new RegExp(`${escapedPath}(?=$|[/\\\\])`, "g"),
      root.label,
    );
  }
  safe = safe.replace(ABSOLUTE_PATH_RE, "$1<local-path>");
  return truncateText(safe, options.maxStringChars ?? MAX_MESSAGE_CHARS);
}

function redactValueInternal(
  value: unknown,
  options: RedactionOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactString(value, options);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DATA_DEPTH) return "[DepthLimited]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_DATA_ITEMS)
      .map((item) => redactValueInternal(item, options, seen, depth + 1));
    if (value.length > MAX_DATA_ITEMS) items.push(`[${value.length - MAX_DATA_ITEMS} items omitted]`);
    seen.delete(value);
    return items;
  }
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, MAX_DATA_KEYS)) {
    output[key] = SECRET_KEY_RE.test(key)
      ? "***REDACTED***"
      : PATH_KEY_RE.test(key) && typeof item === "string"
        ? redactPath(item, options)
      : redactValueInternal(item, options, seen, depth + 1);
  }
  if (entries.length > MAX_DATA_KEYS) {
    output._omittedFields = entries.length - MAX_DATA_KEYS;
  }
  seen.delete(value);
  return output;
}

function redactPath(value: string, options: RedactionOptions): string {
  const safe = redactString(value, options);
  if (
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) &&
    !safe.startsWith("<home>") &&
    !safe.startsWith("<data-dir>") &&
    !safe.startsWith("<log-dir>")
  ) {
    return "<local-path>";
  }
  return safe;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  return redactValueInternal(
    value,
    { ...options, roots: options.roots ?? DEFAULT_REDACTION_ROOTS },
    new WeakSet<object>(),
    0,
  );
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

export class Logger {
  private dir: string;
  private dataDir: string;
  private minLevel: LogLevel;
  private mirrorConsole: boolean;
  private sizes = new Map<string, number>();
  private childBuffers = new Map<LogChannel, string>();

  constructor(
    dataDir: string,
    minLevel: LogLevel = "info",
    options: LoggerOptions = {},
  ) {
    this.dataDir = dataDir;
    this.dir = join(dataDir, "logs");
    this.minLevel = minLevel;
    this.mirrorConsole =
      options.mirrorConsole ?? process.env.NODE_ENV !== "production";
    mkdirSync(this.dir, { recursive: true });
  }

  private levelAt(level: LogLevel): number {
    return { debug: 0, info: 1, warn: 2, error: 3 }[level];
  }

  private pathFor(
    channel: LogChannel,
    category: LogCategory,
    index = 0,
  ): string {
    const name = index === 0 ? `${category}.log` : `${category}.${index}.log`;
    return join(this.dir, channel, name);
  }

  private sizeKey(channel: LogChannel, category: LogCategory): string {
    return `${channel}/${category}`;
  }

  private rotateIfNeeded(channel: LogChannel, category: LogCategory) {
    const key = this.sizeKey(channel, category);
    const path = this.pathFor(channel, category);
    mkdirSync(join(this.dir, channel), { recursive: true });

    let size = this.sizes.get(key);
    if (size === undefined) {
      try {
        size = statSync(path).size;
      } catch {
        size = 0;
      }
    }
    if (size < MAX_FILE_BYTES) {
      this.sizes.set(key, size);
      return;
    }

    try {
      for (let i = KEEP_ROTATED; i >= 1; i -= 1) {
        const from = this.pathFor(channel, category, i - 1);
        const to = this.pathFor(channel, category, i);
        if (existsSync(to)) unlinkSync(to);
        if (existsSync(from)) renameSync(from, to);
      }
      this.sizes.set(key, 0);
    } catch {
      // Rotation is best-effort; never fail the caller or lose the size.
      this.sizes.set(key, size);
    }
  }

  log(
    channel: LogChannel,
    category: LogCategory,
    level: LogLevel,
    message: string,
    fields: LogFields = {},
  ) {
    if (this.levelAt(level) < this.levelAt(this.minLevel)) return;
    const roots = [
      ...DEFAULT_REDACTION_ROOTS,
      { path: this.dataDir, label: "<data-dir>" },
      { path: this.dir, label: "<log-dir>" },
    ];
    const safeFields = redactValue(fields, {
      roots,
      maxStringChars: MAX_DATA_STRING_CHARS,
    }) as LogFields;
    const event = normalizeEventName(safeFields.event ?? message);
    const safeMessage = redactString(message, {
      roots,
      maxStringChars: MAX_MESSAGE_CHARS,
    });
    const { event: _event, data, ...attributes } = safeFields;
    const safeData = data === undefined ? undefined : boundData(data);
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      channel,
      category,
      event,
      message: safeMessage,
      ...attributes,
      ...(safeData === undefined ? {} : { data: safeData }),
    };
    const line = safeJson(record) + "\n";
    try {
      this.rotateIfNeeded(channel, category);
      appendFileSync(this.pathFor(channel, category), line, "utf8");
      const key = this.sizeKey(channel, category);
      this.sizes.set(
        key,
        (this.sizes.get(key) ?? 0) + Buffer.byteLength(line, "utf8"),
      );
    } catch {
      // Disk trouble must never crash the app.
    }
    if (this.mirrorConsole || level === "error") {
      try {
        const mirror = level === "error" || level === "warn" ? console.error : console.log;
        mirror(`[${channel}/${category}] ${safeJson(record)}`);
      } catch {
        // Console mirroring is best-effort. A closed stdout (EPIPE on Linux
        // AppImage) must never become an uncaught main-process exception.
      }
    }
  }

  app(
    category: LogCategory,
    level: LogLevel,
    message: string,
    fields?: LogFields,
  ) {
    this.log("app", category, level, message, fields);
  }

  /**
   * Wrap a child process stderr stream into category files.
   *
   * ChildProcess data events are arbitrary chunks, not lines. Keep the
   * trailing fragment so a tracing record is never split across NDJSON rows.
   */
  child(channel: Exclude<LogChannel, "app">, text: string) {
    const normalized = text.replace(/\r\n?/g, "\n");
    const pending = `${this.childBuffers.get(channel) ?? ""}${normalized}`;
    const lines = pending.split("\n");
    this.childBuffers.set(channel, lines.pop() ?? "");
    for (const raw of lines) this.logChildLine(channel, raw);
  }

  /** Flush a final child stderr fragment when a supervised process exits. */
  flushChild(channel: Exclude<LogChannel, "app">) {
    const pending = this.childBuffers.get(channel) ?? "";
    this.childBuffers.delete(channel);
    if (pending) this.logChildLine(channel, pending);
  }

  private logChildLine(channel: Exclude<LogChannel, "app">, raw: string) {
    const line = stripAnsi(raw).trim();
    if (!line) return;
    this.log(channel, this.categoryForChild(line), this.levelForChild(line), "child process stderr", {
      data: { output: line },
    });
  }

  private categoryForChild(message: string): LogCategory {
    const normalized = message.toLowerCase();
    if (/\bpermission(?:s)?\b/.test(normalized)) return "permission";
    if (/\bplugin(?:s)?\b/.test(normalized)) return "plugin";
    if (/\btools?\b|tools::/.test(normalized)) return "tool";
    if (/\bsession\b|\bturn\b/.test(normalized)) return "session";
    if (/\bprovider\b|\bmodel\b/.test(normalized)) return "provider";
    return "runtime";
  }

  private levelForChild(message: string): LogLevel {
    if (/\b(?:ERROR|FATAL|PANIC)\b|\b(?:failed|failure|panic|exception|unhandled rejection)\b/i.test(message)) {
      return "error";
    }
    if (/\bWARN(?:ING)?\b/i.test(message)) return "warn";
    if (/\bDEBUG\b/i.test(message)) return "debug";
    return "info";
  }
}

export function normalizeEventName(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return truncateText(normalized || "event.unknown", 128);
}

/**
 * Keep tool logs useful without copying command output, file contents, or
 * plugin responses into the diagnostic stream. The complete result remains
 * available to the transcript and the host audit record where applicable.
 */
export function summarizeToolResult(result: unknown): Record<string, unknown> {
  if (result === null || result === undefined) return { type: "empty" };
  if (typeof result === "string") {
    return { type: "text", chars: result.length, bytes: Buffer.byteLength(result, "utf8") };
  }
  if (typeof result !== "object") return { type: typeof result };
  if (Array.isArray(result)) {
    return { type: "array", itemCount: result.length };
  }

  const record = result as Record<string, unknown>;
  const keys = Object.keys(record);
  const summary: Record<string, unknown> = {
    type: "object",
    fields: keys.slice(0, MAX_DATA_KEYS),
    fieldCount: keys.length,
  };
  for (const key of ["ok", "isError", "exitCode", "errorCode", "code", "truncated"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  for (const key of ["stdout", "stderr", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string") {
      summary[`${key}Chars`] = value.length;
      summary[`${key}Bytes`] = Buffer.byteLength(value, "utf8");
    }
  }
  if (Array.isArray(record.content)) summary.contentBlocks = record.content.length;
  if (record.details && typeof record.details === "object") {
    summary.detailFields = Object.keys(record.details as Record<string, unknown>).slice(0, MAX_DATA_KEYS);
  }
  return summary;
}

function boundData(value: unknown): unknown {
  const options: RedactionOptions = { maxStringChars: MAX_DATA_STRING_CHARS };
  const bounded = redactValue(value, options);
  const serialized = safeJson(bounded);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_DATA_BYTES) return bounded;

  const compact = redactValue(value, { maxStringChars: 256 });
  if (Buffer.byteLength(safeJson(compact), "utf8") <= MAX_DATA_BYTES) return compact;
  if (Array.isArray(value)) {
    return { truncated: true, type: "array", itemCount: value.length };
  }
  if (value && typeof value === "object") {
    return {
      truncated: true,
      type: "object",
      fields: Object.keys(value as Record<string, unknown>).slice(0, MAX_DATA_KEYS),
    };
  }
  return { truncated: true, type: typeof value };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}
