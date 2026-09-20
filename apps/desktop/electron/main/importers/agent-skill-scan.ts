/**
 * Scan third-party AI-tool skill directories for Skill definitions.
 *
 * Two on-disk shapes are recognized: a bare `<id>.md` file, and the
 * Claude-style `<name>/SKILL.md` directory. Both carry a YAML frontmatter
 * block with at least `name` and `description`. Anything unreadable or empty
 * is dropped, but the source row still reports it via `count` and `error`.
 */
import { promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SkillSourceKind = "claude-user" | "claude-project" | "pi-user" | "pi-project";

export interface SkillCandidate {
  source: SkillSourceKind;
  sourcePath: string;
  rootDir?: string;
  shape: "file" | "dir";
  id: string;
  name: string;
  description: string;
  bytes: number;
  warnings: string[];
}

export interface SkillSourceReport {
  kind: SkillSourceKind;
  path: string;
  exists: boolean;
  error?: string;
  count: number;
}

export interface SkillScanResult {
  candidates: SkillCandidate[];
  sources: SkillSourceReport[];
}

export interface SkillScanOptions {
  projectPath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_CANDIDATES_PER_SOURCE = 128;

function slugify(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.slice(0, 64) || "skill";
}

/**
 * Minimal frontmatter reader — enough for the `--- key: value ---` blocks
 * Claude and PI both emit. A real YAML parser would be strictly bigger risk
 * for the two fields we actually read.
 */
export function readFrontmatter(text: string): {
  data: Record<string, string>;
  body: string;
  ok: boolean;
} {
  const stripped = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(stripped);
  if (!match) return { data: {}, body: stripped, ok: false };
  const data: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    const hash = findUnquotedHash(value);
    if (hash !== -1) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }
  return { data, body: match[2] ?? "", ok: true };
}

function findUnquotedHash(value: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return i;
  }
  return -1;
}

async function statSafe(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<{ entries: string[]; error?: string; exists: boolean }> {
  try {
    const entries = await fs.readdir(dir);
    return { entries, exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { entries: [], exists: false };
    return { entries: [], exists: false, error: `${code ?? "ERR"}: ${(err as Error).message}` };
  }
}

async function readSkillFile(
  filePath: string,
): Promise<{ text: string | null; bytes: number; error?: string }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { text: null, bytes: 0 };
    if (stat.size > MAX_SKILL_BYTES) {
      return { text: null, bytes: stat.size, error: `skill exceeds ${MAX_SKILL_BYTES}B limit` };
    }
    const text = await fs.readFile(filePath, "utf8");
    return { text, bytes: stat.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: null, bytes: 0 };
    return { text: null, bytes: 0, error: `${code ?? "ERR"}: ${(err as Error).message}` };
  }
}

function extractCandidate(
  source: SkillSourceKind,
  sourcePath: string,
  rootDir: string | undefined,
  shape: "file" | "dir",
  fallbackId: string,
  text: string,
  bytes: number,
): SkillCandidate | null {
  const warnings: string[] = [];
  const parsed = readFrontmatter(text);
  if (!parsed.ok) warnings.push("missing frontmatter");
  if (!parsed.body.trim()) return null;
  const nameRaw = parsed.data.name?.trim() ?? "";
  const description = parsed.data.description?.trim() ?? "";
  if (!nameRaw) warnings.push("frontmatter missing name");
  if (!description) warnings.push("frontmatter missing description");
  const name = nameRaw || fallbackId;
  if (source === "pi-user" || source === "pi-project") {
    warnings.push("already in current registry");
  }
  return {
    source,
    sourcePath,
    rootDir,
    shape,
    id: slugify(nameRaw || fallbackId),
    name,
    description,
    bytes,
    warnings,
  };
}

async function scanDirectory(
  source: SkillSourceKind,
  dir: string,
): Promise<{ report: SkillSourceReport; candidates: SkillCandidate[] }> {
  const report: SkillSourceReport = { kind: source, path: dir, exists: false, count: 0 };
  const listing = await listDir(dir);
  if (listing.error) {
    report.error = listing.error;
    return { report, candidates: [] };
  }
  if (!listing.exists) return { report, candidates: [] };
  report.exists = true;

  const candidates: SkillCandidate[] = [];
  const errors: string[] = [];
  for (const entry of listing.entries.sort()) {
    if (candidates.length >= MAX_CANDIDATES_PER_SOURCE) break;
    const abs = path.join(dir, entry);
    const stat = await statSafe(abs);
    if (!stat) continue;
    if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
      const fallbackId = entry.replace(/\.md$/i, "");
      const { text, bytes, error } = await readSkillFile(abs);
      if (error) {
        errors.push(`${entry}: ${error}`);
        continue;
      }
      if (text == null) continue;
      const cand = extractCandidate(source, abs, undefined, "file", fallbackId, text, bytes);
      if (cand) candidates.push(cand);
      continue;
    }
    if (stat.isDirectory()) {
      const skillPath = path.join(abs, "SKILL.md");
      const { text, bytes, error } = await readSkillFile(skillPath);
      if (error) {
        errors.push(`${entry}: ${error}`);
        continue;
      }
      if (text == null) continue;
      const cand = extractCandidate(source, skillPath, abs, "dir", entry, text, bytes);
      if (cand) candidates.push(cand);
    }
  }

  const deduped: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand.id)) continue;
    seen.add(cand.id);
    deduped.push(cand);
  }
  report.count = deduped.length;
  if (errors.length) report.error = errors.join("; ");
  return { report, candidates: deduped };
}

function claudeUserDir(home: string): string {
  return path.join(home, ".claude", "skills");
}

function piUserDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.PI_DESKTOP_AGENTS_DIR;
  if (override && override.trim()) return path.join(override, "skills");
  return path.join(home, ".agents", "skills");
}

export async function scanExternalSkills(opts: SkillScanOptions = {}): Promise<SkillScanResult> {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const parts: Array<{ report: SkillSourceReport; candidates: SkillCandidate[] }> = [];

  parts.push(await scanDirectory("claude-user", claudeUserDir(home)));
  if (opts.projectPath) {
    parts.push(await scanDirectory("claude-project", path.join(opts.projectPath, ".claude", "skills")));
  }
  parts.push(await scanDirectory("pi-user", piUserDir(home, env)));
  if (opts.projectPath) {
    parts.push(await scanDirectory("pi-project", path.join(opts.projectPath, ".agents", "skills")));
  }

  return {
    candidates: parts.flatMap((p) => p.candidates),
    sources: parts.map((p) => p.report),
  };
}
