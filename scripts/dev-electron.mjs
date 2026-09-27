#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "PI-Desktop";
const DEV_BUNDLE_ID = "com.pi-desktop.app.dev";
const BRANDING_SCHEMA = "v2";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ROOT = join(ROOT, "apps", "desktop");

function resolvePackagePath(packageName) {
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  return require.resolve(`${packageName}/package.json`);
}

function resolveElectronInstallation() {
  const packagePath = resolvePackagePath("electron");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  const executable = require("electron");
  return {
    executablePath: executable,
    version,
  };
}

function setPlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
}

export function prepareMacDevelopmentBundle({
  electronExecutable,
  electronVersion,
  iconPath,
  cacheRoot,
  sign = true,
}) {
  const sourceBundle = dirname(dirname(dirname(electronExecutable)));
  const iconHash = createHash("sha256")
    .update(readFileSync(iconPath))
    .digest("hex")
    .slice(0, 12);
  const cacheKey = `${electronVersion}-${iconHash}-${BRANDING_SCHEMA}`;
  const targetRoot = join(cacheRoot, cacheKey);
  const targetBundle = join(targetRoot, `${APP_NAME}.app`);
  const targetExecutable = join(
    targetBundle,
    "Contents",
    "MacOS",
    APP_NAME,
  );
  const markerPath = join(targetRoot, "ready.json");

  if (existsSync(markerPath) && existsSync(targetExecutable)) {
    return targetExecutable;
  }

  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = join(cacheRoot, `${cacheKey}.staging-${process.pid}`);
  const stagingBundle = join(stagingRoot, `${APP_NAME}.app`);
  rmSync(stagingRoot, { recursive: true, force: true });

  try {
    cpSync(sourceBundle, stagingBundle, {
      recursive: true,
      verbatimSymlinks: true,
    });

    const contents = join(stagingBundle, "Contents");
    const macos = join(contents, "MacOS");
    const resources = join(contents, "Resources");
    const sourceExecutable = join(macos, "Electron");
    const brandedExecutable = join(macos, APP_NAME);
    renameSync(sourceExecutable, brandedExecutable);
    copyFileSync(iconPath, join(resources, "icon.icns"));

    const plistPath = join(contents, "Info.plist");
    setPlistString(plistPath, "CFBundleDisplayName", APP_NAME);
    setPlistString(plistPath, "CFBundleName", APP_NAME);
    setPlistString(plistPath, "CFBundleExecutable", APP_NAME);
    setPlistString(plistPath, "CFBundleIdentifier", DEV_BUNDLE_ID);
    setPlistString(plistPath, "CFBundleIconFile", "icon.icns");

    if (sign) {
      // macOS no longer supports `codesign --deep` reliably on Electron
      // app bundles (returns "bundle format is ambiguous" on frameworks).
      // The bundled frameworks are already signed by Electron; we only
      // need to re-sign the top-level app since we changed Info.plist.
      execFileSync("codesign", [
        "--force",
        "--sign",
        "-",
        stagingBundle,
      ]);
    }

    writeFileSync(
      join(stagingRoot, "ready.json"),
      `${JSON.stringify({ electronVersion, iconHash })}\n`,
    );
    renameSync(stagingRoot, targetRoot);
    return targetExecutable;
  } catch (error) {
    const cacheWonRace =
      (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") &&
      existsSync(markerPath) &&
      existsSync(targetExecutable);
    rmSync(stagingRoot, { recursive: true, force: true });
    if (cacheWonRace) return targetExecutable;
    throw error;
  }
}

function run() {
  const env = { ...process.env, PI_DESKTOP_DEV: "1" };
  if (process.platform === "darwin") {
    const electron = resolveElectronInstallation();
    env.ELECTRON_EXEC_PATH = prepareMacDevelopmentBundle({
      electronExecutable: electron.executablePath,
      electronVersion: electron.version,
      iconPath: join(DESKTOP_ROOT, "build", "icon.icns"),
      cacheRoot: join(ROOT, ".cache", "electron-dev"),
    });
  }

  const electronVitePackage = resolvePackagePath("electron-vite");
  const electronViteCli = join(
    dirname(electronVitePackage),
    "bin",
    "electron-vite.js",
  );
  const child = spawn(
    process.execPath,
    [electronViteCli, "dev", ...process.argv.slice(2)],
    {
      cwd: DESKTOP_ROOT,
      env,
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
