import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Issue #507: packaged installs copy packages/agent-runtime/dist-bundle to
// resources/agent-runtime via electron-builder extraResources. The esbuild
// output is ESM (.js entry + import banner), but Node resolves module type
// from the nearest package.json. Without dist-bundle/package.json declaring
// "type":"module", sidecar.js loads as CommonJS and dies at startup.
//
// Tradeoff: the unit suite asserts the bundle-script contract (source + a
// real execution of the chained write step in a temp dir) instead of running
// full esbuild. A full bundle depends on a freshly built packages/shared/dist
// and takes multi-second CPU time, which is too heavy/flaky for this runner;
// packaging CI already rebuilds workspace deps before bundling.

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
    "extraResources must copy dist-bundle (including its package.json) to resources/agent-runtime",
  );
});

test("agent-runtime bundle emits an ESM sidecar entry", () => {
  assert.match(bundleScript, /esbuild\b/);
  assert.match(bundleScript, /--format=esm\b/);
  assert.match(bundleScript, /--outfile=dist-bundle\/sidecar\.js\b/);
});

test("agent-runtime bundle writes dist-bundle/package.json with type module", () => {
  // The write must be chained after esbuild so a successful bundle always
  // produces the ESM marker that electron-builder will ship beside sidecar.js.
  assert.match(
    bundleScript,
    /&&/,
    "bundle must chain the package.json write after esbuild so it cannot be skipped on success",
  );
  assert.match(
    bundleScript,
    /dist-bundle\/package\.json/,
    "bundle must write dist-bundle/package.json",
  );
  // Accept either JSON ("type":"module") or a JS object literal
  // ({ type: 'module' }) inside the chained node -e write.
  assert.match(
    bundleScript,
    /(?:["']type["']|type)\s*:\s*["']module["']/,
    'dist-bundle/package.json must set "type":"module"',
  );
});

test("the chained write step produces a package.json Node will treat as ESM", async () => {
  const writeStep = bundleScript
    .split("&&")
    .map((part) => part.trim())
    .find((part) => part.includes("dist-bundle/package.json"));

  assert.ok(
    writeStep,
    "bundle script must contain a chained write step for dist-bundle/package.json",
  );

  const workDir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-bundle-"));
  try {
    await mkdir(join(workDir, "dist-bundle"), { recursive: true });

    // Execute the real write command from package.json against a scratch
    // dist-bundle so the payload (not just the source string) is validated.
    execFileSync("bash", ["-c", writeStep], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const written = JSON.parse(
      await readFile(join(workDir, "dist-bundle/package.json"), "utf8"),
    );
    assert.equal(
      written.type,
      "module",
      'dist-bundle/package.json must declare {"type":"module"} so sidecar.js loads as ESM',
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("agent-runtime bundle declares the bundled-Node flag for the kernel extension loader", () => {
  // pi-coding-agent's extension loader embeds typebox and the kernel modules
  // only for compiled or bundled Node distributions. Without the define it
  // resolves them from the importing file, which a packaged install under
  // resources/agent-runtime cannot satisfy, so every native Pi extension fails
  // with "Cannot find module 'typebox'" (see bundle.test.ts for the behavior).
  assert.match(
    bundleScript,
    /--define:PI_BUNDLED_NODE=true\b/,
    "bundle must define PI_BUNDLED_NODE so the packaged sidecar can load native Pi extensions",
  );
});
