/**
 * Strict validation for mode definition documents (ADR mode-definitions).
 * Unknown keys, events, actions or references reject the whole document.
 */
import {
  DEFAULT_MODE_ID,
  MODE_DEFINITION_VERSION,
  MODE_ID_RE,
  MODE_LIMITS,
  MODE_VARIABLE_RE,
  type ModeArtifact,
  type ModeBudget,
  type ModeGate,
  type ModeGateFailure,
  type ModeInject,
  type ModeParseOptions,
  type ModeParseResult,
  type ModePermission,
  type ModeStage,
} from "./mode-definition.js";

const ID_RE = MODE_ID_RE;
const ARTIFACT_REF_RE = /^artifact:([a-z][a-z0-9-]{0,39})$/;
const VARIABLE_RE = MODE_VARIABLE_RE;

const MODE_KEYS = new Set(["name", "label", "description", "permission", "artifacts", "budget", "returnTo", "stages"]);
const STAGED_ONLY_KEYS = ["artifacts", "budget", "returnTo"] as const;
const STAGE_KEYS = new Set(["prompt", "permission", "loop", "on", "exit", "next"]);
const ON_KEYS = new Set(["enter", "compaction"]);
const ARTIFACT_KEYS = new Set(["path", "template", "requiredHeadings"]);
const BUDGET_KEYS = new Set(["maxTurns", "maxTokens"]);
const GATE_ACTIONS = ["require", "run", "ask"] as const;
const ON_FAIL_KEYS = new Set(["retries", "goto"]);
const RUN_KEYS = new Set(["command", "timeoutMinutes"]);

type Ctx = { errors: string[]; warnings: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, at: string, ctx: Ctx): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) ctx.errors.push(`${at}${at ? "." : ""}${key}: unknown key`);
  }
}

function readString(value: unknown, at: string, ctx: Ctx, opts: { maxChars?: number; maxBytes?: number; required?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.required) ctx.errors.push(`${at}: required`);
    return undefined;
  }
  if (typeof value !== "string") {
    ctx.errors.push(`${at}: expected a string`);
    return undefined;
  }
  const text = value.trim();
  if (opts.required && !text) ctx.errors.push(`${at}: must not be empty`);
  if (opts.maxChars !== undefined && [...text].length > opts.maxChars) {
    ctx.errors.push(`${at}: longer than ${opts.maxChars} characters`);
  }
  if (opts.maxBytes !== undefined && new TextEncoder().encode(text).length > opts.maxBytes) {
    ctx.errors.push(`${at}: larger than ${opts.maxBytes} bytes`);
  }
  return text;
}

function readInteger(value: unknown, at: string, ctx: Ctx, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    ctx.errors.push(`${at}: expected an integer from ${min} to ${max}`);
    return undefined;
  }
  return value;
}

function readPermission(value: unknown, at: string, ctx: Ctx): ModePermission | undefined {
  if (value === undefined) return undefined;
  if (value === "agent" || value === "contract") return value;
  ctx.errors.push(`${at}: expected "agent" or "contract"`);
  return undefined;
}

type VariableScope = { input: boolean; artifacts: boolean };

function checkVariables(text: string, at: string, scope: VariableScope, artifactIds: ReadonlySet<string>, ctx: Ctx): void {
  for (const match of text.matchAll(VARIABLE_RE)) {
    const name = match[1];
    if (name === "run.id") continue;
    if (name === "run.input") {
      if (!scope.input) ctx.errors.push(`${at}: {{run.input}} is not allowed here`);
      continue;
    }
    const artifact = /^artifacts\.([a-z][a-z0-9-]*)\.path$/.exec(name);
    if (artifact) {
      if (!scope.artifacts) ctx.errors.push(`${at}: {{${name}}} is not allowed here`);
      else if (!artifactIds.has(artifact[1])) ctx.errors.push(`${at}: unknown artifact "${artifact[1]}"`);
      continue;
    }
    ctx.errors.push(`${at}: unknown variable {{${name}}}`);
  }
}

function checkArtifactPath(path: string, at: string, ctx: Ctx): void {
  const stripped = path.replace(VARIABLE_RE, "x");
  if (!path) return;
  if (path.includes("\\") || stripped.includes("\0")) ctx.errors.push(`${at}: use forward slashes`);
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) {
    ctx.errors.push(`${at}: must be relative to the workspace`);
  }
  if (path.split("/").some((segment) => segment === ".." || segment === "")) {
    ctx.errors.push(`${at}: must stay inside the workspace`);
  }
  if (path.endsWith("/")) ctx.errors.push(`${at}: must name a file`);
}

