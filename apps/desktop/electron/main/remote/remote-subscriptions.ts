import { isDurableEventKind, type RacpCursor, type RacpEventEnvelope } from "@pi-desktop/shared";
import type { RemoteHostClient } from "./remote-host-connection.js";

export type RemoteStream = {
  sessionId?: string;
  cursor?: RacpCursor;
  subscriptionId?: string;
  paused: boolean;
  seen: Set<string>;
  ack?: number;
  acknowledging?: Promise<void>;
};
type SubscribeResult = { subscriptionId: string; starting: RacpCursor; replayComplete: boolean };

/** Own only this consumer's subscriptions; other raw-event consumers stay untouched. */
export function createRemoteSubscriptions(options: {
  client: RemoteHostClient;
  alive: () => boolean;
  handle: (event: RacpEventEnvelope) => void;
  recover: (sessionId?: string) => void;
  log: (message: string, error: unknown) => void;
}) {
  const { client, alive, handle, recover, log } = options;
  const streams = new Map<string, RemoteStream>();
  const key = (id?: string) => id === undefined ? "host" : `session:${id}`;
  const current = (stream: RemoteStream) => alive() && streams.get(key(stream.sessionId)) === stream;
  const release = async (subscriptionId: string) => {
    try { await client.request("events/unsubscribe", { subscriptionId }); }
    catch (error) { log("remote unsubscribe failed", error); }
  };
  const ack = (stream: RemoteStream) => {
    if (!current(stream) || !stream.subscriptionId || stream.ack === undefined || stream.acknowledging) return;
    const id = stream.subscriptionId;
    stream.acknowledging = Promise.resolve().then(async () => {
      while (current(stream) && stream.subscriptionId === id && stream.ack !== undefined) {
        const sequence = stream.ack;
        stream.ack = undefined;
        await client.request("events/ack", { subscriptionId: id, sequence });
      }
    }).catch(error => {
      if (current(stream)) { log("remote event acknowledgement failed", error); recover(stream.sessionId); }
    }).finally(() => { stream.acknowledging = undefined; });
  };
  return {
    streams,
    get(sessionId?: string) { return streams.get(key(sessionId)); },
    async remove(sessionId?: string) {
      const stream = streams.get(key(sessionId));
      streams.delete(key(sessionId));
      if (stream?.subscriptionId) await release(stream.subscriptionId);
    },
    async subscribe(sessionId?: string, cursor?: RacpCursor): Promise<boolean> {
      const stream: RemoteStream = { ...(sessionId !== undefined ? { sessionId } : {}), ...(cursor ? { cursor } : {}), paused: false, seen: new Set() };
      streams.set(key(sessionId), stream);
      const result = await client.request<SubscribeResult>("events/subscribe", {
        scope: sessionId === undefined ? "host" : "session",
        ...(sessionId !== undefined ? { sessionId } : {}), ...(cursor ? { after: cursor } : {}),
      }).catch(error => { stream.paused = true; throw error; });
      if (!result?.subscriptionId || !result.starting || typeof result.starting.sequence !== "number") {
        stream.paused = true;
        throw new Error("remote events/subscribe returned no subscription cursor");
      }
      if (!current(stream)) { await release(result.subscriptionId); return false; }
      stream.subscriptionId = result.subscriptionId;
      stream.cursor ??= { epoch: result.starting.epoch, sequence: Math.max(0, result.starting.sequence - 1) };
      ack(stream); // Replay notifications may arrive before the subscribe response.
      return result.replayComplete !== false && !stream.paused;
    },
    handle(envelope: RacpEventEnvelope) {
      if (envelope.scope === "session" && !envelope.sessionId) return;
      const stream = streams.get(key(envelope.scope === "host" ? undefined : envelope.sessionId));
      if (!stream || !current(stream) || stream.paused) return;
      if (envelope.kind === "resync.required" || (stream.cursor && stream.cursor.epoch !== envelope.epoch)) {
        stream.paused = true;
        recover(stream.sessionId);
        return;
      }
      const durable = isDurableEventKind(envelope.kind) && typeof envelope.sequence === "number";
      if (durable) {
        stream.ack = Math.max(stream.ack ?? 0, envelope.sequence!);
        ack(stream);
        if (stream.cursor && envelope.sequence! <= stream.cursor.sequence) return;
        stream.cursor = { epoch: envelope.epoch, sequence: envelope.sequence! };
      } else {
        if (stream.seen.has(envelope.eventId)) return;
        stream.seen.add(envelope.eventId);
        if (stream.seen.size > 512) stream.seen.delete(stream.seen.values().next().value!);
      }
      handle(envelope);
    },
    closed(subscriptionId: string) {
      for (const stream of streams.values()) {
        if (stream.subscriptionId !== subscriptionId) continue;
        stream.subscriptionId = undefined;
        stream.paused = true;
        recover(stream.sessionId);
        return;
      }
    },
    pause() { for (const stream of streams.values()) stream.paused = true; },
    async clear(disconnected = false) {
      const ids = [...streams.values()].flatMap(s => s.subscriptionId ? [s.subscriptionId] : []);
      streams.clear();
      if (!disconnected) await Promise.all(ids.map(release));
    },
  };
}
