import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(packageRoot, "dist-bundle");
const banner = "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);";

export async function writeBundlePackageManifest(directory) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
}

export async function bundleAgentRuntime(outputDir = join(packageRoot, "dist-bundle")) {
  await mkdir(dirname(outputDir), { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(outputDir), ".dist-bundle-stage-"));
  const backupDir = join(dirname(outputDir), `.dist-bundle-backup-${randomUUID()}`);
  let previousOutputMoved = false;

  try {
    await build({
      entryPoints: [join(packageRoot, "src/sidecar.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      splitting: true,
      outdir: stagingDir,
      entryNames: "sidecar",
      chunkNames: "chunks/[name]-[hash]",
      define: { PI_BUNDLED_NODE: "true" },
      banner: { js: banner },
    });
    await writeBundlePackageManifest(stagingDir);

    try {
      await rename(outputDir, backupDir);
      previousOutputMoved = true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        // A first build has no previous output to preserve.
      } else {
        throw error;
      }
    }

    try {
      await rename(stagingDir, outputDir);
    } catch (error) {
      if (previousOutputMoved) {
        try {
          await rename(backupDir, outputDir);
          previousOutputMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Could not install the new sidecar bundle or restore the previous bundle",
          );
        }
      }
      throw error;
    }

    if (previousOutputMoved) {
      await rm(backupDir, { recursive: true });
      previousOutputMoved = false;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    if (!previousOutputMoved) await rm(backupDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleAgentRuntime();
}