function readArtifacts(value: unknown, templates: Readonly<Record<string, string>>, ctx: Ctx): ModeArtifact[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    ctx.errors.push("artifacts: expected a map of artifact ids");
    return [];
  }
  const entries = Object.entries(value);
  if (entries.length > MODE_LIMITS.artifacts) ctx.errors.push(`artifacts: at most ${MODE_LIMITS.artifacts}`);
  const artifacts: ModeArtifact[] = [];
  for (const [id, raw] of entries) {
    const at = `artifacts.${id}`;
    if (!ID_RE.test(id)) ctx.errors.push(`${at}: invalid id; use lowercase letters, digits and dashes`);
    if (!isPlainObject(raw)) {
      ctx.errors.push(`${at}: expected a map`);
      continue;
    }
    rejectUnknownKeys(raw, ARTIFACT_KEYS, at, ctx);
    const path = readString(raw.path, `${at}.path`, ctx, { required: true, maxChars: 300 }) ?? "";
    checkArtifactPath(path, `${at}.path`, ctx);
    checkVariables(path, `${at}.path`, { input: false, artifacts: false }, new Set(), ctx);
    let template: string | undefined;
    const templatePath = readString(raw.template, `${at}.template`, ctx);
    if (templatePath !== undefined) {
      const content = templates[templatePath];
      if (content === undefined) ctx.errors.push(`${at}.template: file "${templatePath}" not found next to mode.md`);
      else template = content;
    }
    const headings: string[] = [];
    if (raw.requiredHeadings !== undefined) {
      if (!Array.isArray(raw.requiredHeadings)) ctx.errors.push(`${at}.requiredHeadings: expected a list`);
      else {
        if (raw.requiredHeadings.length > MODE_LIMITS.requiredHeadings) {
          ctx.errors.push(`${at}.requiredHeadings: at most ${MODE_LIMITS.requiredHeadings}`);
        }
        raw.requiredHeadings.forEach((heading, index) => {
          const text = readString(heading, `${at}.requiredHeadings[${index}]`, ctx, { required: true, maxChars: MODE_LIMITS.headingChars });
          if (text && !headings.includes(text)) headings.push(text.replace(/^#+\s*/, ""));
        });
      }
    }
    artifacts.push({ id, path, ...(template !== undefined ? { template } : {}), requiredHeadings: headings });
  }
  return artifacts;
}

function readBudget(value: unknown, ctx: Ctx): ModeBudget {
  const budget: ModeBudget = { maxTurns: MODE_LIMITS.defaultMaxTurns, maxTokens: null };
  if (value === undefined) return budget;
  if (!isPlainObject(value)) {
    ctx.errors.push("budget: expected a map");
    return budget;
  }
  rejectUnknownKeys(value, BUDGET_KEYS, "budget", ctx);
  if (value.maxTurns === null) budget.maxTurns = null;
  else budget.maxTurns = readInteger(value.maxTurns, "budget.maxTurns", ctx, 1, MODE_LIMITS.maxTurns) ?? budget.maxTurns;
  if (value.maxTokens !== undefined && value.maxTokens !== null) {
    budget.maxTokens = readInteger(value.maxTokens, "budget.maxTokens", ctx, MODE_LIMITS.minTokens, Number.MAX_SAFE_INTEGER) ?? null;
  }
  return budget;
}

function readArtifactRef(value: unknown, at: string, artifactIds: ReadonlySet<string>, ctx: Ctx): string | undefined {
  const text = readString(value, at, ctx, { required: true });
  if (!text) return undefined;
  const match = ARTIFACT_REF_RE.exec(text);
  if (!match) {
    ctx.errors.push(`${at}: expected artifact:<id>`);
    return undefined;
  }
  if (!artifactIds.has(match[1])) ctx.errors.push(`${at}: unknown artifact "${match[1]}"`);
  return match[1];
}

function readInjects(value: unknown, at: string, artifactIds: ReadonlySet<string>, ctx: Ctx): ModeInject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    ctx.errors.push(`${at}: expected a list`);
    return [];
  }
  if (value.length > MODE_LIMITS.injectsPerEvent) ctx.errors.push(`${at}: at most ${MODE_LIMITS.injectsPerEvent} actions`);
  const injects: ModeInject[] = [];
  value.forEach((raw, index) => {
    const itemAt = `${at}[${index}]`;
    if (!isPlainObject(raw)) {
      ctx.errors.push(`${itemAt}: expected { inject: ... }`);
      return;
    }
    rejectUnknownKeys(raw, new Set(["inject"]), itemAt, ctx);
    const text = readString(raw.inject, `${itemAt}.inject`, ctx, { required: true, maxBytes: MODE_LIMITS.promptBytes });
    if (!text) return;
    const ref = ARTIFACT_REF_RE.exec(text);
    if (ref) {
      if (!artifactIds.has(ref[1])) ctx.errors.push(`${itemAt}.inject: unknown artifact "${ref[1]}"`);
      injects.push({ kind: "artifact", artifact: ref[1] });
    } else {
      checkVariables(text, `${itemAt}.inject`, { input: true, artifacts: true }, artifactIds, ctx);
      injects.push({ kind: "text", text });
    }
  });
  return injects;
}

