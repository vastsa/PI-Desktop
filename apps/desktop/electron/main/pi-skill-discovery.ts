import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PiSkillDiscovery, PiSkillPackageCandidate } from "@pi-desktop/shared";
import { discoverImportedPackageSkills } from "./imported-package-skills";

const MAX_METADATA_BYTES = 256 * 1024;

async function readMetadata(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) {
    throw new Error("Package metadata must be a regular file smaller than 256 KiB");
  }
  return readFile(path, "utf8");
}

/** Read only the installed package level, never dependencies or executable modules. */
export async function discoverPiSkillPackages(modules: string, importedDescriptions: string[] = []): Promise<PiSkillDiscovery> {
  const candidates: PiSkillPackageCandidate[] = [];
  const errors: string[] = [];
  const importedSources = new Set(importedDescriptions);
  const paths: string[] = [];
  let entries: Dirent[];
  try {
    const info = await lstat(modules);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("pi npm directory must not be a symbolic link");
    modules = await realpath(modules);
    entries = await readdir(modules, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates, errors };
    throw error;
  }
  // npm hoists ordinary dependencies beside installed pi packages. Their count
  // must not hide valid skills; metadata reads below yield between packages.
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const path = join(modules, entry.name);
    if (!entry.name.startsWith("@")) {
      paths.push(path);
      continue;
    }
    try {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isDirectory() && !child.isSymbolicLink()) paths.push(join(path, child.name));
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of paths.sort()) {
    try {
      const raw = await readMetadata(join(path, "package.json"));
      const metadata: unknown = JSON.parse(raw);
      if (!metadata || typeof metadata !== "object" || !("name" in metadata) || typeof metadata.name !== "string") continue;
      const { skills, skillsOnly } = discoverImportedPackageSkills(path);
      if (!skills.length) continue;
      candidates.push({
        id: createHash("sha256").update(path).update(raw).update(JSON.stringify(skills)).digest("hex"),
        name: metadata.name,
        path,
        skills,
        hasExtensions: !skillsOnly,
        imported: importedSources.has(`Imported pi extension from ${path}`),
      });
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { candidates, errors };
}
