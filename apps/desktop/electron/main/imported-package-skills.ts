import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { ErrorCodes } from "@pi-desktop/shared";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

/** Validate before reading a declared contribution; do not follow child links. */
export function assertImportedPackagePath(root: string, target: string): void {
  const rel = relative(root, target);
  const parts = rel.split(sep).filter(Boolean);
  if (isAbsolute(rel) || parts.includes("..") || parts.includes("node_modules")) {
    invalid("imported contribution must stay inside the selected package, outside node_modules");
  }
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      invalid("imported contributions cannot contain a symbolic link");
    }
  }
}

/** Map explicit pi.skills files/directories to existing plugin contributions. */
export function discoverImportedPackageSkills(root: string): { skills: string[]; skillsOnly: boolean } {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return { skills: [], skillsOnly: false };
  assertImportedPackagePath(root, packagePath);
  let metadata: { pi?: { skills?: unknown; extensions?: unknown } };
  try {
    metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    // Keep the existing loose-extension fallback for malformed package metadata.
    if (error instanceof SyntaxError) return { skills: [], skillsOnly: false };
    throw error;
  }
  const declared = metadata?.pi?.skills;
  if (declared === undefined) return { skills: [], skillsOnly: false };
  if (!Array.isArray(declared) || declared.length > 32) {
    invalid("pi.skills must be an array of at most 32 relative files or directories");
  }
  const extensions = metadata.pi?.extensions;
  if (extensions !== undefined && !Array.isArray(extensions)) {
    invalid("pi.extensions must be an array when importing a skill package");
  }
  const skills = new Set<string>();
  const visited = new Set<string>();
  const add = (path: string) => {
    skills.add(relative(root, path).split(sep).join("/"));
    if (skills.size > 32) invalid("a package can import at most 32 skills");
  };
  const scan = (dir: string, rootFiles: boolean) => {
    const scanKey = `${rootFiles}:${dir}`;
    if (visited.has(scanKey)) return;
    visited.add(scanKey);
    if (visited.size > 256) invalid("pi.skills directory scan exceeds 256 directories");
    const ownSkill = join(dir, "SKILL.md");
    if (existsSync(ownSkill)) {
      assertImportedPackagePath(root, ownSkill);
      if (lstatSync(ownSkill).isFile()) {
        add(ownSkill);
        return;
      }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      assertImportedPackagePath(root, path);
      if (entry.isDirectory()) scan(path, false);
      else if (entry.isFile() && rootFiles && entry.name.endsWith(".md")) add(path);
    }
  };
  for (const entry of declared) {
    if (typeof entry !== "string" || !entry.trim()) invalid("pi.skills entries must be nonempty paths");
    if (isAbsolute(entry) || win32.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      invalid("pi.skills paths must be relative to the selected package");
    }
    const path = resolve(root, entry.replaceAll("\\", "/"));
    // Diagnose unavailable or unsupported declarations rather than silently
    // importing a package which teaches the agent none of its declared skills.
    if (!existsSync(path)) invalid(`pi.skills path does not exist: ${entry}`);
    assertImportedPackagePath(root, path);
    const info = lstatSync(path);
    if (info.isDirectory()) scan(path, true);
    else if (info.isFile() && path.endsWith(".md")) add(path);
    else invalid(`pi.skills path must be a Markdown file or directory: ${entry}`);
  }
  return { skills: [...skills].sort(), skillsOnly: extensions === undefined || extensions.length === 0 };
}