function readOnFail(value: unknown, at: string, ctx: Ctx): ModeGateFailure {
  const failure: ModeGateFailure = { retries: MODE_LIMITS.defaultRetries };
  if (value === undefined) return failure;
  if (!isPlainObject(value)) {
    ctx.errors.push(`${at}: expected a map`);
    return failure;
  }
  rejectUnknownKeys(value, ON_FAIL_KEYS, at, ctx);
  failure.retries = readInteger(value.retries, `${at}.retries`, ctx, 0, MODE_LIMITS.retries) ?? failure.retries;
  const goto = readString(value.goto, `${at}.goto`, ctx);
  if (goto !== undefined) failure.goto = goto;
  return failure;
}

function readGate(raw: unknown, at: string, artifactIds: ReadonlySet<string>, ctx: Ctx): ModeGate | undefined {
  if (!isPlainObject(raw)) {
    ctx.errors.push(`${at}: expected a gate such as { require: artifact:<id> }`);
    return undefined;
  }
  const actions = GATE_ACTIONS.filter((action) => action in raw);
  if (actions.length !== 1) {
    ctx.errors.push(`${at}: declare exactly one of ${GATE_ACTIONS.join(", ")}`);
    return undefined;
  }
  const action = actions[0];
  const allowed = new Set<string>([action, ...(action === "ask" ? [] : ["onFail"])]);
  rejectUnknownKeys(raw, allowed, at, ctx);
  if (action === "ask") {
    if (raw.ask !== "user") ctx.errors.push(`${at}.ask: expected "user"`);
    return { kind: "ask" };
  }
  const onFail = readOnFail(raw.onFail, `${at}.onFail`, ctx);
  if (action === "require") {
    const artifact = readArtifactRef(raw.require, `${at}.require`, artifactIds, ctx);
    return artifact ? { kind: "require", artifact, onFail } : undefined;
  }
  let command: string | undefined;
  let timeoutMinutes: number = MODE_LIMITS.defaultRunTimeoutMinutes;
  if (isPlainObject(raw.run)) {
    rejectUnknownKeys(raw.run, RUN_KEYS, `${at}.run`, ctx);
    command = readString(raw.run.command, `${at}.run.command`, ctx, { required: true, maxChars: MODE_LIMITS.commandChars });
    timeoutMinutes = readInteger(raw.run.timeoutMinutes, `${at}.run.timeoutMinutes`, ctx, 1, MODE_LIMITS.runTimeoutMinutes) ?? timeoutMinutes;
  } else {
    command = readString(raw.run, `${at}.run`, ctx, { required: true, maxChars: MODE_LIMITS.commandChars });
  }
  if (!command) return undefined;
  // The run input is untrusted text; it never reaches a shell command.
  checkVariables(command, `${at}.run`, { input: false, artifacts: true }, artifactIds, ctx);
  return { kind: "run", command, timeoutMinutes, onFail };
}

