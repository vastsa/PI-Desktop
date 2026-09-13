/**
 * Shared vocabulary for the skill market surface.
 *
 * A skill entry points at one markdown document (SKILL.md-style: optional
 * frontmatter over an instruction body). Installing resolves the document and
 * feeds it through the existing `skills.create` write path — the host renders
 * its own frontmatter, so the market only ever needs to split, never to
 * reformat. Nothing here performs I/O; catalog JSON sources and the built-in
 * picks share these rules.
 */
import type { UserSkillInput } from "./types.js";

export type SkillCatalogCategory = "workflow" | "writing" | "coding" | "data" | "docs";

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** Absolute https URL of the raw markdown document. */
  url: string;
  categories?: SkillCatalogCategory[];
  verified?: boolean;
  version?: string;
  notes?: string;
};

export type SkillCatalogFile = {
  schemaVersion: 1;
  updatedAt: string;
  source: "builtin";
  skills: SkillCatalogEntry[];
};

export function skillEntryError(entry: SkillCatalogEntry): string | null {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id)) return `bad id: ${entry.id}`;
  if (!entry.url) return `${entry.id}: url is required`;
  try {
    const parsed = new URL(entry.url);
    if (parsed.protocol !== "https:") return `${entry.id}: catalog documents must be https`;
  } catch {
    return `${entry.id}: url does not parse`;
  }
  return null;
}

/** Lenient parse: bad entries become warnings instead of a failed load. */
export function validateSkillCatalogFile(value: unknown): {
  catalog: SkillCatalogFile;
  warnings: string[];
} {
  const warnings: string[] = [];
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawSkills = Array.isArray(root.skills) ? root.skills : [];
  if (!Array.isArray(root.skills)) warnings.push("catalog has no skills array");
  const skills: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of rawSkills.entries()) {
    const entry = candidate as SkillCatalogEntry;
    if (!entry || typeof entry !== "object") {
      warnings.push(`entry ${index} is not an object`);
      continue;
    }
    if (seen.has(entry.id)) {
      warnings.push(`duplicate id: ${entry.id}`);
      continue;
    }
    const error = skillEntryError(entry);
    if (error) {
      warnings.push(error);
      continue;
    }
    seen.add(entry.id);
    skills.push(entry);
  }
  return {
    catalog: {
      schemaVersion: 1,
      updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : "",
      source: "builtin",
      skills,
    },
    warnings,
  };
}

/**
 * Split a fetched document into frontmatter metadata and the instruction body.
 *
 * `skills.create` renders its own frontmatter from name/description, so the
 * body this returns must NOT include the original block — passing it through
 * would produce double frontmatter.
 */
export function splitSkillDocument(text: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!match) return { body: text };
  let name: string | undefined;
  let description: string | undefined;
  for (const line of match[1].split("\n")) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (m[1] === "name" && value) name = value;
    if (m[1] === "description" && value) description = value;
  }
  return { name, description, body: text.slice(match[0].length) };
}

/** A user-configurable catalog source. */
export type SkillMarketSource = {
  id: string;
  name: string;
  url: string;
};

/**
 * Guard for user-entered source/document URLs: https only, and never a
 * loopback or private-network host — the main process fetches whatever it is
 * told here, so the check runs on both sides of the IPC boundary.
 */
export function isSafeSkillSourceUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  const privateV4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (privateV4) {
    const [a, b] = [Number(privateV4[1]), Number(privateV4[2])];
    if (a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}

export type SourcedSkillEntry = SkillCatalogEntry & { sourceId: string };

/** Built-in picks first; catalog source entries fill the tail without id collisions. */
export function mergeSkillEntries(
  builtin: SkillCatalogEntry[],
  remote: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  const seen = new Set(builtin.map((entry) => entry.id));
  const merged = [...builtin];
  for (const entry of remote) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** Repair whatever the renderer persisted into a usable source list. */
export function sanitizeSkillSources(value: unknown): SkillMarketSource[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const sources: SkillMarketSource[] = [];
  for (const item of raw) {
    const candidate = item as SkillMarketSource;
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.url !== "string" ||
      !isSafeSkillSourceUrl(candidate.url) ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    seen.add(candidate.id);
    sources.push({
      id: candidate.id.slice(0, 64),
      name: candidate.name.slice(0, 64) || candidate.id,
      url: candidate.url,
    });
  }
  return sources;
}

/** Assemble the input for the existing `skills.create` write path. */
export function toSkillInput(
  entry: SkillCatalogEntry,
  document: { name?: string; description?: string; body: string },
): UserSkillInput {
  return {
    id: entry.id,
    name: document.name || entry.name,
    description: document.description || entry.description,
    body: document.body,
    enabled: true,
  };
}
