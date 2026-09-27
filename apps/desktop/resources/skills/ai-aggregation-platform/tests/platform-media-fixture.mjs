import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformMediaTool } from "../../../../electron/main/services/platform-media-service.ts";

const scriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
export const key = 'fixture-platform-key-"quote"';
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII=", "base64");
export const video = await readFile(join(fixtureRoot, "fixtures/clip.mp4"));

export async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(fixtureRoot, "runtime-"));
  const project = join(root, "project 中文 space");
  const dataDir = join(root, "data");
  const scratch = join(dataDir, "scratch", "session-a");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(scratch, { recursive: true }), mkdir(join(dataDir, "attachments"), { recursive: true })]);
  const requests = [];
  const acceptedImages = [];
  let mode = "normal";
  let onRequest;
  let requestNumber = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const row = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(row);
    onRequest?.(row);
    const reply = (body, status = 200, requestId = "fixture-request") => {
      res.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": requestId });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.method === "POST") {
      requestNumber++;
      if (mode === "drop") return req.socket.destroy();
      if (mode === "hold-post") return;
      if (mode === "secret-error") return reply({ error: `Upstream accidentally echoed ${key}` }, 400);
      if (req.url === "/v1/videos") return reply({ id: "task_fixture", status: "queued" });
      if (mode === "partial" && requestNumber === 1) return reply({ error: "One image rejected" }, 400);
      const id = `image-${requestNumber}`;
      acceptedImages.push(id);
      return reply({ data: [{ b64_json: png.toString("base64") }] }, 200, id);
    }
    if (req.url === "/v1/videos/task_fixture") return reply({ id: "task_fixture", status: mode === "failed" ? "failed" : "completed", progress: 100, error: mode === "failed" ? { message: "upstream failed" } : undefined });
    if (req.url === "/v1/videos/task_fixture/content") {
      if (mode === "hold-content") return;
      return reply(mode === "corrupt-video" ? Buffer.from("<html>error</html>") : video);
    }
    if (req.url === "/api/log/token") {
      const rows = acceptedImages.map((id) => ({ type: 2, quota: 5000, request_id: id, other: {} }));
      rows.push({ type: 2, quota: 100000, other: { task_id: "task_fixture", usage_facts: { seconds: 4, resolution: "768P" } } });
      if (mode === "failed") rows.push({ type: 6, quota: 100000, other: { task_id: "task_fixture" } });
      return reply({ success: true, data: rows });
    }
    if (req.url === "/api/status") return reply({ data: { quota_per_unit: 500000 } });
    reply({ error: "Unexpected fixture endpoint" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  // Substitute the external HTTP edge inside a REAL Python subprocess. The
  // production command, dispatcher, payloads, credentials, CLI, receipts and
  // filesystem all run normally. No production endpoint/env override exists.
  const bridge = join(root, "python-fixture.py");
  await writeFile(bridge, `import os, runpy, sys, urllib.parse, urllib.request
args = sys.argv[1:]
while args and args[0] in ('-B', '-s', '-E'):
    args.pop(0)
if args[0] == '-c':
    exec(args[1])
    sys.exit(0)
script = args.pop(0)
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(script))
import platform_client
original_init = platform_client.Client.__init__
class FixtureHTTP:
    def open(self, request, timeout=None):
        assert request.full_url.startswith('https://ai.yykkj.com/'), request.full_url
        assert 'OPENAI_API_KEY' not in os.environ
        assert 'AI_AGG_CONFIG_DIR' not in os.environ
        assert os.environ['AI_AGG_BASE_URL'] == 'https://ai.yykkj.com/v1'
        url = 'http://127.0.0.1:${server.address().port}' + urllib.parse.urlsplit(request.full_url).path
        request = urllib.request.Request(url, data=request.data, headers=dict(request.headers), method=request.get_method())
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)
def fixture_init(self, *args, **kwargs):
    original_init(self, *args, **kwargs)
    assert self.key == ${JSON.stringify(key)}
    assert self.base == 'https://ai.yykkj.com/v1'
    self.http = FixtureHTTP()
platform_client.Client.__init__ = fixture_init
sys.argv = [script] + args
runpy.run_path(script, run_name='__main__')
`);
  const provider = {
    id: "selected", vendorKey: "ai-aggregation-platform", enabled: true,
    baseUrl: "https://ai.yykkj.com/v1", authKind: "api_key", ...overrides.provider,
  };
  const calls = [];
  const host = { async call(method, args) {
    calls.push([method, args]);
    if (method === "session.get") return { session: { providerId: "selected", projectPath: project, ...overrides.session } };
    if (method === "settings.get") return overrides.settings ?? {};
    if (method === "providers.get") return { provider };
    if (method === "providers.getSecret") return { value: overrides.secret === undefined ? key : overrides.secret };
    if (method === "session.getScratchPath") return { path: scratch };
    throw new Error(`Unexpected host method ${method}`);
  } };
  const options = { dataDir, getHost: () => host, scriptsDir, python: { command: "python3", args: [bridge] }, ...overrides.options };
  const tool = createPlatformMediaTool(options);
  let callId = 0;
  return {
    root, project, dataDir, scratch, requests, calls, provider, options,
    setMode(value) { mode = value; },
    nextRequest(predicate) { return new Promise((resolve) => { onRequest = (row) => { if (predicate(row)) { onRequest = undefined; resolve(row); } }; }); },
    call(args, params = {}) { return tool({ sessionId: "session-a", toolCallId: `call-${++callId}`, args, signal: new AbortController().signal, ...params }); },
    posts() { return requests.filter((row) => row.method === "POST"); },
  };
}
