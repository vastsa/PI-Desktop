import { readFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createGitCredentialProxy, type GitCredentialProxy, type GitCredentialProxyOptions, type GitProxyScope } from "./git-credential-proxy.js";

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

async function proxyFor(
  upstreamUrl: string,
  logOrOptions?: GitCredentialProxyOptions["log"] | Omit<GitCredentialProxyOptions, "upstream">,
): Promise<GitCredentialProxy> {
  const extra = typeof logOrOptions === "function" ? { log: logOrOptions } : (logOrOptions ?? {});
  const proxy = createGitCredentialProxy({ upstream: upstreamUrl, env: {}, ...extra });
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

  it("destroys a connection that another local user opened, before reading a request", async () => {
    const up = await upstream();
    const lines: string[] = [];
    let uid: number | null = 4242;
    const lookups: Array<[number, number]> = [];
    const proxy = createGitCredentialProxy({
      upstream: up.url,
      env: {},
      log: (level, message, data) => lines.push(JSON.stringify({ level, message, data })),
      peerUid: (clientPort, proxyPort) => { lookups.push([clientPort, proxyPort]); return uid; },
    });
    await proxy.start();
    cleanup.push(() => proxy.close());
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    const url = `${base}octo/repo.git/info/refs?service=git-upload-pack`;
    // Another user knows the handle (it is in git's process arguments) and uses it.
    await expect(send(url)).rejects.toThrow();
    await expect(send(`${base}octo/repo.git/git-receive-pack`, { method: "POST", headers: RECEIVE_HEADERS, body: push(`${A} ${B} refs/heads/${WORK_BRANCH}`) })).rejects.toThrow();
    // A connection whose owner cannot be determined is refused too.
    uid = null;
    await expect(send(url)).rejects.toThrow();
    expect(up.seen).toEqual([]);
    expect(lookups.every(([clientPort, proxyPort]) => clientPort > 0 && proxyPort === Number(new URL(base).port))).toBe(true);
    // The same user is served.
    uid = process.getuid!();
    expect((await send(url)).status).toBe(200);
    expect(up.seen).toHaveLength(1);
    const text = lines.join("\n");
    expect(text).toContain("another user");
    expect(text).not.toContain(new URL(base).pathname.split("/")[1]!);
    expect(text).not.toContain(TOKEN);
  });

  it.runIf(process.platform === "linux")("recognizes its own connections through the kernel's socket table", async () => {
    // No injected lookup: the real `/proc/net/tcp` must name this process's uid.
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(200);
    }
  });

  it("setting a credential invalidates the installation's handles", async () => {
    const up = await upstream();
    const proxy = await proxyFor(up.url);
    proxy.setToken(INSTALLATION, TOKEN);
    const first = proxy.register(scope);
    const otherScope = { ...scope, installationId: "11111111-1111-4111-8111-111111111111" };
    proxy.setToken(otherScope.installationId, "other-fixture");
    const other = proxy.register(otherScope);
    const path = "octo/repo.git/info/refs?service=git-upload-pack";
    expect((await send(`${first}${path}`)).status).toBe(200);

    // The same token again still rotates: every credential set does.
    proxy.setToken(INSTALLATION, TOKEN);
    expect((await send(`${first}${path}`)).status).toBe(404);
    const second = proxy.register(scope);
    expect(second).not.toBe(first);
    expect(proxy.register(scope)).toBe(second);
    expect((await send(`${second}${path}`)).status).toBe(200);
    // Another installation's handles are untouched.
    expect(proxy.register(otherScope)).toBe(other);
    expect((await send(`${other}${path}`)).status).toBe(200);
    // Dropping the token does not rotate: the handle answers 401.
    proxy.setToken(INSTALLATION, null);
    expect(proxy.register(scope)).toBe(second);
    expect((await send(`${second}${path}`)).status).toBe(401);
    expect(up.seen).toHaveLength(3);
  });

  it("stops answering after close", async () => {
    const up = await upstream();
    const proxy = createGitCredentialProxy({ upstream: up.url, env: {} });
    await proxy.start();
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);
    expect((await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).status).toBe(200);
    await proxy.close();
    await expect(send(`${base}octo/repo.git/info/refs?service=git-upload-pack`)).rejects.toThrow();
    await proxy.close();
  });
});

