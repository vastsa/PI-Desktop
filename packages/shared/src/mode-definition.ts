/**
 * Mode definitions: user-authored operating modes (ADR mode-definitions).
 *
 * A mode is a Markdown document whose frontmatter declares the workflow and
 * whose body is the shared system prompt. YAML is read where the document is
 * loaded (agent-runtime); `mode-definition-parse.ts` validates the parsed
 * value. This module owns the normalized snapshot shape that the Host
 * persists, so the sidecar, Electron main, renderer and host-core agree on it.
 */

/** Tool policy level. `contract` is the Plan hard deny; `agent` is Agent. */
export type ModePermission = "agent" | "contract";
export const MODE_PERMISSIONS: readonly ModePermission[] = ["agent", "contract"];

export type ModeSource = "builtin" | "user";

/** Snapshot schema version, persisted with every run. */
export const MODE_DEFINITION_VERSION = 1;

export const MODE_LIMITS = {
  fileBytes: 64 * 1024,
  stages: 16,
  gatesPerStage: 8,
  injectsPerEvent: 8,
  artifacts: 16,
  requiredHeadings: 32,
  retries: 10,
  defaultRetries: 2,
  runTimeoutMinutes: 60,
  defaultRunTimeoutMinutes: 10,
  commandOutputBytes: 8 * 1024,
  labelChars: 40,
  descriptionChars: 200,
  promptBytes: 16 * 1024,
  headingChars: 200,
  commandChars: 2_000,
  maxTurns: 10_000,
  defaultMaxTurns: 20,
  minTokens: 1_000,
} as const;

export type ModeArtifact = {
  id: string;
  /** Workspace-relative POSIX path; may contain `{{run.id}}`. */
  path: string;
  /** Template content resolved at load time, copied on first stage enter. */
  template?: string;
  requiredHeadings: string[];
};

export type ModeInject =
  | { kind: "artifact"; artifact: string }
  | { kind: "text"; text: string };

export type ModeGateFailure = { retries: number; goto?: string };

export type ModeGate =
  | { kind: "require"; artifact: string; onFail: ModeGateFailure }
  | { kind: "run"; command: string; timeoutMinutes: number; onFail: ModeGateFailure }
  | { kind: "ask" };

export type ModeStage = {
  id: string;
  prompt: string;
  permission: ModePermission;
  loop: boolean;
  onEnter: ModeInject[];
  onCompaction: ModeInject[];
  exit: ModeGate[];
  /** Next stage; absent on the final stage. */
  next?: string;
};

export type ModeBudget = { maxTurns: number | null; maxTokens: number | null };

/** Normalized, self-contained definition. This is the persisted snapshot. */
export type ModeDefinition = {
  version: typeof MODE_DEFINITION_VERSION;
  id: string;
  label: string;
  description: string;
  permission: ModePermission;
  /** Markdown body: the shared system prompt. */
  prompt: string;
  source: ModeSource;
  artifacts: ModeArtifact[];
  budget: ModeBudget;
  /** Mode the session switches to after a run ends. */
  returnTo: string;
  /** Empty for a simple mode. */
  stages: ModeStage[];
};

/** Where a definition was read from; not part of the snapshot. */
export type ModeDefinitionEntry = { definition: ModeDefinition; filePath?: string };

export type ModeDiagnostic = { modeId: string; filePath?: string; errors: string[]; warnings: string[] };

export type ModeParseResult =
  | { ok: true; definition: ModeDefinition; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export type ModeParseOptions = {
  source: ModeSource;
  /** Directory name; used when frontmatter omits `name`. */
  fallbackName?: string;
  /** Template files keyed by their mode-relative path (`templates/x.md`). */
  templates?: Readonly<Record<string, string>>;
};

export const MODE_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const MODE_VARIABLE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Builtin mode ids. `agent` is also the fallback for a missing mode. */
export const BUILTIN_MODE_IDS = ["agent", "plan", "goal"] as const;
export const DEFAULT_MODE_ID = "agent";

export function isModeId(value: unknown): value is string {
  return typeof value === "string" && MODE_ID_RE.test(value);
}

export function isStagedMode(definition: Pick<ModeDefinition, "stages">): boolean {
  return definition.stages.length > 0;
}

export function modeStage(definition: ModeDefinition, stageId: string | undefined): ModeStage | undefined {
  return stageId === undefined ? undefined : definition.stages.find((stage) => stage.id === stageId);
}

/** Effective tool policy level for a stage, or the mode itself. */
export function modePermissionFor(definition: ModeDefinition, stageId?: string): ModePermission {
  return modeStage(definition, stageId)?.permission ?? definition.permission;
}

export type ModeVariables = {
  runId?: string;
  runInput?: string;
  artifactPaths?: Readonly<Record<string, string>>;
};

/** Text-only substitution; unknown variables were rejected at parse time. */
export function substituteModeVariables(text: string, vars: ModeVariables): string {
  return text.replace(MODE_VARIABLE_RE, (match, name: string) => {
    if (name === "run.id") return vars.runId ?? match;
    if (name === "run.input") return vars.runInput ?? match;
    const artifact = /^artifacts\.([a-z][a-z0-9-]*)\.path$/.exec(name);
    if (artifact) return vars.artifactPaths?.[artifact[1]] ?? match;
    return match;
  });
}

/** Resolve every artifact path for one run. */
export function modeArtifactPaths(definition: ModeDefinition, runId: string): Record<string, string> {
  return Object.fromEntries(definition.artifacts.map((artifact) => [
    artifact.id,
    substituteModeVariables(artifact.path, { runId }),
  ]));
}

/** Return the headings a Markdown document is missing, in declaration order.
 * Headings match case-insensitively at any level, ignoring trailing `#`. */
export function missingModeHeadings(markdown: string, required: readonly string[]): string[] {
  const present = new Set<string>();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) present.add(heading[1].trim().toLowerCase());
  }
  return required.filter((heading) => !present.has(heading.trim().toLowerCase()));
}
