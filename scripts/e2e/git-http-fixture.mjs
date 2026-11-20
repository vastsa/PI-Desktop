/**
 * A local stand-in for GitHub's git endpoint: one bare repository served over
 * smart HTTP by `git http-backend` (run as a CGI child), behind the basic
 * credential GitHub accepts for a token (`x-access-token:<token>`).
 *
 * It records every request (method, path, query, and whether a credential
 * was present) so a test can assert what did and did not reach "GitHub".
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

/**
 * @param {{ projectRoot: string, repositoryPath: string, token: string }} options
 *   `projectRoot` holds the bare repository at `repositoryPath`
 *   (for example `/octo/repo.git`).
 */
export async function startGitHttpFixture({ projectRoot, repositoryPath, token }) {
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  /** @type {Array<{ method: string, path: string, query: string, credential: boolean, authorized: boolean }>} */
  const requests = [];

  const server = createServer((req, res) => {
    const raw = req.url ?? "/";
    const mark = raw.indexOf("?");
    const path = mark < 0 ? raw : raw.slice(0, mark);
    const query = mark < 0 ? "" : raw.slice(mark + 1);
    const authorization = req.headers.authorization;
    const authorized = authorization === expected;
    requests.push({ method: req.method ?? "", path, query, credential: authorization !== undefined, authorized });
    if (!path.startsWith(`${repositoryPath}/`)) {
      req.resume();
      res.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
      return;
    }
    if (!authorized) {
      req.resume();
      res.writeHead(401, { "www-authenticate": 'Basic realm="git-http-fixture"', "content-type": "text/plain" }).end("Authentication required\n");
      return;
    }
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      GATEWAY_INTERFACE: "CGI/1.1",
      REQUEST_METHOD: req.method ?? "GET",
      PATH_INFO: path,
      QUERY_STRING: query,
      REMOTE_ADDR: "127.0.0.1",
      // An authenticated user is what lets http-backend accept a push.
      REMOTE_USER: "fixture",
      CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
      ...(req.headers["content-length"] !== undefined
        ? { CONTENT_LENGTH: String(req.headers["content-length"]) }
        : { HTTP_TRANSFER_ENCODING: "chunked" }),
      ...(req.headers["content-encoding"] !== undefined ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
      ...(req.headers["git-protocol"] !== undefined ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
    };
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.on("error", () => undefined);
    req.pipe(child.stdin);
    // CGI output: a header block, a blank line, then the body.
    let head = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk) => {
      if (headersSent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf("\r\n\r\n");
      let gap = 4;
      if (end < 0) { end = head.indexOf("\n\n"); gap = 2; }
      if (end < 0) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10) || 500;
        else headers[name] = value;
      }
      headersSent = true;
      res.writeHead(status, headers);
      const rest = head.subarray(end + gap);
      if (rest.length) res.write(rest);
    });
    child.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    child.on("close", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    res.on("close", () => { if (child.exitCode === null) child.kill(); });
  });
  server.requestTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
