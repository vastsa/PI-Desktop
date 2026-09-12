import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sharedSourceRoot = fileURLToPath(new URL("../../../../packages/shared/src/", import.meta.url));
const typesRoot = join(sharedSourceRoot, "types");

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

/** Read the compatibility facade and every split public type module together. */
export async function readSharedTypesSource() {
  const facade = join(sharedSourceRoot, "types.ts");
  const paths = [facade, ...(await sourceFiles(typesRoot))];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      return `\n/* ${relative(sharedSourceRoot, path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
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

export function readSharedTypesSourceSync() {
  const facade = join(sharedSourceRoot, "types.ts");
  return [facade, ...sourceFilesSync(typesRoot)]
    .map((path) => `\n/* ${relative(sharedSourceRoot, path)} */\n${readFileSync(path, "utf8")}`)
    .join("\n");
}
