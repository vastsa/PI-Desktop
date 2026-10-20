#!/usr/bin/env node
/** Real Electron net.fetch + model discovery against an isolated TLS fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-client-certificate-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/provider-client-certificate.ts")],
    outfile: join(temp, "main.mjs"), bundle: true, platform: "node", format: "esm",
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    external: ["electron"],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.mjs"), temp,
    join(root, "scripts/e2e/fixtures/certificates")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /provider client certificate E2E passed/);
  } finally { clearTimeout(timer); }
} finally { await rm(temp, { recursive: true, force: true }); }
