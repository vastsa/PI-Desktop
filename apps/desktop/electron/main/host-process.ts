import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ErrorCodes,
  MAX_HOST_STDIN_LINE_BYTES,
  PROTOCOL_VERSION,
  rpcTimeoutMs,
  stripProxyEnv,
} from "@pi-desktop/shared";
import {
  GlibcUnsupportedError,
  glibcMissingSymbol,
} from "./linux-glibc";
import { DbSchemaTooNewError, parseSchemaTooNew } from "./host-boot-diagnostics";

const HOST_DISPOSE_GRACE_MS = 3_000;
const HOST_FORCE_KILL_GRACE_MS = 1_000;
const HOST_OVERLOAD_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;

export type HostNotificationHandler = (method: string, params: unknown) => void;
export type ProcessExitHandler = (info: {
  code: number | null;
  signal: NodeJS.Signals | null;
  intentional: boolean;
  /** Last child stderr lines before exit; only the agent sidecar fills it. */
  stderrTail?: string[];
}) => void;
export type StderrHandler = (text: string) => void;

function isHostOverloaded(error: unknown): boolean {
  const candidate = error as {
    errorCode?: unknown;
    data?: { errorCode?: unknown };
  } | null;
  return (
    candidate?.errorCode === ErrorCodes.HOST_OVERLOADED ||
    candidate?.data?.errorCode === ErrorCodes.HOST_OVERLOADED
  );
}

function resolveHostBinary(): string {
  if (process.env.PI_DESKTOP_HOST_BIN && existsSync(process.env.PI_DESKTOP_HOST_BIN)) {
    return process.env.PI_DESKTOP_HOST_BIN;
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    // packaged resources
    join(process.resourcesPath || "", `bin/pi-desktop-host-core${exe}`),
    // monorepo dev/build
    join(__dirname, `../../../../target/debug/pi-desktop-host-core${exe}`),
    join(__dirname, `../../../../target/release/pi-desktop-host-core${exe}`),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    "host-core binary not found. Run `cargo build -p host-core` first.",
  );
}

/**
 * Directory holding the plugins this build ships, or null when it ships none.
 *
 * Mirrors `resolveBuiltinSkillPath`: electron-builder copies
 * `resources/plugins` to `<resources>/plugins`, and a source checkout reaches
 * the same tree relatively.
 */
