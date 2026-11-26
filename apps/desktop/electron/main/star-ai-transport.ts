import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

type Selection = { accountId: number; group: string; models: readonly string[] };
type ChatBody = Record<string, unknown>;
type SubmitChat = (
  route: { accountId: number; group: string; model: string },
  body: ChatBody,
  signal: AbortSignal,
) => Promise<Response>;
const host = "127.0.0.1";
const maxBodyBytes = 32 * 1024 * 1024;

type Scope = {
  accountId: number;
  group: string;
  models: Set<string>;
  authorization: Buffer;
  revoked: AbortController;
};

function fail(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify({ error: { message } }));
}

async function receiveBody(request: IncomingMessage, response: ServerResponse): Promise<ChatBody | undefined> {
  if (Number(request.headers["content-length"]) > maxBodyBytes) {
    fail(response, 413, "Chat request is too large.");
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      fail(response, 413, "Chat request is too large.");
      return;
    }
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body as ChatBody;
  } catch {
    // Return the same client error for malformed JSON and invalid body shape.
  }
  fail(response, 400, "Expected a JSON chat request.");
}

async function handleChat(
  request: IncomingMessage,
  response: ServerResponse,
  scope: Scope | undefined,
  submit: SubmitChat,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.socket.remoteAddress !== host || request.headers.host !== `${host}:${request.socket.localPort}`
    || request.headers.origin !== undefined || request.headers.referer !== undefined
    || request.headers["sec-fetch-site"] !== undefined) {
    return fail(response, 403, "Native loopback requests only.");
  }
  if (request.url !== "/v1/chat/completions") return fail(response, 404, "Unknown endpoint.");
  if (request.method !== "POST") return fail(response, 405, "Expected POST.");
  const authorization = Buffer.from(request.headers.authorization ?? "");
  if (!scope || authorization.length !== scope.authorization.length || !timingSafeEqual(authorization, scope.authorization)) {
    return fail(response, 401, "The local StarAI connection is inactive.");
  }
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return fail(response, 415, "Expected application/json.");
  }
  const disconnected = new AbortController();
  response.once("close", () => disconnected.abort());
  const signal = AbortSignal.any([disconnected.signal, scope.revoked.signal]);
  const body = await receiveBody(request, response);
  if (!body) return;
  if (signal.aborted) return fail(response, 401, "The local StarAI connection has changed.");
  const model = body.model;
  if (typeof model !== "string" || !scope.models.has(model)) return fail(response, 403, "Model unavailable in the selected group.");
  const route = { accountId: scope.accountId, group: scope.group, model };
  const upstream = await submit(route, { ...body, group: route.group }, signal);
  if (signal.aborted || !upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    // Upstream diagnostics can include provider request headers. Expose only the status.
    const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return fail(response, status, `StarAI chat request failed (HTTP ${status}).`);
  }
  const mime = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!upstream.body || (mime !== "application/json" && mime !== "text/event-stream")) {
    await upstream.body?.cancel().catch(() => {});
    return fail(response, 502, "Unexpected StarAI chat response.");
  }
  response.writeHead(upstream.status, { "Content-Type": mime });
  response.flushHeaders();
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>), response, { signal });
}

/** Only the host receives the scoped loopback bearer. StarAI session credentials stay in main. */
export function createStarAiTransport(submit: SubmitChat) {
  let active: Scope | undefined;
  let generation = 0;
  let listener: ReturnType<typeof start> | undefined;

  function start() {
    const server = createServer((request, response) => {
      void handleChat(request, response, active, submit).catch(() => fail(response, 502, "StarAI connection failed."));
    });
    const ready = new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("StarAI loopback port unavailable."));
        resolve(address.port);
      });
    });
    server.unref();
    return { ready, server };
  }

  return {
    async bind({ accountId, group, models }: Selection) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0 || !group) {
        throw new Error("Invalid StarAI account or model selection.");
      }
      const current = listener ??= start();
      const revision = ++generation;
      let port: number;
      try {
        port = await current.ready;
      } catch (error) {
        if (listener === current) listener = undefined;
        throw error;
      }
      const secretValue = randomBytes(32).toString("base64url");
      const scope: Scope = {
        accountId, group, models: new Set(models), authorization: Buffer.from(`Bearer ${secretValue}`), revoked: new AbortController(),
      };
      let prepared = true;
      return {
        baseUrl: `http://${host}:${port}/v1`,
        secretValue,
        commit() {
          if (!prepared || current !== listener || revision !== generation) throw new Error("StarAI selection has changed.");
          prepared = false;
          active?.revoked.abort();
          active = scope;
        },
        rollback() { prepared = false; },
      };
    },
    close() {
      const current = listener;
      listener = undefined;
      ++generation;
      active?.revoked.abort();
      active = undefined;
      if (current) {
        const stop = () => {
          current.server.close();
          current.server.closeAllConnections();
        };
        if (current.server.listening) stop();
        else void current.ready.then(stop, () => {});
      }
    },
  };
}
