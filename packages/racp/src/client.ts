import { RacpError } from "@pi-desktop/agent-host";
import {
  RACP_EVENT_NOTIFICATION,
  RACP_INITIALIZED_NOTIFICATION,
  RACP_PROTOCOL_VERSION,
  RACP_SUBSCRIPTION_CLOSED_NOTIFICATION,
  isDurableEventKind,
  type RacpCursor,
  type RacpEventEnvelope,
  type RacpInitializeParams,
  type RacpInitializeResult,
  type RacpRemoteError,
} from "@pi-desktop/shared";

import {
  encodeFrame,
  errorFromObject,
  isNotification,
  isRequest,
  isResponse,
  parseFrame,
  type JsonRpcId,
} from "./jsonrpc.js";

/** One client-side transport connection: the thing `ws` (or a test pair) provides. */
export interface ClientTransport {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onError(handler: (error: Error) => void): void;
}

/** Opens a transport; rejects with a typed error when the connection cannot be made. */
export type ClientTransportFactory = () => Promise<ClientTransport>;

export type RacpClientState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export type SubscriptionClosedNotice = {
  subscriptionId: string;
  error: RacpRemoteError;
  lastSafeCursor: RacpCursor;
};

export type RacpClientOptions = {
  transport: ClientTransportFactory;
  client: { name: string; version: string };
  /** Optional capabilities this client can actually service. */
  capabilities?: Partial<RacpInitializeParams["capabilities"]>;
  /** Answer a server-initiated request (`approval/request`, `input/request`, `tool/execute`). */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onEvent?: (envelope: RacpEventEnvelope) => void;
  onSubscriptionClosed?: (notice: SubscriptionClosedNotice) => void;
  onStateChange?: (state: RacpClientState, error?: RacpError) => void;
  /** Re-establish subscriptions after a reconnect. */
  onReconnected?: (client: RacpClient) => Promise<void> | void;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  requestTimeoutMs?: number;
  reconnect?: { enabled: boolean; baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  sleep?: (ms: number) => Promise<void>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: RacpError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

/**
 * The `RACP-WS` client core. Requests are correlated by id, server requests
 * are answered through `onServerRequest`, and a dropped transport reconnects
 * with bounded backoff. Reconnect never re-sends an in-flight mutation: the
 * pending calls of the old connection are rejected with `HOST_DISCONNECTED`,
 * and the caller retries with the same idempotency key if it wants to (spec
 * §4.1, §10). Durable events are tracked per session so a subscription can
 * resume from its last cursor.
 */
export class RacpClient {
  private transport: ClientTransport | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private stateValue: RacpClientState = "disconnected";
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnecting: Promise<void> | null = null;
  private initializeResult: RacpInitializeResult | null = null;
  private readonly cursors = new Map<string, RacpCursor>();
  private hostCursor: RacpCursor | null = null;

  constructor(private readonly options: RacpClientOptions) {}

  get state(): RacpClientState {
    return this.stateValue;
  }

  get initialized(): RacpInitializeResult | null {
    return this.initializeResult;
  }

  /** Last durable cursor seen for a session, for `after` on resubscribe. */
  cursorFor(sessionId: string): RacpCursor | undefined {
    return this.cursors.get(sessionId);
  }

  cursorForHost(): RacpCursor | undefined {
    return this.hostCursor ?? undefined;
  }

  async connect(): Promise<RacpInitializeResult> {
    this.closedByUser = false;
    this.setState("connecting");
    try {
      const result = await this.open();
      this.reconnectAttempt = 0;
      this.setState("connected");
      return result;
    } catch (error) {
      const typed = toRacpError(error, "REMOTE_CONNECTION_FAILED");
      this.setState("error", typed);
      throw typed;
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    const transport = this.transport;
    this.transport = null;
    this.rejectPending(new RacpError("HOST_DISCONNECTED", "client closed"));
    transport?.close(1000, "client closed");
    this.setState("disconnected");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const transport = this.transport;
    if (!transport || this.stateValue !== "connected") {
      return Promise.reject(new RacpError("HOST_DISCONNECTED", `not connected (${this.stateValue})`, { retriable: true }));
    }
    return this.send<T>(transport, method, params);
  }

  private send<T>(transport: ClientTransport, method: string, params: unknown): Promise<T> {
    this.counter += 1;
    const id = `c${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RacpError("TIMEOUT", `${method} timed out`, { retriable: true }));
      }, this.options.requestTimeoutMs ?? 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      try {
        transport.send(encodeFrame({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toRacpError(error, "HOST_DISCONNECTED"));
      }
    });
  }

  private async open(): Promise<RacpInitializeResult> {
    const transport = await this.options.transport();
    this.transport = transport;
    transport.onMessage((frame) => this.handleFrame(transport, frame));
    transport.onError((error) => this.options.log?.("warn", "racp transport error", { error: String(error) }));
    transport.onClose((info) => this.handleClose(transport, info));
    const params: RacpInitializeParams = {
      protocolVersion: RACP_PROTOCOL_VERSION,
      client: this.options.client,
      bindings: ["RACP-WS"],
      capabilities: {
        eventReplay: true,
        approvals: true,
        inputRequests: true,
        turnQueue: true,
        hostEvents: true,
        history: true,
        terminal: true,
        ...this.options.capabilities,
      },
    };
    const result = await this.send<RacpInitializeResult>(transport, "connection/initialize", params);
    transport.send(encodeFrame({ jsonrpc: "2.0", method: RACP_INITIALIZED_NOTIFICATION, params: {} }));
    this.initializeResult = result;
    return result;
  }

  private handleFrame(transport: ClientTransport, frame: string): void {
    if (transport !== this.transport) return;
    const message = parseFrame(frame);
    if (!message) return;
    if (isResponse(message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(errorFromObject(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (isRequest(message)) {
      void this.answerServerRequest(transport, message.id, message.method, message.params);
      return;
    }
    if (!isNotification(message)) return;
    if (message.method === RACP_EVENT_NOTIFICATION) {
      const envelope = message.params as RacpEventEnvelope;
      this.track(envelope);
      this.options.onEvent?.(envelope);
    } else if (message.method === RACP_SUBSCRIPTION_CLOSED_NOTIFICATION) {
      this.options.onSubscriptionClosed?.(message.params as SubscriptionClosedNotice);
    }
  }

  private track(envelope: RacpEventEnvelope): void {
    if (!isDurableEventKind(envelope.kind) || typeof envelope.sequence !== "number") return;
    const cursor = { epoch: envelope.epoch, sequence: envelope.sequence };
    if (envelope.scope === "host") this.hostCursor = cursor;
    else if (envelope.sessionId) this.cursors.set(envelope.sessionId, cursor);
  }

  private async answerServerRequest(transport: ClientTransport, id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onServerRequest;
    let response: string;
    if (!handler) {
      response = encodeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "server requests are not handled", data: { code: "METHOD_NOT_FOUND", message: "unhandled", retriable: false, traceId: "" } },
      });
    } else {
      try {
        response = encodeFrame({ jsonrpc: "2.0", id, result: await handler(method, params) });
      } catch (error) {
        const typed = toRacpError(error, "TOOL_FAILED");
        response = encodeFrame({ jsonrpc: "2.0", id, error: { code: -32000, message: typed.message, data: typed.toRemoteError("") } });
      }
    }
    if (transport === this.transport) transport.send(response);
  }

  private handleClose(transport: ClientTransport, info: { code: number; reason: string }): void {
    if (transport !== this.transport) return;
    this.transport = null;
    this.rejectPending(new RacpError("HOST_DISCONNECTED", `connection closed (${info.code} ${info.reason})`, { retriable: true }));
    if (this.closedByUser) {
      this.setState("disconnected");
      return;
    }
    const policy = this.options.reconnect;
    if (!policy?.enabled) {
      this.setState("disconnected", new RacpError("HOST_DISCONNECTED", `connection closed (${info.code} ${info.reason})`, { retriable: true }));
      return;
    }
    this.setState("reconnecting");
    this.reconnecting ??= this.reconnectLoop().finally(() => {
      this.reconnecting = null;
    });
  }

  private async reconnectLoop(): Promise<void> {
    const policy = this.options.reconnect!;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (!this.closedByUser) {
      this.reconnectAttempt += 1;
      if (policy.maxAttempts !== undefined && this.reconnectAttempt > policy.maxAttempts) {
        this.setState("error", new RacpError("HOST_DISCONNECTED", "reconnect attempts exhausted", { retriable: true }));
        return;
      }
      const delay = Math.min((policy.baseDelayMs ?? 500) * 2 ** (this.reconnectAttempt - 1), policy.maxDelayMs ?? 15_000);
      await sleep(delay);
      if (this.closedByUser) return;
      try {
        await this.open();
        this.reconnectAttempt = 0;
        this.setState("connected");
        await this.options.onReconnected?.(this);
        return;
      } catch (error) {
        this.options.log?.("warn", "racp reconnect failed", { attempt: this.reconnectAttempt, error: String(error) });
        this.transport = null;
      }
    }
  }

  private rejectPending(error: RacpError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: RacpClientState, error?: RacpError): void {
    this.stateValue = state;
    try {
      this.options.onStateChange?.(state, error);
    } catch {
      // A listener failure must not affect the connection.
    }
  }
}

function toRacpError(error: unknown, fallbackCode: string): RacpError {
  if (error instanceof RacpError) return error;
  const code = (error as { errorCode?: string })?.errorCode ?? fallbackCode;
  return new RacpError(code, error instanceof Error ? error.message : String(error), { retriable: true });
}
