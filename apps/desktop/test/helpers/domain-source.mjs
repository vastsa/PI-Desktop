import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const desktopSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

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

async function readDomainSource(facadeRelativePath, domainRelativePath) {
  const facade = join(desktopSourceRoot, facadeRelativePath);
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  const paths = [facade, ...(await sourceFiles(domainRoot))];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      return `\n/* ${relative(desktopSourceRoot, path)} */\n${source}`;
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
      return entry.isFile() && /\.(ts|tsx)$/.test(path) ? [path] : [];
    });
}

function readDomainSourceSync(facadeRelativePath, domainRelativePath) {
  const facade = join(desktopSourceRoot, facadeRelativePath);
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  return [facade, ...sourceFilesSync(domainRoot)]
    .map((path) => `\n/* ${relative(desktopSourceRoot, path)} */\n${readFileSync(path, "utf8")}`)
    .join("\n");
}

/** Read App.tsx and the shell/runtime modules as one renderer contract surface. */
export function readAppSource() {
  return readDomainSource("App.tsx", "features/app");
}

export function readAppSourceSync() {
  return readDomainSourceSync("App.tsx", "features/app");
}

/** Read the stable SettingsPage facade and all settings sections together. */
export function readSettingsSource() {
  return readDomainSource("pages/SettingsPage.tsx", "features/settings");
}

export function readSettingsSourceSync() {
  return readDomainSourceSync("pages/SettingsPage.tsx", "features/settings");
}

/** Read the stable PluginsPage facade and all plugin domain modules together. */
export function readPluginsSource() {
  return readDomainSource("pages/PluginsPage.tsx", "features/plugins");
}

export function readPluginsSourceSync() {
  return readDomainSourceSync("pages/PluginsPage.tsx", "features/plugins");
}
