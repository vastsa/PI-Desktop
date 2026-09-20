import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RACP_WS_SUBPROTOCOL } from "@pi-desktop/shared";

import { RacpClient } from "./client.js";
import { OWNER_TOKEN, harness } from "./test-harness.js";
import { bindRacpWebSocket, wsClientTransport } from "./ws-binding.js";

describe("RACP-WS over a loopback socket", () => {
  it("authenticates on the upgrade, runs the handshake, and delivers events over ws", async () => {
    const h = await harness();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    try {
      const url = `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`;
      const events: unknown[] = [];
      const client = new RacpClient({
        transport: wsClientTransport({ url, token: OWNER_TOKEN }),
        client: { name: "test", version: "0.15.0" },
        onEvent: (envelope) => events.push(envelope),
      });
      const init = await client.connect();
      expect(init.server.hostId).toBe("host_test");
      await client.request("session/attach", { sessionId: "s1" });
      await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
      await client.request("turn/start", { sessionId: "s1", input: { text: "hi" }, context: { requestId: "r1" } });
      h.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: 1, event: { type: "agent_start" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toHaveLength(1);
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.server.connectionCount()).toBe(0);
    } finally {
      await binding.close();
    }
  });

  it("refuses a missing credential, a token in the URL, a wrong path, and a binary frame", async () => {
    const h = await harness();
    const binding = await bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined });
    try {
      const base = `ws://127.0.0.1:${binding.address.port}`;
      const status = (url: string, headers: Record<string, string> = {}) =>
        new Promise<number | "open">((resolve) => {
          const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], { headers });
          socket.once("unexpected-response", (_request, response) => {
            resolve(response.statusCode ?? 0);
            socket.terminate();
          });
          socket.once("open", () => {
            resolve("open");
            socket.terminate();
          });
          socket.once("error", () => resolve(0));
        });
      expect(await status(`${base}/v1/racp/ws`)).toBe(401);
      expect(await status(`${base}/v1/racp/ws?token=${OWNER_TOKEN}`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe(401);
      expect(await status(`${base}/other`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe(404);
      expect(await status(`${base}/v1/racp/ws`, { Authorization: `Bearer ${OWNER_TOKEN}` })).toBe("open");
      await expect(new RacpClient({ transport: wsClientTransport({ url: `${base}/v1/racp/ws`, token: "pdt1.bad" }), client: { name: "t", version: "1" } }).connect()).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });

      const closeCode = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${base}/v1/racp/ws`, [RACP_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
        socket.once("open", () => socket.send(Buffer.from([1, 2, 3])));
        socket.once("close", (code) => resolve(code));
      });
      expect(closeCode).toBe(1003);
      // The client observed its own close frame; the server drops the
      // connection on its side of the socket's close event, which can lag
      // under parallel test load. Poll instead of asserting on the same tick.
      for (let i = 0; i < 100 && h.server.connectionCount() > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.server.connectionCount()).toBe(0);
    } finally {
      await binding.close();
    }
  });

  it("refuses to bind a non-loopback address and plain ws to a non-loopback host", async () => {
    const h = await harness();
    await expect(bindRacpWebSocket({ server: h.server, authenticator: h.authenticator, host: "0.0.0.0", port: 0, log: () => undefined })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
    await expect(wsClientTransport({ url: "ws://example.com/v1/racp/ws", token: OWNER_TOKEN })()).rejects.toMatchObject({ errorCode: "REMOTE_CONNECTION_FAILED" });
  });
});
