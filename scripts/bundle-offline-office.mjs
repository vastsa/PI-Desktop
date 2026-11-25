import { constants } from "node:fs";
import { access, cp, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const plugin = new URL("../apps/desktop/resources/offline-office/", import.meta.url);
const ARM64 = 3; // electron-builder's Arch.arm64 in the afterPack context.

export async function verifyOfflineOfficeRuntime(runtime) {
  for (const interpreter of ["node/bin/node", "python/bin/python3.12"]) {
    await access(join(runtime, interpreter), constants.X_OK);
  }
  const { packages } = JSON.parse(await readFile(join(runtime, "metadata/package-lock.json"), "utf8"));
  if (packages?.["node_modules/docx"]?.version !== "9.16.0") {
    throw new Error("Expected docx 9.16.0 in the Office Runtime lockfile.");
  }
  for (const [relative, locked] of Object.entries(packages)) {
    if (relative === "") continue;
    if (!relative.startsWith("node_modules/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Invalid Office Runtime package path: ${relative}`);
    }
    const installed = JSON.parse(await readFile(join(runtime, "node/lib", relative, "package.json"), "utf8"));
    if (installed.version !== locked.version) throw new Error(`Office Runtime version mismatch: ${relative}`);
  }
  for (const module of ["lxml", "docx"]) {
    await access(join(runtime, "python/lib/python3.12/site-packages", module, "__init__.py"));
  }
  await access(join(runtime, "metadata/runtime-source.json"));
}

export default async function bundleOfflineOffice({ electronPlatformName, arch, appOutDir, targets }) {
  if (electronPlatformName !== "linux" || arch !== ARM64 || !targets.some((target) => target.name === "deb")) return;
  const runtime = process.env.PI_CODE_OFFICE_RUNTIME_DIR;
  if (!runtime) return;
  if (targets.length !== 1) throw new Error("Build the Offline Office Debian candidate with dist:kylin.");
  if (!isAbsolute(runtime)) {
    throw new Error("Set PI_CODE_OFFICE_RUNTIME_DIR to the absolute path of the staged ARM64 Office Runtime.");
  }
  await verifyOfflineOfficeRuntime(runtime);
  const resources = join(appOutDir, "resources");
  await cp(runtime, join(resources, "office-runtime"), { recursive: true, verbatimSymlinks: true });
  await cp(plugin, join(resources, "plugins", "pie.offline-office"), { recursive: true });
}
