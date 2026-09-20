#!/usr/bin/env node
/** Real desktop launcher -> bundled sidecar -> pi-ai -> local HTTPS fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-certificates-"));
const fixture = join(root, "scripts/e2e/fixtures/certificates");
const cert = await readFile(join(fixture, "localhost-cert.pem"));
const key = await readFile(join(fixture, "localhost-key.pem"));
let handshakes = 0;
const server = createServer({ key, cert }, (_request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { id: "tls-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello from TLS" }, finish_reason: null }] };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
});
server.on("connection", () => { handshakes++; });
async function run(host, expected, extra) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "PI_DESKTOP_PROXY_JSON"])
    delete env[name];
  if (extra) env.NODE_EXTRA_CA_CERTS = join(fixture, "localhost-cert.pem");
  const before = handshakes;
  const child = spawn(electronBinary, [join(temp, "parent.mjs"), temp,
    `https://${host}:${server.address().port}/v1`, expected], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill(), 30_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timeout); }
  assert.equal(code, 0, output);
  assert.equal(handshakes - before, 1, "a certificate failure must not retry TLS");
  console.log(output.trim());
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await mkdir(join(temp, "agent-runtime"));
  await writeFile(join(temp, "agent-runtime/package.json"), '{"type":"module"}');
  await build({ entryPoints: [join(root, "packages/agent-runtime/src/sidecar.ts")],
    outfile: join(temp, "agent-runtime/sidecar.js"), bundle: true, platform: "node", format: "esm",
    define: { PI_BUNDLED_NODE: "true" },
    banner: { js: `import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);
import __certificateProbeTls from 'node:tls';
{ const tls = __certificateProbeTls; const defaults = new Set(tls.getCACertificates('default'));
process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'test.trust',params:{systemCount:tls.getCACertificates('system').length,systemIncluded:tls.getCACertificates('system').every(c=>defaults.has(c)),extraIncluded:tls.getCACertificates('extra').every(c=>defaults.has(c))}})+'\\n'); }` },
  });
  await build({ entryPoints: [join(root, "scripts/e2e/provider-certificate-sidecar.ts")],
    outfile: join(temp, "parent.mjs"), bundle: true, platform: "node", format: "esm",
    alias: { "@pi-desktop/host-runtime": join(root, "packages/host-runtime/src/agent-sidecar.ts") },
    banner: { js: "import { createRequire } from 'node:module'; import { dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; const require = createRequire(import.meta.url); const __dirname = dirname(fileURLToPath(import.meta.url));" },
  });
  await run("localhost", "DEPTH_ZERO_SELF_SIGNED_CERT", false);
  await run("localhost", "success", true);
  await run("127.0.0.1", "ERR_TLS_CERT_ALTNAME_INVALID", true);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
