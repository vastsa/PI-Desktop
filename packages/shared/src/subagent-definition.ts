/**
 * Subagent definitions: the Markdown documents that describe a delegate the
 * main agent can spawn through the `Task` tool.
 *
 * The format deliberately mirrors `.pi/prompts/*.md` (D123): YAML-ish
 * frontmatter followed by a Markdown body that becomes the delegate's system
 * prompt. Discovery and provider resolution live in `agent-runtime`
 * (`subagent-definitions.ts`); this module owns only the shape, the parser and
 * the safety defaults so the renderer, main and the sidecar agree on what a
 * definition means.
 *
 * Two defaults matter for safety:
 * - a delegate that does not declare `tools` is read-only, and
 * - a delegate never inherits mutation rights from the parent session.
 */

import type { A2AAgentCard } from "./a2a.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

/**
 * Where a definition came from. User-owned global documents shadow builtins by
 * name; project workspaces do not provide subagent definitions (D202).
 */
export type SubagentSource = "builtin" | "user";

/** Provider/model pin declared by a definition (resolved in Electron main). */
export type SubagentModelPin = {
  providerId: string;
  modelId: string;
};

export type SubagentDefinition = {
  /** Delegate id used as the `Task` argument, e.g. "code-reviewer". */
  name: string;
  /** One line telling the parent model when to delegate to this agent. */
  description: string;
  /** Tools the delegate may call; read-only by default. */
  tools: string[];
  /** Provider/model this definition pins, when it pins one. */
  model?: SubagentModelPin;
  /** Reasoning level for the delegate, clamped against the model in main. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Permission scope for the delegate's tool calls (ADR 0089). `inherit`
   * follows the session's effective mode; the other values override it for the
   * delegate's calls only, with host-core's external-path gate still in force
   * (a delegate never unlocks paths outside the workspace and scratch roots).
   */
  permission?: SubagentPermission;
  /** Optional hard cap on delegate turns; omitted means unlimited turns. */
  maxTurns?: number;
  /** Idle watchdog in seconds; parser materializes the default for documents. */
  idleTimeoutSeconds?: number;
  /** Total runtime watchdog in seconds; parser materializes the default. */
  maxDurationSeconds?: number;
  /** Markdown body used as the delegate's system prompt. */
  prompt: string;
  source: SubagentSource;
  /** Absolute path of a user-owned global document. */
  filePath?: string;
};

/**
 * A2A capability tool a delegate may declare to talk to its concurrent
 * siblings over the host-core A2A broker (ADR 0146, superseding D277/ADR
 * 0138/0140). It is opt-in per definition: silence means a delegate keeps the
 * ADR 0062 isolation where the parent is the only integration point, so no
 * existing definition changes behaviour.
 *
 * A single `A2A` tool carries the operations a delegate needs — `discover`,
 * `send`, `get`, `wait` and `cancel` — selected by an `action` parameter, so
 * the capability is counted and declared as one tool. It is a host-local
 * coordination tool, not a delegation tool: it exchanges A2A messages/tasks
 * between running delegates on this host (including other sessions) and never
 * exposes delegation ids, the delegation registry, or the ability to start or
 * stop a delegate.
 */
export const SUBAGENT_A2A_TOOLS = ["A2A"] as const;

export type SubagentA2ATool = (typeof SUBAGENT_A2A_TOOLS)[number];

/** Tools a definition may declare. Plugin, skill, mode and meta tools stay out
 * of reach: a delegate is a bounded file/search/shell worker, not a second
 * full session. */
export const SUBAGENT_ASSIGNABLE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "BrowserPreview",
  "Bash",
  "Edit",
  "Write",
  ...SUBAGENT_A2A_TOOLS,
] as const;

export type SubagentAssignableTool = (typeof SUBAGENT_ASSIGNABLE_TOOLS)[number];

/** Tools that can change the workspace; declaring one makes a delegate
 * write-capable, which drives the write lock and permission attribution. */
export const SUBAGENT_MUTATING_TOOLS = ["Bash", "Edit", "Write"] as const;

/** What a definition gets when it stays silent about tools. */
export const DEFAULT_SUBAGENT_TOOLS: readonly SubagentAssignableTool[] = [
  "Read",
  "Glob",
  "Grep",
];

export const MAX_SUBAGENT_MAX_TURNS = 80;
/**
 * How long a delegate may be completely silent before it is considered hung.
 *
 * This bounds silence, not work: any agent event re-arms the timer, a single
 * streamed token included, and the timer is paused outright while a tool
 * executes. So a delegate that thinks for twenty minutes while streaming, or
 * runs a five-minute build, never trips it — only one that stops responding
 * does.
 *
 * The value is sized from observed provider latency: a delegate is silent from
 * its last streamed token until the next response begins, and this project's
 * measured pre-token wait reaches 174s at p99.9. 300 seconds clears that with
 * margin while staying well below the 600-second `TaskWait` default, so a
 * genuinely stuck delegate surfaces within one wait instead of holding the
 * parent for a full window and beyond.
 */
