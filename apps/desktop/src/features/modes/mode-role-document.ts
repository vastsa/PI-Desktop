/**
 * Read and write one mode-private role document (issue #2544 §2).
 *
 * A private role is an ordinary subagent document inside the mode directory:
 * frontmatter plus a Markdown body. The Subagents tab edits it in place, and it
 * reuses the tool, model and thinking primitives the global subagent editor
 * already uses — so a mode role and a global role have one meaning for `tools`,
 * `model`, `fallbackModels`, `thinkingLevel` and the body; those belong to the
 * role, not the mode.
 *
 * Two rules keep this safe to run on a user's file:
 *
 * - unrecognized frontmatter keys survive. A document may carry a field a later
 *   version adds, or one this page does not model; rewriting it from the fields
 *   alone would silently drop it, so those lines are carried through verbatim;
 * - keys this page does own are rewritten in one canonical place, so a value
 *   read back is the value that was set.
 */
import {
  DEFAULT_SUBAGENT_TOOLS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_INHERIT_TOKEN,
  SUBAGENT_THINKING_LEVELS,
  isSubagentAssignableTool,
  type SubagentThinkingLevel,
} from "@pi-desktop/shared";

/** Fields of one role document the tab edits. */
export type RoleDocument = {
  /** Delegate handle; the `Task` argument. */
  name: string;
  description: string;
  /** Assignable tools declared explicitly; empty with `inheritTools` means inherit-only. */
  tools: string[];
  /** `tools: inherit` — union the parent session's live catalog. */
  inheritTools: boolean;
  /** `provider/model`, or the empty string to inherit the session model. */
  model: string;
  /** Ordered alternatives, each with its own thinking level. */
  fallbacks: { model: string; thinkingLevel: SubagentThinkingLevel | "" }[];
  /** Empty means "whatever the session uses". */
  thinkingLevel: SubagentThinkingLevel | "";
  /** Empty body means the document instructs nothing and will not load. */
  body: string;
  /**
   * Frontmatter lines this tab does not model, kept in their original order so
   * a save never drops them.
   */
  passthrough: string[];
};

/** Keys the tab writes; every other top-level frontmatter key is carried through. */
const OWNED_KEYS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "provider",
  "fallbackmodels",
  "fallbackthinkinglevels",
  "thinkinglevel",
]);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_\s]/g, "");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed[0] === '"' || trimmed[0] === "'") &&
    trimmed[0] === trimmed[trimmed.length - 1]
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitDocument(raw: string): { frontmatter: string[]; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: [], body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: [], body: text.trim() };
  return {
    frontmatter: text.slice(4, end).split("\n"),
    body: text.slice(end + 4).replace(/^[ \t]*\n/, "").trim(),
  };
}

/** Scalar value of one frontmatter key, unquoted. */
function scalar(frontmatter: string[], key: string): string | undefined {
  const wanted = normalizeKey(key);
  for (const line of frontmatter) {
    const pair = /^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/.exec(line);
    if (!pair || normalizeKey(pair[1]) !== wanted) continue;
    const value = unquote(pair[2]);
    return value || undefined;
  }
  return undefined;
}

/** List value of one frontmatter key, inline or block form. */
function list(frontmatter: string[], key: string): string[] {
  const wanted = normalizeKey(key);
  let collecting = false;
  const values: string[] = [];
  for (const line of frontmatter) {
    const pair = /^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/.exec(line);
    if (pair) {
      collecting = normalizeKey(pair[1]) === wanted;
      if (!collecting) continue;
      const inline = unquote(pair[2]);
      if (!inline) continue;
      return inline
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((entry) => unquote(entry))
        .filter(Boolean);
    }
    if (!collecting) continue;
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (item) values.push(unquote(item[1]));
  }
  return values;
}

