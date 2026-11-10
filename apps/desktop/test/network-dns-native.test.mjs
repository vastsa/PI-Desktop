import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

test("native Chromium DoH and provider relay preserve DNS ownership across settings changes", {
  timeout: 75_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async t => {
  const root = repositoryRoot();
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "native-dns-acceptance-"));
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited.catch(() => {}); }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const certificate = join(root, "scripts/e2e/fixtures/certificates/localhost-cert.pem");
  const spki = createHash("sha256").update(new X509Certificate(await readFile(certificate))
    .publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  const bundle = join(temp, "main.cjs");
  const resultPath = join(temp, "result.json");
  await build({ entryPoints: [join(root, "apps/desktop/test/fixtures/network-dns-native.fixture.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"],
    absWorkingDir: root, logLevel: "silent", alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") } });
  const env = { ...process.env, PI_DNS_NATIVE_RESULT: resultPath, PI_DNS_NATIVE_CERT: certificate,
    PI_DNS_NATIVE_KEY: join(root, "scripts/e2e/fixtures/certificates/localhost-key.pem"),
    PI_DNS_NATIVE_USER_DATA: join(temp, "profile"), PI_DNS_NATIVE_SPKI: spki,
    PI_DESKTOP_AGENTS_DIR: join(temp, "agents") };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolveElectronBinary(root).electronBinary, [bundle], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", chunk => { output = (output + chunk).slice(-16000); }); }
  exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let exit;
  try { exit = await exited; } finally { clearTimeout(timer); }
  const result = JSON.parse(await readFile(resultPath, "utf8").catch(() => JSON.stringify({ ok: false, error: output })));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  assert.equal(exit.code, 0, output);
  assert.equal(result.checks.length, 7);
  t.diagnostic(result.checks.join("; "));
});