function readStage(id: string, raw: unknown, modePermission: ModePermission, artifactIds: ReadonlySet<string>, ctx: Ctx): ModeStage | undefined {
  const at = `stages.${id}`;
  if (!ID_RE.test(id)) ctx.errors.push(`${at}: invalid id; start with a letter, then lowercase letters, digits and dashes`);
  if (raw === null || raw === undefined) raw = {};
  if (!isPlainObject(raw)) {
    ctx.errors.push(`${at}: expected a map`);
    return undefined;
  }
  rejectUnknownKeys(raw, STAGE_KEYS, at, ctx);
  const prompt = readString(raw.prompt, `${at}.prompt`, ctx, { maxBytes: MODE_LIMITS.promptBytes }) ?? "";
  checkVariables(prompt, `${at}.prompt`, { input: true, artifacts: true }, artifactIds, ctx);
  const permission = readPermission(raw.permission, `${at}.permission`, ctx) ?? modePermission;
  let loop = false;
  if (raw.loop !== undefined) {
    if (typeof raw.loop !== "boolean") ctx.errors.push(`${at}.loop: expected true or false`);
    else loop = raw.loop;
  }
  let onEnter: ModeInject[] = [];
  let onCompaction: ModeInject[] = [];
  if (raw.on !== undefined) {
    if (!isPlainObject(raw.on)) ctx.errors.push(`${at}.on: expected a map of events`);
    else {
      for (const key of Object.keys(raw.on)) {
        if (!ON_KEYS.has(key)) ctx.errors.push(`${at}.on.${key}: unknown event; use enter or compaction`);
      }
      onEnter = readInjects(raw.on.enter, `${at}.on.enter`, artifactIds, ctx);
      onCompaction = readInjects(raw.on.compaction, `${at}.on.compaction`, artifactIds, ctx);
    }
  }
  const exit: ModeGate[] = [];
  if (raw.exit !== undefined) {
    if (!Array.isArray(raw.exit)) ctx.errors.push(`${at}.exit: expected a list of gates`);
    else {
      if (raw.exit.length > MODE_LIMITS.gatesPerStage) ctx.errors.push(`${at}.exit: at most ${MODE_LIMITS.gatesPerStage} gates`);
      raw.exit.forEach((gate, index) => {
        const parsed = readGate(gate, `${at}.exit[${index}]`, artifactIds, ctx);
        if (parsed) exit.push(parsed);
      });
      const askIndex = exit.findIndex((gate) => gate.kind === "ask");
      if (askIndex !== -1 && askIndex !== exit.length - 1) ctx.errors.push(`${at}.exit: ask must be the last gate`);
    }
  }
  const next = readString(raw.next, `${at}.next`, ctx);
  return { id, prompt, permission, loop, onEnter, onCompaction, exit, ...(next !== undefined ? { next } : {}) };
}

/** Every cycle of `next` / `onFail.goto` edges must pass a stage that waits
 * for the user (`ask`) or for the model to finish (`loop`). */
function checkCycles(stages: readonly ModeStage[], ctx: Ctx): void {
  const breaks = new Set(stages.filter((stage) => stage.loop || stage.exit.some((gate) => gate.kind === "ask")).map((stage) => stage.id));
  const edges = new Map<string, string[]>();
  for (const stage of stages) {
    if (breaks.has(stage.id)) continue;
    const targets = [
      ...(stage.next ? [stage.next] : []),
      ...stage.exit.flatMap((gate) => gate.kind !== "ask" && gate.onFail.goto ? [gate.onFail.goto] : []),
    ].filter((target) => !breaks.has(target));
    edges.set(stage.id, targets);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") {
      ctx.errors.push(`stages: cycle ${[...path.slice(path.indexOf(id)), id].join(" -> ")} never waits; add loop: true or an ask gate`);
      return true;
    }
    state.set(id, "visiting");
    for (const target of edges.get(id) ?? []) if (visit(target, [...path, id])) return true;
    state.set(id, "done");
    return false;
  };
  for (const id of edges.keys()) if (visit(id, [])) return;
}

function checkReferences(stages: readonly ModeStage[], ctx: Ctx): void {
  const ids = new Set(stages.map((stage) => stage.id));
  for (const stage of stages) {
    if (stage.next !== undefined && !ids.has(stage.next)) ctx.errors.push(`stages.${stage.id}.next: unknown stage "${stage.next}"`);
    stage.exit.forEach((gate, index) => {
      if (gate.kind !== "ask" && gate.onFail.goto !== undefined && !ids.has(gate.onFail.goto)) {
        ctx.errors.push(`stages.${stage.id}.exit[${index}].onFail.goto: unknown stage "${gate.onFail.goto}"`);
      }
    });
  }
  const reachable = new Set<string>();
  const queue = stages.length ? [stages[0].id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const stage = stages.find((entry) => entry.id === id);
    if (!stage) continue;
    if (stage.next) queue.push(stage.next);
    for (const gate of stage.exit) if (gate.kind !== "ask" && gate.onFail.goto) queue.push(gate.onFail.goto);
  }
  for (const stage of stages) {
    if (!reachable.has(stage.id)) ctx.warnings.push(`stages.${stage.id}: unreachable from the first stage`);
  }
}

