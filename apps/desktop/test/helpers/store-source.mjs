import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const storeRoot = fileURLToPath(new URL("../../src/stores/", import.meta.url));

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

/** Read the composed store and every domain slice as one contract surface. */
export async function readStoreSource() {
  const paths = await sourceFiles(storeRoot);
  const order = [
    join(storeRoot, "app-state.ts"),
    join(storeRoot, "app-store.ts"),
    ...paths.filter((path) => !path.endsWith("/app-state.ts") && !path.endsWith("/app-store.ts")),
  ];
  const chunks = await Promise.all(
    order.map(async (path) => {
      const source = await readFile(path, "utf8");
      return `\n/* ${relative(storeRoot, path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}

export async function readStoreModule(relativePath) {
  return readFile(join(storeRoot, relativePath), "utf8");
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

export function readStoreSourceSync() {
  const paths = sourceFilesSync(storeRoot);
  const order = [
    join(storeRoot, "app-state.ts"),
    join(storeRoot, "app-store.ts"),
    ...paths.filter((path) => !path.endsWith("/app-state.ts") && !path.endsWith("/app-store.ts")),
  ];
  return order
    .map((path) => `\n/* ${relative(storeRoot, path)} */\n${readFileSync(path, "utf8")}`)
    .join("\n");
}

export function readStoreModuleSync(relativePath) {
  return readFileSync(join(storeRoot, relativePath), "utf8");
}
