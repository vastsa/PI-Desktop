import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-reference-upload-"));
process.env.PI_DESKTOP_DATA_DIR = join(root, "app-data");
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { pluginChildEnv } = await import("../electron/main/child-process-env.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
const ID = "test.reference-upload";
const PERMISSIONS = ["agent.tool.register", "fs.read", "net.fetch"];
const PNGS = [
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNYsGDBfxBmgDEAZTQLfV5zZ7gAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGNYsGDBfxhmQOYAANy1ETvlaRIjAAAAAElFTkSuQmCC",
].map((value) => Buffer.from(value, "base64"));
const MAIN = `
async function upload(input) {
  const capabilities = await pi.net.getCapabilities();
  if (capabilities.binaryRequestBody !== true || capabilities.maxBinaryBodyBytes < 16 * 1024 * 1024) {
    throw Object.assign(new Error('Binary upload is unavailable'), { code: 'UNSUPPORTED' });
  }
  const workspace = await pi.workspace.get();
  const boundary = 'fixture-reference-boundary';
  const parts = [Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="model"\\r\\n\\r\\ngpt-image-fixture\\r\\n')];
  for (let index = 0; index < input.paths.length; index++) {
    const image = await pi.fs.readPreview(input.paths[index], { workspacePath: input.workspacePath ?? workspace.path });
    if (image.kind !== 'image' || !image.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Expected PNG preview');
    const bytes = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if ((await pi.workspace.get()).path !== workspace.path) throw new Error('Workspace changed');
    parts.push(Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="image[]"; filename="reference-' + index + '.png"\\r\\nContent-Type: image/png\\r\\n\\r\\n'));
    parts.push(bytes, Buffer.from('\\r\\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\\r\\n'));
  const result = await pi.net.fetch({ url: input.url, method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    bodyBase64: Buffer.concat(parts).toString('base64'), redirect: 'error' });
  return { workspace: workspace.path, status: result.status, body: result.bodyText };
}
module.exports = { onLoad: async () => pi.agent.registerTool({
  name: 'upload_reference', description: 'Upload designated reference images', schema: { type: 'object' }, execute: upload
}) };
`;

async function fixture(t, { grants = PERMISSIONS, domains = ["127.0.0.1"] } = {}) {
  const directory = mkdtempSync(join(root, "fixture-"));
  const plugin = join(directory, "plugin");
  const workspace = join(directory, "session-project");
  const visible = join(directory, "visible-project");
  for (const path of [plugin, workspace, visible]) mkdirSync(path);
  const paths = ["bone-media/references/first.png", "bone-media/references/second.png"];
  for (const project of [workspace, visible]) {
    mkdirSync(join(project, "bone-media/references"), { recursive: true });
    paths.forEach((path, index) => writeFileSync(join(project, path), PNGS[project === workspace ? index : 1 - index]));
    writeFileSync(join(project, "outside.png"), PNGS[0]);
  }
  writeFileSync(join(plugin, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: ID, name: "Reference upload", version: "0.1.0", main: "main.cjs",
    permissions: PERMISSIONS, fs: { read: { root: "workspace", scope: ["bone-media/references/**"] } }, net: { domains },
  }));
  writeFileSync(join(plugin, "main.cjs"), MAIN);
  const children = [], audits = [], requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const runtime = new PluginRuntime({
    hostEntry,
    getWorkspacePath: () => visible,
    getWorkspacePathForSession: (id) => id === "request-session" ? workspace : null,
    getWorkspaceInfo: (path = visible) => ({ path, name: "Fixture project" }),
    audit: (entry) => audits.push(entry),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { env: pluginChildEnv(ID), stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout.resume(); child.stderr.resume(); children.push(child);
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload(ID);
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? undefined : new Promise((resolve) => child.once("exit", resolve))));
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await runtime.loadFromPath(plugin, grants);
  const tool = runtime.getTools().find((tool) => tool.pluginId === ID && tool.name === "upload_reference");
  assert.ok(tool);
  const url = `http://127.0.0.1:${server.address().port}/images/edits`;
  return { workspace, visible, paths, requests, audits,
    upload: (input = {}) => tool.execute({ url, paths, ...input }, { sessionId: "request-session", turnId: "fixture-turn", mode: "agent" }) };
}

test("reference upload uses the invoking session's scoped PNG bytes in original order", async (t) => {
  const f = await fixture(t);
  const result = await f.upload({ sessionId: "untrusted-visible-session" });
  assert.equal(result.workspace, f.workspace);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/images/edits");
  const form = await new Response(request.body, { headers: { "content-type": request.headers["content-type"] } }).formData();
  assert.equal(form.get("model"), "gpt-image-fixture");
  const images = form.getAll("image[]");
  assert.equal(images.length, 2);
  for (const [index, image] of images.entries()) {
    assert.equal(image.name, `reference-${index}.png`);
    assert.equal(image.type, "image/png");
    const actual = Buffer.from(await image.arrayBuffer());
    assert.deepEqual(actual, PNGS[index]);
    assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(PNGS[index]).digest("hex"));
  }
  assert.equal(form.has("input_fidelity"), false);
  assert.equal(f.audits.filter((entry) => entry.api === "fs.readPreview" && entry.ok).length, 2);
  assert.ok(f.audits.some((entry) => entry.api === "net.fetch" && entry.ok));
  for (const image of PNGS) assert.ok(!JSON.stringify(f.audits).includes(image.toString("base64")));
});

test("reference uploads reject missing grants, denied domains, scope and stale workspace before HTTP", async (t) => {
  for (const permission of ["fs.read", "net.fetch"]) {
    const f = await fixture(t, { grants: PERMISSIONS.filter((value) => value !== permission) });
    await assert.rejects(f.upload(), { code: "PERMISSION_DENIED" });
    assert.equal(f.requests.length, 0);
  }
  const domain = await fixture(t, { domains: [] });
  await assert.rejects(domain.upload(), { code: "PERMISSION_DENIED" });
  assert.equal(domain.requests.length, 0);
  const scoped = await fixture(t);
  await assert.rejects(scoped.upload({ paths: ["outside.png"] }), { code: "PERMISSION_DENIED" });
  await assert.rejects(scoped.upload({ workspacePath: scoped.visible }), { code: "WORKSPACE_CHANGED" });
  assert.equal(scoped.requests.length, 0);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