const TEST_CERT_DIR = new URL("../../../scripts/e2e/fixtures/certificates/", import.meta.url);
const LOCALHOST_CERT = readFileSync(new URL("localhost-cert.pem", TEST_CERT_DIR));
const LOCALHOST_KEY = readFileSync(new URL("localhost-key.pem", TEST_CERT_DIR));

type SeenHttps = Seen & { servername: string | undefined };
type SeenConnect = { authority: string; headers: IncomingHttpHeaders };
type SeenProxyHttp = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

async function httpsUpstream(respond: (seen: SeenHttps) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})) {
  const seen: SeenHttps[] = [];
  const server = createHttpsServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const tlsSocket = req.socket as TLSSocket;
      const entry: SeenHttps = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
        servername: tlsSocket.servername || undefined,
      };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(reply.status ?? 200, { "content-type": "application/x-git-result", ...reply.headers });
      res.end(reply.body ?? "https-upstream-ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, url: `https://localhost:${port}` };
}

/** Local HTTP proxy supporting both `CONNECT` tunneling (for HTTPS) and absolute-form HTTP forwarding. */
async function httpProxyServer(options: {
  connectStatus?: number;
  stallConnect?: (socket: Socket) => void;
  requireProxyAuth?: string;
} = {}) {
  const connects: SeenConnect[] = [];
  const forwarded: SeenProxyHttp[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      forwarded.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (options.requireProxyAuth && req.headers["proxy-authorization"] !== options.requireProxyAuth) {
        res.writeHead(407, { "proxy-authenticate": "Basic realm=\"test\"" });
        res.end("proxy auth required");
        return;
      }
      const target = new URL(req.url ?? "");
      const forwardHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && k.toLowerCase() !== "proxy-authorization") forwardHeaders[k] = v;
      }
      const upstreamReq = request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstreamReq.on("error", () => {
        res.writeHead(502);
        res.end("bad gateway");
      });
      upstreamReq.end(body);
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    connects.push({ authority: req.url ?? "", headers: req.headers });

    if (options.stallConnect) {
      options.stallConnect(clientSocket);
      return;
    }
    if (options.requireProxyAuth && req.headers["proxy-authorization"] !== options.requireProxyAuth) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\n\r\n");
      return;
    }
    if (options.connectStatus && options.connectStatus !== 200) {
      clientSocket.end(`HTTP/1.1 ${options.connectStatus} Proxy Error\r\n\r\n`);
      return;
    }
    const authority = req.url ?? "";
    const colon = authority.lastIndexOf(":");
    const port = Number(authority.slice(colon + 1));
    const targetSocket = tcpConnect(port, "127.0.0.1", () => {
      sockets.add(targetSocket);
      targetSocket.on("close", () => sockets.delete(targetSocket));
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  return { connects, forwarded, port, url: `http://127.0.0.1:${port}` };
}

describe("git credential proxy upstream HTTP/HTTPS proxy support", () => {
  it("tunnels authenticated HTTPS git traffic via HTTP CONNECT without leaking GitHub Authorization on CONNECT", async () => {
    const up = await httpsUpstream(() => ({ body: "001e# service=git-upload-pack\n" }));
    const proxyUser = "corp-user";
    const proxyPass = "p@ss:w/rd#1";
    const expectedProxyAuth = `Basic ${Buffer.from(`${proxyUser}:${proxyPass}`, "utf8").toString("base64")}`;
    const corpProxy = await httpProxyServer({ requireProxyAuth: expectedProxyAuth });

    const proxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@127.0.0.1:${corpProxy.port}`;
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: proxyUrl },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    // 1. Authenticated GET info/refs through CONNECT tunnel.
    const advertised = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(advertised.status).toBe(200);
    expect(advertised.body.toString("utf8")).toBe("001e# service=git-upload-pack\n");

    // 2. Authenticated streaming POST git-receive-pack through CONNECT tunnel.
    const body = push(`${A} ${B} refs/heads/${WORK_BRANCH}`);
    const pushed = await send(`${base}octo/repo.git/git-receive-pack`, {
      method: "POST",
      headers: RECEIVE_HEADERS,
      body: [body.subarray(0, 20), body.subarray(20, 200), body.subarray(200)],
    });
    expect(pushed.status).toBe(200);

    expect(corpProxy.connects).toHaveLength(2);
    for (const connect of corpProxy.connects) {
      expect(connect.authority).toBe(`localhost:${up.port}`);
      expect(connect.headers.host).toBe(`localhost:${up.port}`);
      expect(connect.headers["proxy-authorization"]).toBe(expectedProxyAuth);
      // CRITICAL: GitHub Authorization must NEVER appear on the plaintext CONNECT request.
      expect(connect.headers.authorization).toBeUndefined();
      expect(JSON.stringify(connect.headers)).not.toContain(TOKEN);
      expect(JSON.stringify(connect.headers)).not.toContain(basic);
    }

    expect(up.seen).toHaveLength(2);
    expect(up.seen[0]!.url).toBe("/octo/repo.git/info/refs?service=git-upload-pack");
    expect(up.seen[0]!.headers.authorization).toBe(basic);
    expect(up.seen[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(up.seen[0]!.servername).toBe("localhost");

    expect(up.seen[1]!.url).toBe("/octo/repo.git/git-receive-pack");
    expect(up.seen[1]!.headers.authorization).toBe(basic);
    expect(up.seen[1]!.body.equals(body)).toBe(true);
    expect(up.seen[1]!.servername).toBe("localhost");
  });

  it("keeps TLS certificate verification enabled inside the CONNECT tunnel", async () => {
    const up = await httpsUpstream();
    const corpProxy = await httpProxyServer();
    // Intentionally omit `upstreamTls: { ca }` so the self-signed test cert is untrusted.
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: corpProxy.url },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(502);
    expect(corpProxy.connects).toHaveLength(1);
    // TLS verification failed before any HTTP request or GitHub credential was sent.
    expect(up.seen).toHaveLength(0);
  });

  it("bypasses the upstream proxy when NO_PROXY matches and connects directly", async () => {
    const up = await httpsUpstream();
    const corpProxy = await httpProxyServer();
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: corpProxy.url, NO_PROXY: "example.com, localhost" },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(200);
    expect(corpProxy.connects).toHaveLength(0);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.headers.authorization).toBe(basic);
  });

  it("returns 502 on CONNECT 407, CONNECT 502, connection refused, or unsupported proxy without leaking credentials", async () => {
    const up = await httpsUpstream();
    const proxySecret = "super-secret-proxy-password";
    const proxyUser = "proxy-secret-user";

    // 1. Proxy rejects CONNECT with 407.
    const authProxy = await httpProxyServer({ requireProxyAuth: "Basic ZGlmZmVyZW50OmNyZWQ=" });
    const logs: string[] = [];
    const log = (level: "info" | "warn", message: string, data?: unknown) => logs.push(JSON.stringify({ level, message, data }));
    const p407 = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${authProxy.port}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    p407.setToken(INSTALLATION, TOKEN);
    const r407 = await send(`${p407.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(r407.status).toBe(502);
    expect(r407.body.toString("utf8")).not.toContain(proxySecret);
    expect(r407.body.toString("utf8")).not.toContain(TOKEN);

    // 2. Proxy fails CONNECT with 502.
    const failProxy = await httpProxyServer({ connectStatus: 502 });
    const p502 = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${failProxy.port}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    p502.setToken(INSTALLATION, TOKEN);
    const r502 = await send(`${p502.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(r502.status).toBe(502);

    // 3. Proxy connection refused.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const pRefused = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `http://${proxyUser}:${proxySecret}@127.0.0.1:${deadPort}` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    pRefused.setToken(INSTALLATION, TOKEN);
    const rRefused = await send(`${pRefused.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(rRefused.status).toBe(502);

    // 4. Unsupported proxy scheme (socks5).
    const pSocks = await proxyFor(up.url, {
      log,
      env: { HTTPS_PROXY: `socks5://${proxyUser}:${proxySecret}@127.0.0.1:1080` },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    pSocks.setToken(INSTALLATION, TOKEN);
    const rSocks = await send(`${pSocks.register(scope)}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(rSocks.status).toBe(502);

    expect(up.seen).toHaveLength(0);
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(proxyUser);
    expect(allLogs).not.toContain(proxySecret);
    expect(allLogs).not.toContain(Buffer.from(`${proxyUser}:${proxySecret}`).toString("base64"));
    expect(allLogs).not.toContain(TOKEN);
    expect(allLogs).not.toContain(basic);
  });

  it("destroys an in-flight CONNECT tunnel when the client disconnects", async () => {
    const up = await httpsUpstream();
    let resolveConnectStarted!: () => void;
    let resolveConnectClosed!: () => void;
    const connectStarted = new Promise<void>((resolve) => { resolveConnectStarted = resolve; });
    const connectClosed = new Promise<void>((resolve) => { resolveConnectClosed = resolve; });

    const stalledProxy = await httpProxyServer({
      stallConnect(socket) {
        resolveConnectStarted();
        // Node HTTP server sockets are half-open by default; resume to observe client FIN.
        socket.resume();
        socket.once("end", () => { socket.destroy(); resolveConnectClosed(); });
        socket.once("close", () => resolveConnectClosed());
      },
    });
    const proxy = await proxyFor(up.url, {
      env: { HTTPS_PROXY: stalledProxy.url },
      upstreamTls: { ca: LOCALHOST_CERT },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const clientReq = request(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    clientReq.on("error", () => undefined);
    clientReq.end();

    await connectStarted;
    clientReq.destroy();
    await connectClosed;
    expect(up.seen).toHaveLength(0);
  });

  it("forwards http upstream requests through an HTTP proxy using absolute-form URI and Proxy-Authorization", async () => {
    const up = await upstream(() => ({ body: "http-via-proxy-ok" }));
    const proxyAuth = `Basic ${Buffer.from("http-user:http-pass", "utf8").toString("base64")}`;
    const corpProxy = await httpProxyServer({ requireProxyAuth: proxyAuth });

    const proxy = await proxyFor(`${up.url}/prefix`, {
      env: { HTTP_PROXY: `http://http-user:http-pass@127.0.0.1:${corpProxy.port}` },
    });
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register(scope);

    const reply = await send(`${base}octo/repo.git/info/refs?service=git-upload-pack`);
    expect(reply.status).toBe(200);
    expect(reply.body.toString("utf8")).toBe("http-via-proxy-ok");

    expect(corpProxy.connects).toHaveLength(0);
    expect(corpProxy.forwarded).toHaveLength(1);
    const seenAtProxy = corpProxy.forwarded[0]!;
    expect(seenAtProxy.url).toBe(`${up.url}/prefix/octo/repo.git/info/refs?service=git-upload-pack`);
    expect(seenAtProxy.headers.host).toBe(new URL(up.url).host);
    expect(seenAtProxy.headers["proxy-authorization"]).toBe(proxyAuth);

    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.url).toBe("/prefix/octo/repo.git/info/refs?service=git-upload-pack");
    expect(up.seen[0]!.headers.authorization).toBe(basic);
    expect(up.seen[0]!.headers.host).toBe(new URL(up.url).host);
  });
});
