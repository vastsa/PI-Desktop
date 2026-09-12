import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
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
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  pluginId?: string;
  code?: string;
  data?: unknown;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 2;
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

const SECRET_KEY_RE = /token|secret|password|api[_-]?key|authorization/i;
const SECRET_VALUE_RE = /\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g;
const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_RE, "***REDACTED***");
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***REDACTED***" : redactValue(v);
    }
    return out;
  }
  return value;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

export class Logger {
  private dir: string;
  private minLevel: LogLevel;
  private sizes = new Map<string, number>();
  private childBuffers = new Map<LogChannel, string>();

  constructor(dataDir: string, minLevel: LogLevel = "info") {
    this.dir = join(dataDir, "logs");
    this.minLevel = minLevel;
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
    const safeMessage = String(redactValue(message));
    const record = {
      ts: new Date().toISOString(),
      level,
      channel,
      category,
      message: safeMessage,
      ...(redactValue(fields) as LogFields),
    };
    const line = JSON.stringify(record) + "\n";
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
    if (process.env.NODE_ENV !== "production" || level === "error") {
      try {
        const mirror = level === "error" ? console.error : console.log;
        mirror(`[${channel}/${category}] ${safeMessage}`);
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
    this.log(channel, this.categoryForChild(line), this.levelForChild(line), line);
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
    if (/\bERROR\b|\b(?:failed|failure|panic)\b/i.test(message)) {
      return "error";
    }
    if (/\bWARN(?:ING)?\b/i.test(message)) return "warn";
    if (/\bDEBUG\b/i.test(message)) return "debug";
    return "info";
  }
}
