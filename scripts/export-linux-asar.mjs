import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

/** Architectures the Linux release matrix publishes. */
export const LINUX_RELEASE_ARCHES = ["x64", "arm64"];

/**
 * electron-builder writes the x64 unpacked tree as `linux-unpacked` and every
 * other architecture as `linux-<arch>-unpacked`.
 */
export function linuxUnpackedDirName(arch) {
  return arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
}

function assertReleaseArch(arch) {
  if (!LINUX_RELEASE_ARCHES.includes(arch)) {
    throw new Error(
      `Unsupported Linux release architecture: ${arch} (expected ${LINUX_RELEASE_ARCHES.join(" or ")}).`,
    );
  }
  return arch;
}

/**
 * Export the Linux app archive produced by electron-builder as a named release
 * asset. The archive is intentionally copied instead of repacked so the asset
 * is byte-identical to the app.asar used by the AppImage and deb outputs.
 *
 * `arch` selects the release lane: it names the asset and the electron-builder
 * unpacked directory the archive is read from, so the x64 and arm64 lanes can
 * never publish each other's archive.
 */
export async function exportLinuxAsar({
  rootDir = repositoryRoot,
  version,
  sourcePath,
  outputDir,
  arch = process.arch,
} = {}) {
  const releaseArch = assertReleaseArch(arch);
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
      `apps/desktop/release/${linuxUnpackedDirName(releaseArch)}/resources/app.asar`,
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
    `PI-Desktop-${releaseVersion}-linux-${releaseArch}.asar`,
  );
  await copyFile(source, destination);
  return { source, destination, version: releaseVersion, arch: releaseArch };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === scriptPath) {
  try {
    const archIndex = process.argv.indexOf("--arch");
    const arch = archIndex === -1 ? undefined : process.argv[archIndex + 1];
    const result = await exportLinuxAsar(arch ? { arch } : {});
    console.log(`Exported ${result.destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
