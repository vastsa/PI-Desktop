import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createGitCredentialProxy, type GitCredentialProxy, type GitProxyScope } from "./git-credential-proxy.js";

const TOKEN = "fixture-token-not-a-real-credential";
const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const WORK_BRANCH = "pi-desktop/8b54618f6bc1";
const scope: GitProxyScope = { installationId: INSTALLATION, sessionId: "session-1", repository: { owner: "octo", name: "repo" }, workBranch: WORK_BRANCH };
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };
type Reply = { status: number; headers: Record<string, string>; body: Buffer };
type Sent = { method?: string; headers?: Record<string, string>; body?: Buffer | Buffer[] };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A local server standing in for GitHub; it records everything it receives. */
async function upstream(respond: (seen: Seen) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(reply.status ?? 200, { "content-type": "application/x-git-result", ...reply.headers });
      res.end(reply.body ?? "upstream-ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function proxyFor(upstreamUrl: string, log?: Parameters<typeof createGitCredentialProxy>[0] extends infer O ? O extends { log?: infer L } ? L : never : never): Promise<GitCredentialProxy> {
  const proxy = createGitCredentialProxy({ upstream: upstreamUrl, ...(log ? { log } : {}) });
  await proxy.start();
  cleanup.push(() => proxy.close());
  return proxy;
}

function send(url: string, sent: Sent = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: sent.method ?? "GET", headers: sent.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    const body = sent.body;
    if (Array.isArray(body)) {
      // Chunked, in several writes, the way git streams a large pack.
      void (async () => {
        for (const chunk of body) { req.write(chunk); await new Promise((resolve) => setTimeout(resolve, 5)); }
        req.end();
      })();
    } else req.end(body);
  });
}

function pkt(line: string): Buffer {
  const body = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}
const FLUSH = Buffer.from("0000", "ascii");
const PACK = Buffer.concat([Buffer.from("PACK", "ascii"), Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))]);
const push = (...commands: string[]) => Buffer.concat([...commands.map((command, index) => pkt(index === 0 ? `${command}\u0000report-status side-band-64k\n` : `${command}\n`)), FLUSH, PACK]);
const RECEIVE_HEADERS = { "content-type": "application/x-git-receive-pack-request" };
const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;

