import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

/**
 * Export the Linux app archive produced by electron-builder as a named release
 * asset. The archive is intentionally copied instead of repacked so the asset
 * is byte-identical to the app.asar used by the AppImage and deb outputs.
 */
export async function exportLinuxAsar({
  rootDir = repositoryRoot,
  version,
  sourcePath,
  outputDir,
} = {}) {
  const packagePath = join(rootDir, "apps/desktop/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const releaseVersion = version ?? packageJson.version;
  if (typeof releaseVersion !== "string" || releaseVersion.trim() === "") {
    throw new Error(`Missing desktop package version in ${packagePath}`);
  }

  const source =
    sourcePath ??
    join(
      rootDir,
      "apps/desktop/release/linux-unpacked/resources/app.asar",
    );
  const destinationDirectory =
    outputDir ?? join(rootDir, "apps/desktop/release");
  const sourceStats = await stat(source).catch(() => null);
  if (!sourceStats?.isFile()) {
    throw new Error(`Linux ASAR source not found: ${source}`);
  }

  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(
    destinationDirectory,
    `PI-Desktop-${releaseVersion}-linux-x64.asar`,
  );
  await copyFile(source, destination);
  return { source, destination, version: releaseVersion };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  try {
    const result = await exportLinuxAsar();
    console.log(`Exported ${result.destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
