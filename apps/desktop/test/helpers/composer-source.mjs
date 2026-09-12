import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const desktopSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const composerRoot = join(desktopSourceRoot, "features/chat/composer");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.(ts|tsx)$/.test(path) ? [path] : [];
      }),
  );
  return nested.flat();
}

/** Read the Composer facade plus the extracted editor, hooks, and UI modules. */
export async function readComposerSource() {
  const facade = join(desktopSourceRoot, "components/Composer.tsx");
  const autocompleteHook = join(desktopSourceRoot, "hooks/use-composer-autocomplete.ts");
  const paths = [facade, autocompleteHook, ...(await sourceFiles(composerRoot))];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      return `\n/* ${relative(desktopSourceRoot, path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}
