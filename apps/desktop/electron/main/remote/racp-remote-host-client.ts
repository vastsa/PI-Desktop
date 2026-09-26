/**
 * RACP-WS-backed {@link RemoteHostClient}: adapts the single-callback
 * `RacpClient.onEvent` seam into the multi-listener `subscribe()` shape
 * `RemoteHostConnection` consumes. This is the only file in
 * `electron/main/remote/` that speaks the `@pi-desktop/racp` protocol
 * package; everything above it is transport-agnostic.
 *
 * Ownership stays inside Electron Main. The transport factory is injected —
 * production wires it to {@link wsClientTransport} against a paired host, and
 * tests wire it to the in-memory `MemoryLink` from
 * `packages/racp/src/test-harness.ts` so the adapter exercises the real
 * `RacpClient` state machine without a socket.
 */
import {
  RacpClient,
  wsClientTransport,
  type ClientTransportFactory,
  type RacpClientState,
  type SubscriptionClosedNotice,
} from "@pi-desktop/racp";
import { ErrorCodes, type RacpCursor, type RacpEventEnvelope, type RacpInitializeResult } from "@pi-desktop/shared";
import type { RemoteHostClient } from "./remote-host-connection.js";

export type PairingExchangeOptions = {
  /** Loopback RACP endpoint, either pasted by the user or forwarded by us. */
  url: string;
  /** Single-use `ppt1.` token the host printed at start. */
  pairingToken: string;
  /** Device label the host records against the minted device. */
  label: string;
  clientInfo: { name: string; version: string };
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

/**
 * Spend a single-use pairing token on a throwaway connection and return the
 * durable `pdt1.` device token the host minted (spec §3.4).
 *
 * The connection is closed on every path — success, refusal, and transport
 * failure — because the token is consumed by the exchange and a lingering
 * unprivileged socket would only keep a half-paired session open.
 */
export async function exchangePairingToken(options: PairingExchangeOptions): Promise<string> {
  const pairing = createRacpRemoteHostClient({
    transport: wsClientTransport({ url: options.url, token: options.pairingToken }),
    clientInfo: options.clientInfo,
    log: options.log,
  });
  try {
    await pairing.connect();
    const result = (await pairing.client.request("connection/pair", {
      deviceLabel: options.label,
    })) as { deviceToken?: unknown };
    if (typeof result?.deviceToken !== "string" || result.deviceToken.length === 0) {
      throw Object.assign(new Error("pi-host did not return a device token"), {
        errorCode: ErrorCodes.PAIRING_FAILED,
      });
    }
    return result.deviceToken;
  } finally {
    await pairing.close().catch(() => undefined);
  }
}

export type RacpRemoteHostClientOptions = {
  transport: ClientTransportFactory;
  /** Identity sent in `connection/initialize`; the host records it as the device label. */
  clientInfo: { name: string; version: string };
  /** Deadline for a single request; the RACP default of 15s is used when omitted. */
  requestTimeoutMs?: number;
  /** Reconnect policy; the RACP client stays disconnected when omitted. */
  reconnect?: {
    enabled: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type RacpRemoteHostClient = {
  /** The multi-listener {@link RemoteHostClient} the connection module consumes. */
  readonly client: RemoteHostClient;
  /** Underlying RACP client state, for boot diagnostics and the future host card. */
  readonly state: () => RacpClientState;
  /** Open the transport and initialize the RACP session. */
  connect(): Promise<void>;
  /** Close the transport; safe to call before {@link connect} and after failure. */
  close(): Promise<void>;
};

/**
 * The adapter multiplexes {@link RacpClient.onEvent} — a single-slot callback
 * — into the `subscribe()` API {@link RemoteHostConnection} expects. Fan-out
 * is intentional: Stage 5 (terminal) and Stage 3b (resync watchdog) will
 * attach their own listeners on the same client.
 */
export function createRacpRemoteHostClient(
  options: RacpRemoteHostClientOptions,
): RacpRemoteHostClient {
  const listeners = new Set<(envelope: RacpEventEnvelope) => void>();
  const closedListeners = new Set<(notice: SubscriptionClosedNotice) => void>();
  const serverRequestListeners = new Set<(method: string, params: unknown) => Promise<unknown>>();
  const stateListeners = new Set<(state: RacpClientState, error?: unknown) => void>();
  const reconnectedListeners = new Set<() => Promise<void> | void>();
  const fanOut = <T>(targets: Set<(value: T) => void>, value: T) => {
    for (const listener of targets) {
      try {
        listener(value);
      } catch (error) {
        options.log?.("warn", "remote event listener threw", { error: String(error) });
      }
    }
  };
  const racp = new RacpClient({
    transport: options.transport,
    client: options.clientInfo,
    capabilities: { toolRelay: true, toolRelayCancel: true },
    onServerRequest: async (method, params) => {
      if (serverRequestListeners.size !== 1) {
        throw Object.assign(new Error("remote server request has no unique Desktop handler"), {
          errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE,
        });
      }
      const listener = serverRequestListeners.values().next().value;
      if (!listener) {
        throw Object.assign(new Error("remote server request is not handled"), {
          errorCode: ErrorCodes.METHOD_NOT_FOUND,
        });
      }
      return listener(method, params);
    },
    onEvent: (envelope) => fanOut(listeners, envelope),
    onSubscriptionClosed: (notice) => fanOut(closedListeners, notice),
    onStateChange: (state, error) => {
      for (const listener of stateListeners) {
        try {
          listener(state, error);
        } catch (listenerError) {
          options.log?.("warn", "remote state listener threw", { error: String(listenerError) });
        }
      }
    },
    onReconnected: async () => {
      for (const listener of reconnectedListeners) {
        try {
          await listener();
        } catch (error) {
          // A consumer callback failure must not strand the RACP transport in
          // its reconnect loop; the next explicit state change remains usable.
          options.log?.("warn", "remote reconnect listener threw", { error: String(error) });
        }
      }
    },
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const client: RemoteHostClient = {
    request: (method, params) => racp.request(method, params),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onSubscriptionClosed(listener) {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    onServerRequest(listener) {
      serverRequestListeners.add(listener);
      return () => {
        serverRequestListeners.delete(listener);
      };
    },
    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onReconnected(listener) {
      reconnectedListeners.add(listener);
      return () => {
        reconnectedListeners.delete(listener);
      };
    },
    limits: () => racp.initialized?.limits,
    hostCapabilities: () => racp.initialized?.capabilities,
    initialized: (): RacpInitializeResult | undefined => racp.initialized ?? undefined,
    cursorFor: (sessionId: string): RacpCursor | undefined => racp.cursorFor(sessionId),
    cursorForHost: (): RacpCursor | undefined => racp.cursorForHost(),
  };
  return {
    client,
    state: () => racp.state,
    async connect() {
      await racp.connect();
    },
    async close() {
      await racp.close();
    },
  };
}