/**
 * Validate one parsed definition document.
 *
 * `frontmatter` is the value the strict YAML reader produced (or `undefined`
 * for a document without frontmatter); `body` is the Markdown after it.
 */
export function parseModeDefinition(frontmatter: unknown, body: string, options: ModeParseOptions): ModeParseResult {
  const ctx: Ctx = { errors: [], warnings: [] };
  const raw: Record<string, unknown> = frontmatter === undefined || frontmatter === null ? {} : (frontmatter as Record<string, unknown>);
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["frontmatter: expected a map"], warnings: [] };
  }
  rejectUnknownKeys(raw, MODE_KEYS, "", ctx);

  const declaredName = readString(raw.name, "name", ctx);
  const id = (declaredName ?? options.fallbackName ?? "").trim();
  if (!id) ctx.errors.push("name: missing, and no directory name to fall back on");
  else if (!ID_RE.test(id)) ctx.errors.push(`name: invalid "${id}"; start with a letter, then lowercase letters, digits and dashes (max 40)`);
  if (declaredName && options.fallbackName && declaredName !== options.fallbackName) {
    ctx.warnings.push(`name: "${declaredName}" differs from the directory name "${options.fallbackName}"`);
  }

  const label = readString(raw.label, "label", ctx, { maxChars: MODE_LIMITS.labelChars }) || id;
  const description = readString(raw.description, "description", ctx, { maxChars: MODE_LIMITS.descriptionChars }) ?? "";
  const permission = readPermission(raw.permission, "permission", ctx) ?? "agent";
  const prompt = body.trim();
  if (new TextEncoder().encode(prompt).length > MODE_LIMITS.promptBytes * 2) {
    ctx.errors.push(`body: larger than ${MODE_LIMITS.promptBytes * 2} bytes`);
  }

  let stages: ModeStage[] = [];
  let artifacts: ModeArtifact[] = [];
  let budget: ModeBudget = { maxTurns: MODE_LIMITS.defaultMaxTurns, maxTokens: null };
  let returnTo = DEFAULT_MODE_ID;

  if (raw.stages === undefined) {
    for (const key of STAGED_ONLY_KEYS) {
      if (raw[key] !== undefined) ctx.errors.push(`${key}: only valid together with stages`);
    }
    checkVariables(prompt, "body", { input: false, artifacts: false }, new Set(), ctx);
    for (const match of prompt.matchAll(VARIABLE_RE)) {
      if (match[1] === "run.id") ctx.errors.push("body: {{run.id}} requires stages");
    }
  } else {
    artifacts = readArtifacts(raw.artifacts, options.templates ?? {}, ctx);
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
    for (const artifact of artifacts) {
      if (artifact.template !== undefined) {
        checkVariables(artifact.template, `artifacts.${artifact.id}.template`, { input: true, artifacts: true }, artifactIds, ctx);
      }
    }
    checkVariables(prompt, "body", { input: true, artifacts: true }, artifactIds, ctx);
    budget = readBudget(raw.budget, ctx);
    const declaredReturn = readString(raw.returnTo, "returnTo", ctx);
    if (declaredReturn !== undefined) {
      if (!ID_RE.test(declaredReturn)) ctx.errors.push(`returnTo: invalid mode id "${declaredReturn}"`);
      else if (declaredReturn === id) ctx.errors.push("returnTo: must name another mode");
      returnTo = declaredReturn;
    }
    if (!isPlainObject(raw.stages)) ctx.errors.push("stages: expected a map of stage ids");
    else {
      const entries = Object.entries(raw.stages);
      if (entries.length === 0) ctx.errors.push("stages: declare at least one stage, or remove the key for a simple mode");
      if (entries.length > MODE_LIMITS.stages) ctx.errors.push(`stages: at most ${MODE_LIMITS.stages}`);
      for (const [stageId, stageRaw] of entries) {
        const stage = readStage(stageId, stageRaw, permission, artifactIds, ctx);
        if (stage) stages.push(stage);
      }
      checkReferences(stages, ctx);
      checkCycles(stages, ctx);
    }
  }

  if (ctx.errors.length) return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  return {
    ok: true,
    warnings: ctx.warnings,
    definition: {
      version: MODE_DEFINITION_VERSION,
      id,
      label,
      description,
      permission,
      prompt,
      source: options.source,
      artifacts,
      budget,
      returnTo,
      stages,
    },
  };
}