function thinkingLevelOf(value: string | undefined): SubagentThinkingLevel | "" {
  if (!value) return "";
  const candidate = value.trim().toLowerCase();
  return (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(candidate)
    ? (candidate as SubagentThinkingLevel)
    : "";
}

/**
 * One role document as editable fields.
 *
 * A document that declares no `tools` at all reads back as the default tool
 * set, which is what the parser gives it — so the page shows the tools the
 * delegate actually has rather than an empty list that would mean "none".
 */
export function parseRoleDocument(raw: string): RoleDocument {
  const { frontmatter, body } = splitDocument(raw);
  const declared = list(frontmatter, "tools");
  const inheritTools = declared.includes(SUBAGENT_INHERIT_TOKEN);
  const tools = declared.length === 1 && declared[0] === "*"
    ? [...SUBAGENT_ASSIGNABLE_TOOLS]
    : declared.filter((tool) => isSubagentAssignableTool(tool));
  const declaredModel = scalar(frontmatter, "model");
  const provider = scalar(frontmatter, "provider");
  const model = declaredModel && provider ? `${provider}/${declaredModel}` : declaredModel ?? "";
  const fallbackModels = list(frontmatter, "fallbackModels");
  const fallbackLevels = list(frontmatter, "fallbackThinkingLevels");
  const fallbacks = fallbackModels.map((pin, index) => ({
    model: pin,
    // `inherit` is the role's own default; anything else is that pin's own level.
    thinkingLevel: thinkingLevelOf(fallbackLevels[index] === "inherit" ? undefined : fallbackLevels[index]),
  }));
  let owned = false;
  const passthrough = frontmatter.filter((line) => {
    const pair = /^([A-Za-z][A-Za-z0-9_\- ]*):/.exec(line);
    if (pair) owned = OWNED_KEYS.has(normalizeKey(pair[1]));
    return !owned || (!pair && /^\s*#/.test(line));
  });
  return {
    name: scalar(frontmatter, "name") ?? "",
    description: scalar(frontmatter, "description") ?? "",
    tools: declared.length === 0 ? [...DEFAULT_SUBAGENT_TOOLS] : tools,
    inheritTools,
    model,
    fallbacks,
    thinkingLevel: thinkingLevelOf(scalar(frontmatter, "thinkingLevel")),
    body,
    passthrough,
  };
}

/** A quote-safe scalar: bare when it reads back unchanged, double-quoted otherwise. */
function scalarText(value: string): string {
  const bare = /^[A-Za-z0-9_./][A-Za-z0-9 _./-]*$/.test(value) && !/:\s|\s#/.test(value) && !/\s$/.test(value);
  return bare ? value : JSON.stringify(value);
}

/**
 * The document text for a set of fields.
 *
 * The order is the one the global subagent editor writes, so a role created
 * here and a role created in Settings → Subagents read the same way. A field
 * left empty is omitted rather than written as `key: `, because an empty
 * scalar is what the parser treats as a block list.
 */
export function serializeRoleDocument(role: RoleDocument): string {
  const lines: string[] = [];
  if (role.name.trim()) lines.push(`name: ${role.name.trim()}`);
  if (role.description.trim()) lines.push(`description: ${scalarText(role.description.trim())}`);
  const tools = role.inheritTools
    ? [SUBAGENT_INHERIT_TOKEN, ...role.tools]
    : role.tools.filter((tool) => isSubagentAssignableTool(tool));
  if (tools.length) lines.push(`tools: [${tools.join(", ")}]`);
  if (role.model.trim()) lines.push(`model: ${role.model.trim()}`);
  if (role.fallbacks.length) {
    lines.push(`fallbackModels: [${role.fallbacks.map((entry) => entry.model.trim()).join(", ")}]`);
    // One level per fallback, in order; `inherit` is the role's own default.
    lines.push(
      `fallbackThinkingLevels: [${role.fallbacks.map((entry) => entry.thinkingLevel || "inherit").join(", ")}]`,
    );
  }
  if (role.thinkingLevel) lines.push(`thinkingLevel: ${role.thinkingLevel}`);
  // Lines this page does not model go after the owned ones so an unknown key
  // keeps its text even though its position may shift.
  lines.push(...role.passthrough);
  const body = role.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/** Tool selection written back in canonical order, however the boxes were clicked. */
export function toggleRoleTool(tools: readonly string[], tool: string, on: boolean): string[] {
  return on
    ? SUBAGENT_ASSIGNABLE_TOOLS.filter((candidate) => candidate === tool || tools.includes(candidate))
    : tools.filter((candidate) => candidate !== tool);
}

/** A handle written into a new document's `name:` from the reference it will live at. */
export function roleHandle(reference: string, fallback: string): string {
  const segment = reference.split("/").pop() ?? reference;
  const [stem] = segment.split(".");
  return (stem || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