describe("git credential proxy", () => {
  it("binds loopback and hands out one stable 256-bit handle per scope", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    const url = proxy.register(scope);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);
    expect(proxy.register({ ...scope })).toBe(url);
    const other = proxy.register({ ...scope, sessionId: "session-2", workBranch: "pi-desktop/000000000000" });
    expect(other).not.toBe(url);
    expect(other).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);
  });

  it("refuses to register before it is listening", () => {
    const proxy = createGitCredentialProxy({ upstream: "http://127.0.0.1:1" });
    expect(() => proxy.register(scope)).toThrow();
  });

  it("adds the basic credential to a scoped fetch and streams the answer back", async () => {
    const up = await upstream(() => ({ headers: { "x-upstream": "yes" }, body: "001e# service=git-upload-pack\n" }));
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const advertised = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`, { headers: { "git-protocol": "version=2", "user-agent": "git/2.43.0" } });
    expect(advertised.status).toBe(200);
    expect(advertised.body.toString()).toBe("001e# service=git-upload-pack\n");
    expect(advertised.headers["x-upstream"]).toBe("yes");
    const body = Buffer.from("0032want aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n00000009done\n");
    const fetched = await send(`${base}octo/repo.git/git-upload-pack`, { method: "POST", headers: { "content-type": "application/x-git-upload-pack-request" }, body });
    expect(fetched.status).toBe(200);
    expect(up.seen.map((entry) => [entry.method, entry.url, entry.headers.authorization])).toEqual([
      ["GET", "/octo/repo.git/info/refs?service=git-upload-pack", basic],
      ["POST", "/octo/repo.git/git-upload-pack", basic],
    ]);
    expect(up.seen[0]?.headers["git-protocol"]).toBe("version=2");
    expect(up.seen[0]?.headers["user-agent"]).toBe("git/2.43.0");
    expect(up.seen[1]?.body.equals(body)).toBe(true);
  });

  it("answers 401 with nothing upstream when the installation has no token", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    const base = proxy.register(scope);
    const first = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(first.status).toBe(401);
    // Another installation's token is not this scope's token.
    proxy.setToken("11111111-1111-4111-8111-111111111111", TOKEN);
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).status).toBe(401);
    expect(up.seen).toEqual([]);
  });

  it("fails closed as soon as the token is dropped", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/info/refs?service=git-upload-pack`;
    expect((await send(url)).status).toBe(200);
    proxy.setToken(INSTALLATION, null);
    const started = Date.now();
    expect((await send(url)).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(up.seen).toHaveLength(1);
  });

  it("answers 404 for an unknown or unregistered handle", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const origin = new URL(base).origin;
    for (const path of [`/${"f".repeat(64)}/octo/repo.git/info/refs?service=git-upload-pack`, "/octo/repo.git/info/refs?service=git-upload-pack", "/", "/short/octo/repo.git/info/refs"]) {
      expect((await send(`${origin}${path}`)).status, path).toBe(404);
    }
    proxy.unregister(INSTALLATION, "session-1");
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(404);
    expect(up.seen).toEqual([]);
    // A scope registered again gets a new handle; the old one stays dead.
    expect(proxy.register(scope)).not.toBe(base);
  });

  it("forwards any other repository without credentials", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (const path of ["other/public.git/info/refs?service=git-upload-pack", "octo/repo-two.git/info/refs?service=git-upload-pack", "octo/repo/info/refs?service=git-upload-pack", "Octo/Repo.git/info/refs?service=git-upload-pack"]) {
      expect((await send(`${base}${path}`)).status, path).toBe(200);
    }
    expect(up.seen.map((entry) => entry.url)).toEqual([
      "/other/public.git/info/refs?service=git-upload-pack",
      "/octo/repo-two.git/info/refs?service=git-upload-pack",
      "/octo/repo/info/refs?service=git-upload-pack",
      "/Octo/Repo.git/info/refs?service=git-upload-pack",
    ]);
    for (const entry of up.seen) expect(entry.headers.authorization).toBeUndefined();
  });

  it("never forwards the client's own credentials or cookies", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const headers = { authorization: "Basic Y2xpZW50OnN1cHBsaWVk", cookie: "session=client", "proxy-authorization": "Basic cHJveHk6Y2xpZW50" };
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`, { headers });
    await send(`${base}other/public.git/info/refs?service=git-upload-pack`, { headers });
    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]?.headers.authorization).toBe(basic);
    expect(up.seen[1]?.headers.authorization).toBeUndefined();
    for (const entry of up.seen) {
      expect(entry.headers.cookie).toBeUndefined();
      expect(entry.headers["proxy-authorization"]).toBeUndefined();
      expect(JSON.stringify(entry.headers)).not.toContain("Y2xpZW50OnN1cHBsaWVk");
    }
  });

  it("gives credentials only to the smart-HTTP endpoints of the scoped repository", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const anonymous: Array<[string, string]> = [
      ["GET", "octo/repo.git/info/refs"],
      ["GET", "octo/repo.git/info/refs?service=git-upload-archive"],
      ["GET", "octo/repo.git/info/refs?service=git-receive-pack&x=1"],
      ["POST", "octo/repo.git/git-receive-pack?x=1"],
      ["POST", "octo/repo.git/git-receive-pack/"],
      ["POST", "octo/repo.git/GIT-RECEIVE-PACK"],
      ["GET", "octo/repo.git/git-receive-pack"],
      ["GET", "octo/repo.git/objects/info/packs"],
      ["GET", "octo/repo.git/HEAD"],
    ];
    for (const [method, path] of anonymous) {
      const body = method === "POST" ? push(`${A} ${B} refs/heads/main`) : undefined;
      await send(`${base}${path}`, { method, ...(body ? { body } : {}) });
    }
    expect(up.seen).toHaveLength(anonymous.length);
    for (const entry of up.seen) expect(entry.headers.authorization, entry.url).toBeUndefined();
  });

  it("refuses paths that could be resolved to another repository upstream", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (const path of [
      "octo/repo.git/../../other/private.git/info/refs?service=git-upload-pack",
      "octo/repo.git/%2e%2e/%2e%2e/other/private.git/info/refs?service=git-upload-pack",
      "octo/repo.git/./info/refs?service=git-upload-pack",
      "octo/repo.git//info/refs?service=git-upload-pack",
      "octo/repo.git/info%2frefs?service=git-upload-pack",
      "octo/repo.git\\info\\refs",
      "octo/repo.git/info/refs;x?service=git-upload-pack",
    ]) {
      // `request` would normalize a URL object; send the raw path instead.
      const target = new URL(base);
      const reply = await new Promise<number>((resolve, reject) => {
        const req = request({ host: target.hostname, port: target.port, path: `${target.pathname}${path}`, method: "GET" }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end();
      });
      expect(reply, path).toBe(400);
    }
    expect(up.seen).toEqual([]);
  });

  it("forwards a push to the work branch byte for byte", async () => {
    const up = await upstream(() => ({ body: "000eunpack ok\n" }));
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const body = push(`${ZERO} ${B} refs/heads/${WORK_BRANCH}`);
    const reply = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body });
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("000eunpack ok\n");
    // The same push streamed in small chunks, split inside the command section.
    const chunked = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: [body.subarray(0, 10), body.subarray(10, 61), body.subarray(61, 2000), body.subarray(2000)] });
    expect(chunked.status).toBe(200);
    // And gzip-encoded, as git sends small requests.
    const zipped = gzipSync(body);
    const gzip = await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: zipped });
    expect(gzip.status).toBe(200);
    expect(up.seen).toHaveLength(3);
    for (const entry of up.seen) {
      expect(entry.method).toBe("POST");
      expect(entry.url).toBe("/octo/repo.git/git-receive-pack");
      expect(entry.headers.authorization).toBe(basic);
      expect(entry.headers["content-type"]).toBe("application/x-git-receive-pack-request");
    }
    expect(up.seen[0]?.body.equals(body)).toBe(true);
    expect(up.seen[1]?.body.equals(body)).toBe(true);
    expect(up.seen[2]?.body.equals(zipped)).toBe(true);
    expect(up.seen[2]?.headers["content-encoding"]).toBe("gzip");
  });

  it("forwards git's empty probe push, which names no ref", async () => {
    // For a pack larger than `http.postBuffer` git first POSTs a body that is
    // one flush packet, to settle authentication before it streams the pack.
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/git-receive-pack`;
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: FLUSH })).status).toBe(200);
    expect((await send(url, { method: "POST", headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: gzipSync(FLUSH) })).status).toBe(200);
    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]?.body.equals(FLUSH)).toBe(true);
    expect(up.seen[0]?.headers.authorization).toBe(basic);
    // Anything after the flush is not a probe.
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: Buffer.concat([FLUSH, FLUSH]) })).status).toBe(403);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: [FLUSH, PACK] })).status).toBe(403);
    expect(up.seen).toHaveLength(2);
    // Without a token the probe is refused like any other scoped request.
    proxy.setToken(INSTALLATION, null);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: FLUSH })).status).toBe(401);
    expect(up.seen).toHaveLength(2);
  });

  it("refuses a push that names any other ref before a byte reaches upstream", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/git-receive-pack`;
    const work = `${A} ${B} refs/heads/${WORK_BRANCH}`;
    const refused: Array<[string, Sent]> = [
      ["another branch", { body: push(`${A} ${B} refs/heads/main`) }],
      ["a delete of the base branch", { body: push(`${A} ${ZERO} refs/heads/main`) }],
      ["a tag", { body: push(`${ZERO} ${B} refs/tags/v1`) }],
      ["the work branch mixed with a tag", { body: push(work, `${ZERO} ${B} refs/tags/v1`) }],
      ["a foreign ref first, then the work branch", { body: push(`${A} ${B} refs/heads/main`, work) }],
      ["a prefix of the work branch", { body: push(`${A} ${B} refs/heads/pi-desktop/8b54618f6bc`) }],
      ["a longer name than the work branch", { body: push(`${A} ${B} refs/heads/${WORK_BRANCH}/x`) }],
      ["the work branch name outside refs/heads", { body: push(`${A} ${B} refs/tags/${WORK_BRANCH}`) }],
      ["a gzip-encoded foreign push", { headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: gzipSync(push(`${A} ${B} refs/heads/main`)) }],
      ["a body that is not gzip but says so", { headers: { ...RECEIVE_HEADERS, "content-encoding": "gzip" }, body: push(work) }],
      ["an unknown content encoding", { headers: { ...RECEIVE_HEADERS, "content-encoding": "br" }, body: push(work) }],
      ["a malformed command section", { body: Buffer.from("zzzz not pkt-lines") }],
      ["no commands at all", { body: Buffer.concat([FLUSH, PACK]) }],
      ["an empty body", { body: Buffer.alloc(0) }],
      ["a command section that never ends", { body: Buffer.concat(Array.from({ length: 900 }, () => pkt(`${A} ${B} refs/heads/${WORK_BRANCH}\n`))) }],
      ["a foreign ref streamed in pieces", { body: [pkt(`${A} ${B} refs/heads/${WORK_BRANCH}\u0000report-status\n`), pkt(`${A} ${B} refs/heads/main\n`), FLUSH, PACK] }],
    ];
    for (const [name, sent] of refused) {
      const reply = await send(url, { method: "POST", headers: RECEIVE_HEADERS, ...sent });
      expect(reply.status, name).toBe(403);
      expect(reply.body.toString().trim().split("\n"), name).toHaveLength(1);
    }
    expect(up.seen).toEqual([]);
    // The proxy still serves the next request.
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(work) })).status).toBe(200);
    expect(up.seen).toHaveLength(1);
  });

  it("re-registering a scope keeps its handle and applies the new work branch", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    expect(proxy.register({ ...scope, workBranch: "pi-desktop/000000000000" })).toBe(base);
    const url = `${base}octo/repo.git/git-receive-pack`;
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).status).toBe(403);
    expect((await send(url, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/pi-desktop/000000000000`) })).status).toBe(200);
  });

  it("answers 502 when upstream cannot be reached, without leaking the handle", async () => {
    const lines: string[] = [];
    const proxy = await proxyFor("http://127.0.0.1:1", (level, message, data) => lines.push(JSON.stringify({ level, message, data })));
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(502);
    const handle = new URL(base).pathname.split("/")[1]!;
    expect(reply.body.toString()).not.toContain(handle);
    expect(lines.join("\n")).not.toContain(handle);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("logs the session, never the token or the handle", async () => {
    const up = await upstream();
    const lines: string[] = [];
    const proxy = await proxyFor(up.url, (level, message, data) => lines.push(JSON.stringify({ level, message, data })));
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const handle = new URL(base).pathname.split("/")[1]!;
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    await send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/main`) });
    proxy.setToken(INSTALLATION, null);
    await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    await send(`${new URL(base).origin}/${"e".repeat(64)}/octo/repo.git/info/refs`);
    const text = lines.join("\n");
    expect(text).toContain("session-1");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(text).not.toContain(handle);
    expect(text).not.toContain("e".repeat(64));
  });

  it("stops answering after close", async () => {
    const up = await upstream();
    const proxy = createGitCredentialProxy({ upstream: up.url });
    await proxy.start();
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(200);
    await proxy.close();
    await expect(send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).rejects.toThrow();
    await proxy.close();
  });
});
