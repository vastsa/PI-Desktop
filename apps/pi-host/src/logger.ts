import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

const SECRET_KEY_RE = /token|secret|password|apikey|api_key|authorization|credential|cookie/i;

/** Drop secret-looking keys and bound the record; the Host log never carries a credential. */
export function redactLogData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
    return value;
  }
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactLogData(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    out[key] = SECRET_KEY_RE.test(key) ? "***" : redactLogData(item, depth + 1);
  }
  return out;
}

export type HostLogger = {
  (level: LogLevel, message: string, data?: Record<string, unknown>): void;
  child: (channel: string) => (text: string) => void;
};

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * Structured NDJSON on stderr, mirrored to `<dataDir>/logs/pi-host.log`.
 * stdout is reserved for the bootstrap handshake (the bound port and the
 * pairing token), so a supervisor can parse it without filtering log lines.
 */
export function createLogger(options: { dataDir: string; minLevel: LogLevel; stderr?: NodeJS.WritableStream }): HostLogger {
  const stderr = options.stderr ?? process.stderr;
  const logDir = join(options.dataDir, "logs");
  const ready = mkdir(logDir, { recursive: true }).catch(() => undefined);
  const write = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify(record)}\n`;
    stderr.write(line);
    void ready.then(() => appendFile(join(logDir, "pi-host.log"), line).catch(() => undefined));
  };
  const log = ((level, message, data) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[options.minLevel]) return;
    write({ ts: new Date().toISOString(), level, channel: "pi-host", message, ...(data ? { data: redactLogData(data) } : {}) });
  }) as HostLogger;
  log.child = (channel) => (text) => {
    const output = text.trimEnd();
    if (!output) return;
    write({ ts: new Date().toISOString(), level: "info", channel, message: "child stderr", data: { output: output.slice(0, 4_000) } });
  };
  return log;
}