export const DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS = 300;
export const MIN_SUBAGENT_IDLE_TIMEOUT_SECONDS = 10;
export const MAX_SUBAGENT_IDLE_TIMEOUT_SECONDS = 21_600;
export const DEFAULT_SUBAGENT_MAX_DURATION_SECONDS = 21_600;
export const MIN_SUBAGENT_MAX_DURATION_SECONDS = 60;
export const MAX_SUBAGENT_MAX_DURATION_SECONDS = 21_600;

/**
 * Permission scope a delegate's tool calls resolve under, when its definition
 * overrides the session mode. Mirrors the session permission modes; `inherit`
 * is the default and means "use the session's effective mode as today".
 */
export const SUBAGENT_PERMISSIONS = [
  "inherit",
  "ask",
  "accept-edits",
  "auto",
] as const;
export type SubagentPermission = (typeof SUBAGENT_PERMISSIONS)[number];
export const DEFAULT_SUBAGENT_PERMISSION: SubagentPermission = "inherit";

export function isSubagentPermission(value: unknown): value is SubagentPermission {
  return (
    typeof value === "string" &&
    (SUBAGENT_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** Builtins and global user documents may declare a permission scope. */
export const PERMISSION_DECLARING_SOURCES: ReadonlySet<SubagentSource> = new Set(
  ["builtin", "user"] as const,
);

/** Caps that keep delegation cheap and predictable (see ADR 0062). */
export const MAX_SUBAGENT_DEFINITIONS = 16;
export const MAX_SUBAGENT_PROVIDERS = 8;
/** Running delegates per session, across batches (see ADR 0089). */
export const MAX_SUBAGENT_CONCURRENCY = 10;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isSubagentAssignableTool(
  value: unknown,
): value is SubagentAssignableTool {
  return (
    typeof value === "string" &&
    (SUBAGENT_ASSIGNABLE_TOOLS as readonly string[]).includes(value)
  );
}

export function isSubagentMutatingTool(value: string): boolean {
  return (SUBAGENT_MUTATING_TOOLS as readonly string[]).includes(value);
}

export function isSubagentA2ATool(value: string): value is SubagentA2ATool {
  return (SUBAGENT_A2A_TOOLS as readonly string[]).includes(value);
}

/** Whether this delegate opted into A2A messaging (ADR 0146). */
export function subagentUsesA2A(definition: SubagentDefinition): boolean {
  return definition.tools.some(isSubagentA2ATool);
}

/**
 * Derive the A2A Agent Card a delegate advertises through the broker's
 * discovery. `name` is filled in by the runtime at spawn time with the
 * delegate's unique peer id; the card here carries the definition-derived
 * identity and skill so a peer's `discover` returns something meaningful. The
 * card claims streaming and push because the host-core broker serves both.
 */
export function toAgentCard(definition: SubagentDefinition): A2AAgentCard {
  return {
    name: definition.name,
    description: definition.description,
    version: "1.0.0",
    skills: [
      {
        id: definition.name,
        name: definition.name,
        description: definition.description,
        tags: definition.tools.filter((tool) => !isSubagentA2ATool(tool)),
      },
    ],
    capabilities: { streaming: true, pushNotifications: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    kind: "subagent",
  };
}

/** Whether this delegate can change the workspace. */
export function subagentCanMutate(definition: SubagentDefinition): boolean {
  return definition.tools.some(isSubagentMutatingTool);
}

/** Filename (or frontmatter `name`) to definition id. */
export function normalizeSubagentName(value: string): string {
  const basename = value
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop()!
    .replace(/\.md$/i, "");
  return basename.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export type SubagentParseResult =
  | { ok: true; definition: SubagentDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

type Frontmatter = Map<string, string | string[]>;

/** Frontmatter keys are matched loosely so `max-turns`, `max_turns` and
 * `maxTurns` all land on the same field. */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_\s]/g, "");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read the leading `---` block. Only the flat subset used by definitions is
 * supported: `key: value` scalars and list values written inline
 * (`[a, b]` / `a, b`) or as following `- item` lines.
 */
function splitFrontmatter(
  raw: string,
): { frontmatter: Frontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frontmatter: Frontmatter = new Map();
  if (!normalized.startsWith("---\n")) {
    return { frontmatter, body: normalized.trim() };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter, body: normalized.trim() };
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^[ \t]*\n/, "");

  let lastKey: string | null = null;
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
    if (item && lastKey) {
      const existing = frontmatter.get(lastKey);
      const list = Array.isArray(existing) ? existing : [];
      const value = unquote(item[1]);
      if (value) list.push(value);
      frontmatter.set(lastKey, list);
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/);
    if (!pair) continue;
    lastKey = normalizeKey(pair[1]);
    const value = pair[2].trim();
    // An empty scalar opens a block list; the `- item` branch fills it in.
    frontmatter.set(lastKey, value ? unquote(value) : []);
  }
  return { frontmatter, body: body.trim() };
}

function asScalar(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Parse one definition document.
 *
 * `fallbackName` is the filename stem: a document may omit `name`, and the
 * file it lives in is a better identity than a parse failure. `description`
 * is required — without it the parent model cannot decide when to delegate.
 */
export function parseSubagentDefinition(
  raw: string,
  options: {
    source: SubagentSource;
    fallbackName?: string;
    filePath?: string;
  },
): SubagentParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { frontmatter, body } = splitFrontmatter(raw);

  const declaredName = asScalar(frontmatter.get("name"));
  const name = normalizeSubagentName(
    declaredName ?? options.fallbackName ?? "",
  );
  if (!name) errors.push("missing `name` and no filename to fall back on");
  else if (!NAME_RE.test(name)) {
    errors.push(
      `invalid name "${name}": use lowercase letters, digits and dashes (max 40 chars)`,
    );
  }

  const description = asScalar(frontmatter.get("description"))?.trim() ?? "";
  if (!description) errors.push("missing `description`");

  const declaredTools = asList(frontmatter.get("tools"));
  let tools: string[];
  if (declaredTools.length === 0) {
    tools = [...DEFAULT_SUBAGENT_TOOLS];
  } else if (declaredTools.length === 1 && declaredTools[0] === "*") {
    tools = [...SUBAGENT_ASSIGNABLE_TOOLS];
  } else {
    const accepted: string[] = [];
    for (const tool of declaredTools) {
      if (isSubagentAssignableTool(tool)) {
        if (!accepted.includes(tool)) accepted.push(tool);
      } else {
        warnings.push(`ignoring unknown tool "${tool}"`);
      }
    }
    if (accepted.length === 0) {
      errors.push("`tools` lists no usable tool");
      tools = [...DEFAULT_SUBAGENT_TOOLS];
    } else {
      tools = accepted;
    }
  }

  const model = parseModelPin(frontmatter, errors);

  const declaredThinking = asScalar(frontmatter.get("thinkinglevel"));
  let thinkingLevel: ThinkingLevel | undefined;
  if (declaredThinking) {
    const candidate = declaredThinking.trim().toLowerCase();
    if ((THINKING_LEVELS as readonly string[]).includes(candidate)) {
      thinkingLevel = candidate as ThinkingLevel;
    } else {
      warnings.push(`ignoring unknown thinking level "${declaredThinking}"`);
    }
  }

  const declaredPermission = asScalar(frontmatter.get("permission"))?.trim();
  let permission: SubagentPermission | undefined;
  if (declaredPermission) {
    const candidate = declaredPermission.toLowerCase();
    if (!isSubagentPermission(candidate)) {
      warnings.push(
        `ignoring unknown permission "${declaredPermission}" (use inherit, ask, accept-edits or auto)`,
      );
    } else if (
      candidate !== DEFAULT_SUBAGENT_PERMISSION &&
      PERMISSION_DECLARING_SOURCES.has(options.source)
    ) {
      permission = candidate;
    }
  }

  const maxTurns = parseMaxTurns(asScalar(frontmatter.get("maxturns")), warnings);
  const idleTimeoutSeconds = parseTimeoutSeconds(
    asScalar(frontmatter.get("idletimeout")) ??
      asScalar(frontmatter.get("idletimeoutseconds")),
    "idle-timeout",
    DEFAULT_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    MIN_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    MAX_SUBAGENT_IDLE_TIMEOUT_SECONDS,
    warnings,
  );
  const maxDurationSeconds = parseTimeoutSeconds(
    asScalar(frontmatter.get("maxduration")) ??
      asScalar(frontmatter.get("maxdurationseconds")),
    "max-duration",
    DEFAULT_SUBAGENT_MAX_DURATION_SECONDS,
    MIN_SUBAGENT_MAX_DURATION_SECONDS,
    MAX_SUBAGENT_MAX_DURATION_SECONDS,
    warnings,
  );

  const prompt = body.trim();
  if (!prompt) errors.push("document body is empty (nothing to instruct)");

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    definition: {
      name,
      description,
      tools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(permission ? { permission } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      idleTimeoutSeconds,
      maxDurationSeconds,
      prompt,
      source: options.source,
      ...(options.filePath ? { filePath: options.filePath } : {}),
    },
    warnings,
  };
}

/**
 * `model: <provider>/<model>` is the compact spelling; `provider:` plus
 * `model:` is the explicit one. A model id can itself contain slashes
 * (`openrouter` style), so only the first segment is the provider.
 */
function parseModelPin(
  frontmatter: Frontmatter,
  errors: string[],
): SubagentModelPin | undefined {
  const declaredProvider = asScalar(frontmatter.get("provider"))?.trim();
  const declaredModel = asScalar(frontmatter.get("model"))?.trim();
  if (!declaredProvider && !declaredModel) return undefined;
  if (!declaredModel) {
    errors.push("`provider` given without `model`");
    return undefined;
  }
  if (declaredProvider) {
    return { providerId: declaredProvider, modelId: declaredModel };
  }
  const slash = declaredModel.indexOf("/");
  if (slash <= 0 || slash === declaredModel.length - 1) {
    errors.push(
      `\`model\` must be "<provider>/<model>" or paired with \`provider\` (got "${declaredModel}")`,
    );
    return undefined;
  }
  return {
    providerId: declaredModel.slice(0, slash),
    modelId: declaredModel.slice(slash + 1),
  };
}

function parseMaxTurns(
  value: string | undefined,
  warnings: string[],
): number | undefined {
  if (!value || value.trim().toLowerCase() === "none") {
    return undefined;
  }
  const parsed = Number(value);
  if (parsed === 0) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    warnings.push(`ignoring invalid \`maxTurns\` "${value}" (unlimited)`);
    return undefined;
  }
  if (parsed > MAX_SUBAGENT_MAX_TURNS) {
    warnings.push(
      `clamping \`maxTurns\` ${parsed} to ${MAX_SUBAGENT_MAX_TURNS}`,
    );
    return MAX_SUBAGENT_MAX_TURNS;
  }
  return parsed;
}

function parseTimeoutSeconds(
  value: string | undefined,
  key: "idle-timeout" | "max-duration",
  fallback: number,
  minimum: number,
  maximum: number,
  warnings: string[],
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed)) {
    warnings.push(`ignoring invalid \`${key}\` "${value}" (using ${fallback})`);
    return fallback;
  }
  const clamped = Math.min(maximum, Math.max(minimum, parsed));
  if (clamped !== parsed) {
    warnings.push(`clamping \`${key}\` ${parsed} to ${clamped}`);
  }
  return clamped;
}

