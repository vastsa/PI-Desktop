import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  MAX_HOST_STDIN_LINE_BYTES,
  PROTOCOL_VERSION,
  readNdjsonLines,
  rpcTimeoutMs,
  stripProxyEnv,
} from "@pi-desktop/shared";

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

/** A transport failure the embedding host recognised, e.g. a schema refusal. */
export type DiagnosedHostFailure = Error & { errorCode: string };

export type HostProcessOptions = {
  /** Absolute path of the `pi-desktop-host-core` binary to spawn. */
  binaryPath: string;
  /** Data directory handed to host-core as `PI_DESKTOP_DATA_DIR`. */
  dataDir: string;
  /**
   * Extra environment for the child. The inherited environment is copied with
   * proxy variables stripped first, so host-core never sees proxy credentials
   * (D340); entries here are applied on top.
   */
  env?: Record<string, string | undefined>;
  /** Receives raw stderr text as it arrives; the embedding host owns redaction and logging. */
  onStderr: StderrHandler;
  /**
   * Classify a gone transport from the child's last stderr lines. Returns a
   * typed error when the failure is one the embedding host names (a data
   * directory newer than the build, an unsupported glibc), otherwise `null`
   * and the generic `HOST_UNAVAILABLE` error is used.
   */
  diagnoseFailure?: (context: { lastStderr: string; message: string }) => DiagnosedHostFailure | null;
};

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

/**
 * The Rust host-core child over stdio NDJSON JSON-RPC. This class knows how to
 * spawn, call, observe, and dispose the process; it does not know where the
 * binary lives or which host embeds it, so Electron Main and the headless
 * `pi-host` drive the same transport.
 */
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
  private stdoutReader?: ReturnType<typeof readNdjsonLines>;
  private lastStderr = "";
  private readonly diagnoseFailure?: HostProcessOptions["diagnoseFailure"];
  readonly binaryPath: string;
  readonly generation = randomUUID();

  constructor(options: HostProcessOptions) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.binaryPath = options.binaryPath;
    this.diagnoseFailure = options.diagnoseFailure;
    const onStderr = options.onStderr;
    this.child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...stripProxyEnv(process.env),
        PI_DESKTOP_DATA_DIR: options.dataDir,
        ...(options.env ?? {}),
      },
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => {
      if (!text) return;
      this.lastStderr = `${this.lastStderr}${text}`.slice(-4_000);
      onStderr(text);
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

    this.stdoutReader = readNdjsonLines(this.child.stdout, (line) =>
      this.onLine(line),
    );
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
    this.stdoutReader?.close();
    this.stdoutReader = undefined;
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
   * rather than by matching message text. The embedding host may recognise the
   * failure from the last stderr lines and return a more specific typed error.
   */
  private unavailableError(message: string): Error & { errorCode: string } {
    const diagnosed = this.diagnoseFailure?.({ lastStderr: this.lastStderr, message });
    if (diagnosed) return diagnosed;
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
      console.warn(
        `[RPC] Invalid host-process NDJSON frame (${Buffer.byteLength(line, "utf8")} bytes)`,
      );
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
