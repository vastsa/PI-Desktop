/**
 * Discovery of trusted extension entries (spec 07-plugins/16 §3).
 *
 * Mirrors the pi-coding-agent loader rules so an extensions directory means
 * the same thing in both products: direct `*.ts` / `*.js` files, one level of
 * subdirectories with `index.ts` / `index.js`, or a `package.json` whose
 * `pi.extensions` field lists entry files. No deeper recursion. Pure
 * filesystem reads; nothing is loaded or executed here.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { TrustedExtensionSource, TrustedExtensionSpec } from "./types.js";

const EXTENSION_FILE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".mts"]);

function isExtensionFile(name: string): boolean {
  return EXTENSION_FILE_EXTENSIONS.has(extname(name)) && !name.endsWith(".d.ts");
}

function readPiManifestExtensions(packageJsonPath: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      pi?: { extensions?: unknown };
    };
    const list = parsed?.pi?.extensions;
    if (!Array.isArray(list)) return undefined;
    return list.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return undefined;
  }
}

function packageLabel(dir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof parsed.name === "string" && parsed.name) return parsed.name;
  } catch {
    // Directory name is the fallback label.
  }
  return basename(dir);
}

/**
 * Entry files declared by one directory: `pi.extensions` from `package.json`,
 * else `index.ts` / `index.js`. Returns `undefined` when the directory
 * declares nothing.
 */
export function resolveExtensionEntries(dir: string): string[] | undefined {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const declared = readPiManifestExtensions(packageJsonPath) ?? [];
    const entries = declared.map((p) => resolve(dir, p)).filter((p) => existsSync(p));
    if (entries.length > 0) return entries;
  }
  for (const index of ["index.ts", "index.js"]) {
    const candidate = join(dir, index);
    if (existsSync(candidate)) return [candidate];
  }
  return undefined;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function specFor(
  entry: string,
  root: string,
  source: TrustedExtensionSource,
  label: string,
): TrustedExtensionSpec {
  return { id: safeRealpath(entry), entry: resolve(entry), label, source, root };
}

/** Scan one extensions root with the pi-coding-agent discovery rules. */
export function discoverExtensionsInDir(
  root: string,
  source: TrustedExtensionSource,
): TrustedExtensionSpec[] {
  if (!existsSync(root)) return [];
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: TrustedExtensionSpec[] = [];
  for (const dirent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(root, dirent.name);
    let isFile = dirent.isFile();
    let isDirectory = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        const target = statSync(entryPath);
        isFile = target.isFile();
        isDirectory = target.isDirectory();
      } catch {
        continue;
      }
    }
    if (isFile && isExtensionFile(dirent.name)) {
      found.push(specFor(entryPath, root, source, basename(dirent.name, extname(dirent.name))));
      continue;
    }
    if (isDirectory) {
      const entries = resolveExtensionEntries(entryPath);
      if (!entries) continue;
      const label = packageLabel(entryPath);
      for (const entry of entries) {
        found.push(
          specFor(
            entry,
            root,
            source,
            entries.length === 1 ? label : `${label}/${basename(entry, extname(entry))}`,
          ),
        );
      }
    }
  }
  return found;
}

/**
 * Resolve a manually chosen path: a directory declaring entries, a directory
 * of loose extensions, or a single file.
 */
export function discoverManualPath(target: string): TrustedExtensionSpec[] {
  const resolved = resolve(target);
  if (!existsSync(resolved)) return [];
  let stats: import("node:fs").Stats;
  try {
    stats = statSync(resolved);
  } catch {
    return [];
  }
  if (stats.isDirectory()) {
    const declared = resolveExtensionEntries(resolved);
    if (declared) {
      const label = packageLabel(resolved);
      return declared.map((entry) =>
        specFor(
          entry,
          resolved,
          "manual",
          declared.length === 1 ? label : `${label}/${basename(entry, extname(entry))}`,
        ),
      );
    }
    return discoverExtensionsInDir(resolved, "manual");
  }
  if (stats.isFile() && isExtensionFile(basename(resolved))) {
    return [
      specFor(resolved, resolve(resolved, ".."), "manual", basename(resolved, extname(resolved))),
    ];
  }
  return [];
}

export type DiscoverTrustedExtensionsInput = {
  /** `~/.pi/agent` or a test override. */
  agentDir: string;
  /** Workspace root; project extensions live under `<workspace>/.pi/extensions`. */
  projectPath?: string;
  /** Paths the user added by hand. */
  manualPaths?: string[];
};

/** All candidates in spec §3.1 order: user, project, manual. Deduplicated by id. */
export function discoverTrustedExtensions(
  input: DiscoverTrustedExtensionsInput,
): TrustedExtensionSpec[] {
  const seen = new Set<string>();
  const out: TrustedExtensionSpec[] = [];
  const add = (specs: TrustedExtensionSpec[]) => {
    for (const spec of specs) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      out.push(spec);
    }
  };
  add(discoverExtensionsInDir(join(input.agentDir, "extensions"), "user"));
  if (input.projectPath) {
    add(discoverExtensionsInDir(join(input.projectPath, ".pi", "extensions"), "project"));
  }
  for (const manual of input.manualPaths ?? []) add(discoverManualPath(manual));
  return out;
}
