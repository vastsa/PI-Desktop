import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const mainRoot = fileURLToPath(new URL("../../electron/main/", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && path.endsWith(".ts") ? [path] : [];
      }),
  );
  return nested.flat();
}

/**
 * Source contract tests inspect behavior after the Electron main process was
 * split into IPC, runtime, bootstrap, and service modules.
 */
export async function readMainSource() {
  const paths = await sourceFiles(mainRoot);
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      return `\n/* ${relative(mainRoot, path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}

export async function readMainModule(relativePath) {
  return readFile(join(mainRoot, relativePath), "utf8");
}

function sourceFilesSync(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFilesSync(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    });
}

export function readMainSourceSync() {
  return sourceFilesSync(mainRoot)
    .map((path) => `\n/* ${relative(mainRoot, path)} */\n${readFileSync(path, "utf8")}`)
    .join("\n");
}

export function readMainModuleSync(relativePath) {
  return readFileSync(join(mainRoot, relativePath), "utf8");
}
