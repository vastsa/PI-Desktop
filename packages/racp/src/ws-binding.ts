import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL } from "@pi-desktop/shared";
import { WebSocket, WebSocketServer } from "ws";

import { isLoopbackAddress, type DeviceTokenAuthenticator } from "./auth.js";
import type { ClientTransport, ClientTransportFactory } from "./client.js";
import type { RacpServer, ServerConnectionTransport } from "./server.js";

export type WsBindingOptions = {
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  /** Loopback only unless TLS terminates in front (security §5.1); a non-loopback bind is refused here. */
  host?: string;
  port: number;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  heartbeatMs?: number;
};

export type WsBinding = {
  address: { host: string; port: number };
  close(): Promise<void>;
};

function wsTransport(socket: WebSocket): ServerConnectionTransport {
  return {
    send: (frame) => socket.send(frame),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "binary frames are not accepted");
          return;
        }
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
        handler(text, Buffer.byteLength(text, "utf8"));
      });
    },
    onClose: (handler) => {
      socket.once("close", handler);
      socket.once("error", () => handler());
    },
  };
}

/**
 * Bind the RACP server to a loopback WebSocket listener (spec §11.1). The
 * upgrade request carries the bearer credential; a token in the URL, a
 * non-loopback peer, a wrong path, or a missing subprotocol is refused
 * before any RPC runs.
 */
export async function bindRacpWebSocket(options: WsBindingOptions): Promise<WsBinding> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackAddress(host)) {
    throw Object.assign(new Error("pi-host binds loopback only; a non-loopback bind requires TLS"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  const http: Server = createServer((_request, response) => {
    response.statusCode = 426;
    response.setHeader("Upgrade", "websocket");
    response.end("RACP-WS endpoint");
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(RACP_WS_SUBPROTOCOL) ? RACP_WS_SUBPROTOCOL : false) });
  const sockets = new Set<WebSocket>();

  http.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const reject = (status: number, reason: string) => {
        options.log("warn", "racp upgrade refused", { reason, peer: request.socket.remoteAddress });
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (url.pathname !== RACP_WS_PATH) return reject(404, "Not Found");
      if (!isLoopbackAddress(request.socket.remoteAddress)) return reject(403, "Forbidden");
      const urlHasToken = [...url.searchParams.keys()].some((key) => /token|auth/i.test(key));
      const auth = await options.authenticator.authenticate({
        authorization: request.headers.authorization,
        urlHasToken,
        connectionId: "pending",
      });
      if (!auth) return reject(401, "Unauthorized");
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        ws.once("close", () => sockets.delete(ws));
        const connection = options.server.accept(auth, wsTransport(ws));
        if (!connection) return;
        // Heartbeat (spec §11.1): a peer that stops answering pings is dropped.
        let alive = true;
        ws.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, options.heartbeatMs ?? 30_000);
        heartbeat.unref?.();
        ws.once("close", () => clearInterval(heartbeat));
      });
    })().catch((error) => {
      options.log("error", "racp upgrade failed", { error: String(error) });
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.log("info", "racp listening", { host, port });
  return {
    address: { host, port },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export type WsClientOptions = {
  url: string;
  token: string;
  connectTimeoutMs?: number;
};

/** A `ws`-backed client transport for the header profile. */
export function wsClientTransport(options: WsClientOptions): ClientTransportFactory {
  return () =>
    new Promise<ClientTransport>((resolve, reject) => {
      const url = new URL(options.url);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        reject(Object.assign(new Error("RACP endpoint must be ws:// or wss://"), { errorCode: "REMOTE_CONNECTION_FAILED" }));
        return;
      }
      if (url.protocol === "ws:" && !isLoopbackAddress(url.hostname) && url.hostname !== "localhost") {
        reject(Object.assign(new Error("plain ws:// is accepted only on loopback"), { errorCode: "REMOTE_CONNECTION_FAILED" }));
        return;
      }
      const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], {
        headers: { Authorization: `Bearer ${options.token}` },
        handshakeTimeout: options.connectTimeoutMs ?? 10_000,
      });
      let settled = false;
      socket.once("open", () => {
        settled = true;
        resolve({
          send: (frame) => socket.send(frame),
          close: (code, reason) => socket.close(code ?? 1000, reason),
          onMessage: (handler) => {
            socket.on("message", (data, isBinary) => {
              if (isBinary) return;
              handler(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
            });
          },
          onClose: (handler) => socket.once("close", (code, reason) => handler({ code, reason: reason.toString() })),
          onError: (handler) => socket.on("error", handler),
        });
      });
      socket.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error(error.message), { errorCode: "REMOTE_CONNECTION_FAILED" }));
      });
      socket.once("unexpected-response", (_request, response) => {
        if (settled) return;
        settled = true;
        const code = response.statusCode === 401 || response.statusCode === 403 ? "REMOTE_AUTH_FAILED" : "REMOTE_CONNECTION_FAILED";
        reject(Object.assign(new Error(`upgrade refused: ${response.statusCode}`), { errorCode: code }));
        socket.terminate();
      });
    });
}
