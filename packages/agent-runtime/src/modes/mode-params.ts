/**
 * Trusted-boundary parsing of the mode parameters Electron main hands the
 * sidecar (ADR mode-definitions): the session `mode` id, the definition the
 * session runs (`modeDefinition`) and the per-prompt run context
 * (`modeTurn`). Malformed shapes are rejected, never coerced; the idea of a
 * strictly parsed per-turn context is ported from PR #2141 by new-Beginner.
 */
import {
  MODE_DEFINITION_VERSION,
  MODE_ID_RE,
  MODE_LIMITS,
  normalizeMode,
  type Mode,
  type ModeDefinition,
  type ModeTurnContext,
} from "@pi-desktop/shared";

/** Serialized snapshot ceiling, the same bound host-core enforces. */
export const MODE_DEFINITION_MAX_BYTES = 256 * 1024;

const TURN_KEYS = ["runId", "stageId", "origin", "enteredStage", "input", "artifactPaths"] as const;
const DEFINITION_KEYS = new Set([
  "version", "id", "label", "description", "permission", "prompt", "source", "artifacts", "budget", "returnTo", "stages",
]);
const ARTIFACT_KEYS = new Set(["id", "path", "template", "requiredHeadings"]);
const STAGE_KEYS = new Set(["id", "prompt", "permission", "loop", "onEnter", "onCompaction", "exit", "next"]);

type Rejection = { message: string; errorCode: string };

function reject({ message, errorCode }: Rejection): never {
  throw Object.assign(new Error(message), { rpcCode: -32602, errorCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModeIdString(value: unknown): value is string {
  return typeof value === "string" && MODE_ID_RE.test(value);
}

function isPermission(value: unknown): boolean {
  return value === "agent" || value === "contract";
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** `mode` launch parameter: absent means Agent, `chat` is legacy Plan. */
export function parseModeParam(value: unknown): Mode {
  if (value === undefined || value === null || value === "") return "agent";
  if (typeof value === "string" && (value === "chat" || MODE_ID_RE.test(value))) return normalizeMode(value);
  return reject({ message: "mode must be a mode id", errorCode: "MODE_INVALID" });
}

/** Why a definition snapshot is malformed, or undefined when it is sound. */
export function modeDefinitionProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, DEFINITION_KEYS)) return "expected a mode definition object";
  if (value.version !== MODE_DEFINITION_VERSION) return "unsupported version";
  if (!isModeIdString(value.id)) return "id is invalid";
  if (typeof value.label !== "string" || typeof value.description !== "string" || typeof value.prompt !== "string") {
    return "label, description and prompt must be strings";
  }
  if (!isPermission(value.permission)) return "permission must be agent or contract";
  if (value.source !== "builtin" && value.source !== "user") return "source must be builtin or user";
  if (!isModeIdString(value.returnTo) || value.returnTo === value.id) return "returnTo is invalid";
  const budget = value.budget;
  if (!isRecord(budget) || !onlyKeys(budget, new Set(["maxTurns", "maxTokens"]))
    || !(budget.maxTurns === null || isBoundedInteger(budget.maxTurns, 1, MODE_LIMITS.maxTurns))
    || !(budget.maxTokens === null || isBoundedInteger(budget.maxTokens, 1, Number.MAX_SAFE_INTEGER))) {
    return "budget is invalid";
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > MODE_LIMITS.artifacts) return "artifacts are invalid";
  const artifactIds = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || !onlyKeys(artifact, ARTIFACT_KEYS) || !isModeIdString(artifact.id)
      || artifactIds.has(artifact.id) || typeof artifact.path !== "string" || !artifact.path
      || (artifact.template !== undefined && typeof artifact.template !== "string")
      || !Array.isArray(artifact.requiredHeadings)
      || artifact.requiredHeadings.length > MODE_LIMITS.requiredHeadings
      || artifact.requiredHeadings.some((heading) => typeof heading !== "string")) {
      return "artifacts are invalid";
    }
    artifactIds.add(artifact.id);
  }
  if (!Array.isArray(value.stages) || value.stages.length > MODE_LIMITS.stages) return "stages are invalid";
  const stageIds = new Set<string>();
  for (const stage of value.stages) {
    if (!isRecord(stage) || !isModeIdString(stage.id) || stageIds.has(stage.id)) return "stages are invalid";
    stageIds.add(stage.id);
  }
  for (const stage of value.stages as Record<string, unknown>[]) {
    const problem = stageProblem(stage, stageIds, artifactIds);
    if (problem) return `stage ${String(stage.id)}: ${problem}`;
  }
  return undefined;
}

function injectsProblem(value: unknown, artifactIds: ReadonlySet<string>): boolean {
  return !Array.isArray(value) || value.length > MODE_LIMITS.injectsPerEvent || value.some((inject) =>
    !isRecord(inject) || !(
      (inject.kind === "artifact" && onlyKeys(inject, new Set(["kind", "artifact"]))
        && typeof inject.artifact === "string" && artifactIds.has(inject.artifact))
      || (inject.kind === "text" && onlyKeys(inject, new Set(["kind", "text"])) && typeof inject.text === "string")
    ));
}

function onFailProblem(value: unknown, stageIds: ReadonlySet<string>): boolean {
  return !isRecord(value) || !onlyKeys(value, new Set(["retries", "goto"]))
    || !isBoundedInteger(value.retries, 0, MODE_LIMITS.retries)
    || (value.goto !== undefined && !(typeof value.goto === "string" && stageIds.has(value.goto)));
}