function resolveBuiltinPluginsDir(): string | null {
  const candidates = [
    join(process.resourcesPath || "", "plugins"),
    join(__dirname, "../../resources/plugins"),
    join(__dirname, "../../../resources/plugins"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export class HostProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private handlers = new Set<HostNotificationHandler>();
  private exitHandlers = new Set<ProcessExitHandler>();
  private disposed = false;
  private available = true;
  private closed = false;
  private exitNotified = false;
  private exitObserved = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private disposePromise?: Promise<void>;
  private readline?: ReturnType<typeof createInterface>;
  private lastStderr = "";
  readonly binaryPath: string;
  readonly generation = randomUUID();

  constructor(dataDir: string, onStderr?: StderrHandler) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.binaryPath = resolveHostBinary();
    const builtinPlugins = resolveBuiltinPluginsDir();
    this.child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...stripProxyEnv(process.env),
        PI_DESKTOP_DATA_DIR: dataDir,
        // Only Electron knows whether this build runs from `resources/` or a
        // source checkout, so it resolves the bundled-plugin directory and
        // host-core simply reconciles its registry against it (ADR 0105).
        ...(builtinPlugins ? { PI_DESKTOP_BUILTIN_PLUGINS_DIR: builtinPlugins } : {}),
      },
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => {
      if (!text) return;
      this.lastStderr = `${this.lastStderr}${text}`.slice(-4_000);
      if (onStderr) onStderr(text);
      else console.error(`[host-core] ${text.trimEnd()}`);
    });

    this.child.on("exit", (code, signal) => {
      this.available = false;
      this.closeTransport(this.unavailableError("host-core exited"));
      this.exitObserved = true;
      this.resolveExit();
      this.notifyExit({ code, signal, intentional: this.disposed });
      this.cleanupProcessListeners();
    });
    this.child.on("error", (error) => {
      this.available = false;
      const failure = this.unavailableError(
        `host-core process error: ${error.message}`,
      );
      this.closeTransport(failure);
      // A spawn failure never produces an `exit` event, so without settling the
      // exit promise here `dispose()` would wait the full grace period, send a
      // SIGKILL to a process that never started, and wait again.
      if (this.child.pid === undefined || this.child.exitCode !== null) {
        this.exitObserved = true;
        this.resolveExit();
      }
      this.notifyExit({ code: null, signal: null, intentional: this.disposed });
      if (this.exitObserved) this.cleanupProcessListeners();
    });

    const rl = createInterface({ input: this.child.stdout });
    this.readline = rl;
    rl.on("line", (line) => this.onLine(line));
  }

  private closeTransport(error: Error) {
    if (this.closed) return;
    this.available = false;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.handlers.clear();
    this.readline?.close();
    this.readline = undefined;
  }

  private cleanupProcessListeners() {
    this.child.removeAllListeners("exit");
    this.child.removeAllListeners("error");
    this.child.stderr.removeAllListeners("data");
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitObserved) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (observed: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(observed);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.exitPromise.then(() => finish(true));
    });
  }

  private notifyExit(info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    intentional: boolean;
  }) {
    if (this.exitNotified) return;
    this.exitNotified = true;
    for (const h of this.exitHandlers) h(info);
    this.exitHandlers.clear();
  }

  /**
   * Every rejection that only means "the transport is gone" is built here, so a
   * caller can tell routine teardown from a real failure by the error code
   * rather than by matching message text.
   */
  private unavailableError(message: string): Error & { errorCode: string } {
    const schema = parseSchemaTooNew(this.lastStderr) ?? parseSchemaTooNew(message);
    if (schema) {
      return Object.assign(new DbSchemaTooNewError(schema), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    if (glibcMissingSymbol(this.lastStderr) || glibcMissingSymbol(message)) {
      return Object.assign(new GlibcUnsupportedError(), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    return Object.assign(new Error(message), {
      errorCode: ErrorCodes.HOST_UNAVAILABLE,
    });
  }

  isAvailable(): boolean {
    return (
      this.available &&
      !this.closed &&
      this.child.exitCode === null &&
      !this.child.killed
    );
  }

  onExit(handler: ProcessExitHandler): () => void {
    if (this.closed) return () => undefined;
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(String(msg.id));
      if (pending) {
        this.pending.delete(String(msg.id));
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) {
          const err = new Error(msg.error.message) as Error & {
            code?: number;
            data?: unknown;
            errorCode?: string;
          };
          err.code = msg.error.code;
          err.data = msg.error.data;
          const errorCode =
            msg.error.data && typeof msg.error.data.errorCode === "string"
              ? msg.error.data.errorCode
              : undefined;
          if (errorCode) err.errorCode = errorCode;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      for (const h of this.handlers) h(msg.method, msg.params);
    }
  }

  onNotification(handler: HostNotificationHandler): () => void {
    if (this.closed) return () => undefined;
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async call<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutOverrideMs?: number,
  ): Promise<T> {
    for (const delayMs of [0, ...HOST_OVERLOAD_RETRY_DELAYS_MS]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        return await this.callOnce<T>(method, params, timeoutOverrideMs);
      } catch (error) {
        if (
          !isHostOverloaded(error) ||
          delayMs === HOST_OVERLOAD_RETRY_DELAYS_MS.at(-1)
        ) {
          throw error;
        }
      }
    }
    throw new Error(`host RPC retry exhausted: ${method}`);
  }

  private async callOnce<T = unknown>(
    method: string,
    params: unknown,
    timeoutOverrideMs?: number,
  ): Promise<T> {
    if (this.closed) throw this.unavailableError("host-core is unavailable");
    if (!this.isAvailable()) {
      throw this.unavailableError(`host RPC unavailable: ${method}`);
    }
    const id = randomUUID();
    const timeoutMs = timeoutOverrideMs ?? rpcTimeoutMs(method, params);
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(payload, "utf8") > MAX_HOST_STDIN_LINE_BYTES) {
      throw Object.assign(new Error("request line exceeds 64 MiB"), {
        errorCode: ErrorCodes.LIMIT_EXCEEDED,
        code: 1002,
      });
    }
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        finish();
      };
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      if (!this.isAvailable()) {
        settle(() => reject(this.unavailableError(`host RPC unavailable: ${method}`)));
        return;
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => settle(() => reject(new Error(`host RPC timeout: ${method}`))),
          timeoutMs,
        );
      }
      try {
        this.child.stdin.write(payload, (error) => {
          if (!error) return;
          const failure = this.unavailableError(
            `host RPC write failed: ${error.message}`,
          );
          settle(() => reject(failure));
          this.closeTransport(failure);
          this.notifyExit({ code: null, signal: null, intentional: this.disposed });
        });
      } catch (error) {
        const failure = this.unavailableError(
          `host RPC write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        settle(() => reject(failure));
        this.closeTransport(failure);
        this.notifyExit({ code: null, signal: null, intentional: this.disposed });
      }
    });
  }

  async handshake(): Promise<void> {
    await this.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    this.available = false;
    // EOF is the graceful host-core shutdown signal. Send it before rejecting
    // transport callers so the runner can clean up active tools first.
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.end();
    }
    this.closeTransport(this.unavailableError("host-core disposed"));
    if (this.exitObserved) return;

    const exited = await this.waitForExit(HOST_DISPOSE_GRACE_MS);
    if (exited || this.exitObserved) return;

    try {
      this.child.kill("SIGKILL");
    } catch {
      // The child may have exited between the grace check and kill fallback.
    }
    await this.waitForExit(HOST_FORCE_KILL_GRACE_MS);
  }
}