/**
 * Merge discovered definitions into the list the runtime offers.
 *
 * Precedence is user registry > builtin, so a global document retunes a
 * builtin without renaming it. The result is capped: past
 * `MAX_SUBAGENT_DEFINITIONS` the catalog stops being a menu the model can
 * reason about, and every extra entry costs prompt tokens on every turn.
 */
export function mergeSubagentDefinitions(
  definitions: readonly SubagentDefinition[],
): { definitions: SubagentDefinition[]; dropped: string[] } {
  const byName = new Map<string, SubagentDefinition>();
  // Highest-precedence source first, so the first entry for a name wins it.
  const ordered = [
    ...definitions.filter((d) => d.source === "user"),
    ...definitions.filter((d) => d.source === "builtin"),
  ];
  const dropped: string[] = [];
  for (const definition of ordered) {
    if (byName.has(definition.name)) continue;
    if (byName.size >= MAX_SUBAGENT_DEFINITIONS) {
      dropped.push(definition.name);
      continue;
    }
    byName.set(definition.name, definition);
  }
  return { definitions: [...byName.values()], dropped };
}

/**
 * Key of one resolved pin. Electron main resolves each distinct pin once and
 * hands the sidecar a map under these keys; the sidecar looks a delegate's
 * provider up by the same key, so an unresolvable pin is a missing entry rather
 * than a silent fallback to the session model.
 */
export function subagentModelKey(pin: SubagentModelPin): string {
  return `${pin.providerId}/${pin.modelId}`;
}

/** Distinct providers pinned across a definition list, capped for the same
 * reason as the definition count: each one is a live client in the sidecar. */
export function subagentPinnedProviders(
  definitions: readonly SubagentDefinition[],
): string[] {
  const providers: string[] = [];
  for (const definition of definitions) {
    const providerId = definition.model?.providerId;
    if (!providerId || providers.includes(providerId)) continue;
    if (providers.length >= MAX_SUBAGENT_PROVIDERS) break;
    providers.push(providerId);
  }
  return providers;
}