function stageProblem(stage: Record<string, unknown>, stageIds: ReadonlySet<string>, artifactIds: ReadonlySet<string>): string | undefined {
  if (!onlyKeys(stage, STAGE_KEYS)) return "unknown key";
  if (typeof stage.prompt !== "string") return "prompt must be a string";
  if (!isPermission(stage.permission)) return "permission must be agent or contract";
  if (typeof stage.loop !== "boolean") return "loop must be a boolean";
  if (injectsProblem(stage.onEnter, artifactIds) || injectsProblem(stage.onCompaction, artifactIds)) return "injects are invalid";
  if (stage.next !== undefined && !(typeof stage.next === "string" && stageIds.has(stage.next))) return "next is invalid";
  if (!Array.isArray(stage.exit) || stage.exit.length > MODE_LIMITS.gatesPerStage) return "exit is invalid";
  for (const gate of stage.exit) {
    if (!isRecord(gate)) return "exit is invalid";
    if (gate.kind === "ask") {
      if (!onlyKeys(gate, new Set(["kind"]))) return "exit is invalid";
    } else if (gate.kind === "require") {
      if (!onlyKeys(gate, new Set(["kind", "artifact", "onFail"])) || typeof gate.artifact !== "string"
        || !artifactIds.has(gate.artifact) || onFailProblem(gate.onFail, stageIds)) return "exit is invalid";
    } else if (gate.kind === "run") {
      if (!onlyKeys(gate, new Set(["kind", "command", "timeoutMinutes", "onFail"]))
        || typeof gate.command !== "string" || !gate.command || gate.command.length > MODE_LIMITS.commandChars
        || !isBoundedInteger(gate.timeoutMinutes, 1, MODE_LIMITS.runTimeoutMinutes)
        || onFailProblem(gate.onFail, stageIds)) return "exit is invalid";
    } else {
      return "exit is invalid";
    }
  }
  return undefined;
}

/**
 * `modeDefinition` launch parameter. It must describe `modeId` itself; a
 * snapshot of another mode would grant that mode's permission.
 */
export function parseModeDefinitionParam(value: unknown, modeId: Mode): ModeDefinition | undefined {
  if (value === undefined || value === null) return undefined;
  const problem = modeDefinitionProblem(value);
  if (problem) return reject({ message: `invalid modeDefinition: ${problem}`, errorCode: "MODE_DEFINITION_INVALID" });
  if (Buffer.byteLength(JSON.stringify(value)) > MODE_DEFINITION_MAX_BYTES) {
    return reject({ message: "invalid modeDefinition: larger than 256 KiB", errorCode: "MODE_DEFINITION_INVALID" });
  }
  const definition = value as ModeDefinition;
  if (definition.id !== modeId) {
    return reject({ message: `invalid modeDefinition: it describes "${definition.id}", not "${modeId}"`, errorCode: "MODE_DEFINITION_INVALID" });
  }
  return definition;
}

export type ModeLaunchParams = { mode: Mode; modeDefinition?: ModeDefinition };

/** `mode` and `modeDefinition` of a launch (`agent.prompt`, `agent.compact`, ...). */
export function parseModeLaunchParams(params: { mode?: unknown; modeDefinition?: unknown }): ModeLaunchParams {
  const mode = parseModeParam(params.mode);
  const modeDefinition = parseModeDefinitionParam(params.modeDefinition, mode);
  return { mode, ...(modeDefinition ? { modeDefinition } : {}) };
}

/**
 * `modeTurn` of one `agent.prompt`. A run turn needs the staged definition it
 * runs: without it the stage, its permission and its gates are unknown.
 */
export function parseModePromptTurn(value: unknown, launch: ModeLaunchParams): ModeTurnContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (!launch.modeDefinition) {
    return reject({ message: "invalid modeTurn: it requires the modeDefinition of the run's mode", errorCode: "MODE_TURN_INVALID" });
  }
  return parseModeTurn(value, launch.modeDefinition);
}

/**
 * Per-prompt `modeTurn`: exact keys only. When `definition` is given the
 * stage must exist in it, so a turn can never claim a stage the session's
 * snapshot does not declare.
 */
export function parseModeTurn(value: unknown, definition?: ModeDefinition): ModeTurnContext | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid = (message: string): never => reject({ message: `invalid modeTurn: ${message}`, errorCode: "MODE_TURN_INVALID" });
  if (!isRecord(value) || Object.keys(value).length !== TURN_KEYS.length
    || !TURN_KEYS.every((key) => Object.hasOwn(value, key))) {
    return invalid(`expected exactly ${TURN_KEYS.join(", ")}`);
  }
  if (typeof value.runId !== "string" || !value.runId.trim() || value.runId.length > 200) return invalid("runId");
  if (!isModeIdString(value.stageId)) return invalid("stageId");
  if (value.origin !== "user" && value.origin !== "approval" && value.origin !== "host") return invalid("origin");
  if (typeof value.enteredStage !== "boolean") return invalid("enteredStage");
  if (typeof value.input !== "string") return invalid("input");
  const paths = value.artifactPaths;
  if (!isRecord(paths) || Object.keys(paths).length > MODE_LIMITS.artifacts
    || Object.entries(paths).some(([id, path]) => !MODE_ID_RE.test(id) || typeof path !== "string" || !path)) {
    return invalid("artifactPaths");
  }
  if (definition) {
    if (definition.stages.length === 0) return invalid(`mode "${definition.id}" has no stages`);
    if (!definition.stages.some((stage) => stage.id === value.stageId)) return invalid(`unknown stage "${value.stageId}"`);
  }
  return {
    runId: value.runId,
    stageId: value.stageId,
    origin: value.origin,
    enteredStage: value.enteredStage,
    input: value.input,
    artifactPaths: Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, String(path)])),
  };
}
