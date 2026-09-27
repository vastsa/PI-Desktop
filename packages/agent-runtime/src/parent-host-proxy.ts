import { randomUUID } from "node:crypto";
import { rpcTimeoutMs } from "@pi-desktop/shared";

export type ParentHostCloseHandler = (error: Error) => void;

/**
 * Host client that proxies RPC calls to the Electron main process
 * via the sidecar stdio JSON-RPC channel.
 */
export class ParentHostProxy {
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private closeHandlers = new Set<ParentHostCloseHandler>();
  private closed = false;

  constructor() {
    process.stdin.on("end", this.handleParentClose);
    process.stdin.on("close", this.handleParentClose);
    process.stdin.on("error", this.handleParentClose);
    process.stdout.on("error", this.handleParentClose);
  }

  private handleParentClose = (cause?: unknown) => {
    const error = cause instanceof Error ? cause : new Error("parent host process closed");
    this.close(error);
  };

  private close(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    for (const handler of this.closeHandlers) handler(error);
    this.closeHandlers.clear();
    process.stdin.off("end", this.handleParentClose);
    process.stdin.off("close", this.handleParentClose);
    process.stdin.off("error", this.handleParentClose);
    process.stdout.off("error", this.handleParentClose);
  }

  /** Handle a response/notification line coming from parent on stdin. */
  handleParentMessage(msg: any) {
    if (this.closed) return true;
    if (
      msg.id !== undefined &&
      msg.id !== null &&
      (Object.prototype.hasOwnProperty.call(msg, "result") || msg.error)
    ) {
      const pending = this.pending.get(String(msg.id));
      if (pending) {
        this.pending.delete(String(msg.id));
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.error) {
          const err = new Error(msg.error.message) as Error & { data?: unknown };
          err.data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return true;
    }
    if (msg.method === "host.notification") {
      for (const h of this.notificationHandlers) {
        h(msg.params?.method, msg.params?.params);
      }
      return true;
    }
    return false;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    if (this.closed) return () => undefined;
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onClose(handler: ParentHostCloseHandler): () => void {
    if (this.closed) return () => undefined;
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async call<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutOverrideMs?: number,
  ): Promise<T> {
    if (this.closed) throw new Error("parent host process is unavailable");
    const id = randomUUID();
    const deadlineMs = timeoutOverrideMs ?? rpcTimeoutMs(method, params);
    const payload =
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "host.proxy",
        params: { method, params },
      }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`parent host proxy timeout: ${method}`));
        }
      }, deadlineMs);
      this.pending.set(id, {
        resolve: resolve as (v: any) => void,
        reject,
        timer,
      });
      process.stdout.write(payload, (err) => {
        if (err) this.handleParentClose(err);
      });
    });
  }

  async dispose(): Promise<void> {
    this.close(new Error("parent host proxy disposed"));
  }
}
