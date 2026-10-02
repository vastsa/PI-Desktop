import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bundleAgentRuntime,
  writeBundlePackageManifest,
} from "../../../packages/agent-runtime/scripts/bundle.mjs";

// The split ESM output uses relative chunk imports. Electron packaging copies
// the complete dist-bundle directory, including its module-type marker.
const desktopPackageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const agentRuntimePackageJson = JSON.parse(
  await readFile(
    new URL("../../../packages/agent-runtime/package.json", import.meta.url),
    "utf8",
  ),
);
const bundleScript = agentRuntimePackageJson.scripts.bundle ?? "";
const bundleSource = await readFile(
  new URL("../../../packages/agent-runtime/scripts/bundle.mjs", import.meta.url),
  "utf8",
);

test("desktop packaging ships the whole agent-runtime dist-bundle directory", () => {
  const entry = desktopPackageJson.build.extraResources.find(
    (resource) => resource.to === "agent-runtime",
  );

  assert.deepEqual(
    entry,
    {
      from: "../../packages/agent-runtime/dist-bundle",
      to: "agent-runtime",
    },
    "extraResources must copy the entry, package marker, and chunks to resources/agent-runtime",
  );
});

test("agent-runtime bundle uses hashed ESM chunks and a stable sidecar entry", () => {
  assert.equal(bundleScript, "node scripts/bundle.mjs");
  assert.match(bundleSource, /splitting:\s*true/);
  assert.match(bundleSource, /outdir:\s*stagingDir/);
  assert.match(bundleSource, /entryNames:\s*"sidecar"/);
  assert.match(bundleSource, /chunkNames:\s*"chunks\/\[name\]-\[hash\]"/);
  assert.match(bundleSource, /format:\s*"esm"/);
  assert.match(bundleSource, /createRequire as __piCreateRequire/);
  assert.match(bundleSource, /rename\(stagingDir, outputDir\)/);
});

test("agent-runtime bundle declares the bundled-Node flag for the extension loader", () => {
  assert.match(
    bundleSource,
    /define:\s*\{\s*PI_BUNDLED_NODE:\s*"true"\s*\}/,
    "bundle must define PI_BUNDLED_NODE for packaged native Pi extensions",
  );
});

test("the bundle manifest helper produces a package.json Node treats as ESM", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-bundle-"));
  try {
    const bundleDir = join(workDir, "dist-bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeBundlePackageManifest(bundleDir);

    const written = JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8"));
    assert.equal(
      written.type,
      "module",
      'dist-bundle/package.json must declare {"type":"module"} for the entry and chunks',
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test(
  "split sidecar starts outside node_modules and loads native session chunks on demand",
  { timeout: 60_000 },
  async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-sidecar-"));
    const bundleDir = join(workDir, "resources", "agent-runtime");
    let child;
    try {
      await mkdir(join(bundleDir, "chunks"), { recursive: true });
      await writeFile(join(bundleDir, "chunks", "stale.js"), "stale build output");
      await bundleAgentRuntime(bundleDir);
      assert.equal(
        (await readdir(join(bundleDir, "chunks"))).includes("stale.js"),
        false,
        "replacing a bundle must not ship stale chunks from an earlier build",
      );
      const sidecarSource = await readFile(join(bundleDir, "sidecar.js"), "utf8");
      assert.ok(
        Buffer.byteLength(sidecarSource) < 500 * 1024,
        `sidecar entry must stay below esbuild's 500 KiB size-warning threshold; got ${Buffer.byteLength(sidecarSource)} bytes`,
      );
      assert.match(sidecarSource, /import\(["']\.\/chunks\/native-pi-session-/);
      assert.match(sidecarSource, /import\(["']\.\/chunks\/runner-/);

      const childEnv = {
        ...process.env,
        HOME: workDir,
        USERPROFILE: workDir,
        TMPDIR: workDir,
      };
      delete childEnv.NODE_PATH;
      delete childEnv.PI_DESKTOP_PROXY_JSON;
      child = spawn(process.execPath, [join(bundleDir, "sidecar.js")], {
        cwd: workDir,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const received = new Map();
      const result = await new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let closed = false;
        let exitCode;
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
        const timer = setTimeout(() => {
          child.kill();
          fail(new Error(`sidecar bundle smoke timed out: ${stderr}`));
        }, 30_000);
        const finish = () => {
          if (settled || !closed || received.size !== 2) return;
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode, stderr });
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const lines = stdout.split("\n");
          stdout = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const message = JSON.parse(line);
            received.set(message.id, message);
          }
          finish();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => {
          fail(error);
        });
        child.on("close", (code) => {
          exitCode = code;
          closed = true;
          if (received.size !== 2) {
            fail(new Error(`sidecar closed before both responses arrived: ${stderr}`));
            return;
          }
          finish();
        });
        child.stdin.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sidecar.health", params: {} })}\n` +
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "native.session.list", params: {} })}\n`,
        );
      });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(received.get(1)?.result, { ok: true, runtimes: 0 });
      assert.deepEqual(received.get(2)?.result?.sessions, []);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill();
        await closed;
      }
      await rm(workDir, { recursive: true, force: true });
    }
  },
);
