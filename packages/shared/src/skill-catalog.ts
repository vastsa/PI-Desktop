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
import { isSafeUserEndpointUrl } from "./public-network.js";

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

/** Mirrors host-core `MAX_SKILL_BYTES` in `user_skills.rs`. */
export const MAX_SKILL_DOCUMENT_BYTES = 128 * 1024;

/** Host `valid_capability_id`: lowercase ASCII, digits, hyphen; starts alphanumeric. */
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Guard for a skill market source URL the user entered.
 *
 * The user typed this address, so it may be a LAN or loopback catalog under the
 * stored `networkPolicy`; plain `http` needs the explicit opt-in. A document URL
 * that arrives inside a catalog stays on the third-party policy, so loosening
 * this guard never widens the boundary for content the app did not receive from
 * the user.
 */
export function isSafeSkillSourceUrl(
  url: string,
  options: { allowInsecureHttp?: boolean } = {},
): boolean {
  return isSafeUserEndpointUrl(url, options);
}

/**
 * Align a scanned or catalog id with host-core `valid_capability_id`.
 * Underscores become hyphens; an empty or illegal remainder falls back.
 */
export function sanitizeSkillCatalogId(raw: string, fallback: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (SKILL_ID.test(slug)) return slug;
  if (slug) {
    const prefixed = `skill-${slug}`.replace(/-+$/g, "").slice(0, 64);
    if (SKILL_ID.test(prefixed)) return prefixed;
  }
  const safeFallback = fallback
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return SKILL_ID.test(safeFallback) ? safeFallback : "skill";
}

export function skillEntryError(entry: SkillCatalogEntry): string | null {
  if (!SKILL_ID.test(entry.id)) return `bad id: ${entry.id}`;
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
    const raw = candidate as SkillCatalogEntry;
    if (!raw || typeof raw !== "object") {
      warnings.push(`entry ${index} is not an object`);
      continue;
    }
    const entry: SkillCatalogEntry = {
      ...raw,
      id: typeof raw.id === "string" ? sanitizeSkillCatalogId(raw.id, `skill-${index}`) : "",
    };
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
export function sanitizeSkillSources(
  value: unknown,
  options: { allowInsecureHttp?: boolean } = {},
): SkillMarketSource[] {
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
      !isSafeSkillSourceUrl(candidate.url, options) ||
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

export type SkillResource = { path: string; body: string };

/**
 * Inline adjacent skill files into the document body as fenced appendices.
 * The user-skill model is a single markdown file, so a multi-file skill
 * directory is expanded instead of stored beside an unreachable reference.
 */
export function expandSkillResources(doc: { body: string }, resources: SkillResource[]): string {
  if (!resources.length) return doc.body;
  return (
    doc.body.replace(/\s*$/, "") +
    resources
      .map(
        (resource) =>
          `\n\n---\n\n# Attached resource: ${resource.path}\n\n\`\`\`\n${resource.body.replace(/\s*$/, "")}\n\`\`\``,
      )
      .join("") +
    "\n"
  );
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Byte length of the document host-core would persist (frontmatter + body). */
export function renderedSkillDocumentBytes(
  name: string,
  description: string | undefined,
  body: string,
): number {
  let out = `---\nname: ${name.replace(/\n/g, " ")}\n`;
  if (description && description.trim()) {
    out += `description: ${description.replace(/\n/g, " ")}\n`;
  }
  out += `---\n\n${body.trim()}\n`;
  return utf8ByteLength(out);
}

export type AssembledSkillInstall = {
  name: string;
  description?: string;
  body: string;
  bytes: number;
  tooLarge: boolean;
};

/** Expand resources and measure the host document that install will write. */
export function assembleSkillInstall(
  document: { name?: string; description?: string; body: string; resources?: SkillResource[] },
  entry: { name: string; description?: string },
): AssembledSkillInstall {
  const name = document.name || entry.name;
  const description = document.description || entry.description;
  const body = expandSkillResources(document, document.resources ?? []);
  const bytes = renderedSkillDocumentBytes(name, description, body);
  return { name, description, body, bytes, tooLarge: bytes > MAX_SKILL_DOCUMENT_BYTES };
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
