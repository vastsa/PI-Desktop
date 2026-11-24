/**
 * Mode definition and mode run channels (ADR mode-definitions).
 *
 * Catalog edits stay in Electron main (`~/.pi/modes`); run state stays in
 * host-core. Every renderer argument is checked here before it reaches either.
 */
import {
  IPC,
  isModeId,
  type ModeBundleSettingsRequest,
  type ModeBundleWriteRequest,
  type ModeControlAction,
  type ModeControlRequest,
  type ModeCopyRequest,
  type ModeResolveAction,
  type ModeResolveRequest,
  type ModeRunBudget,
  type ModeUpdateRequest,
} from "@pi-desktop/shared";
import {
  hasBundleSettingsPatch,
  openModeSkillsDirectory,
  readModeSkillsState,
  saveModeBundleSettings,
  type ModeBundleSettingsPatch,
} from "../runtime/mode-bundle-settings";
import type { ModeCatalogService } from "../runtime/mode-catalog";
import type { ModeRunCoordinator } from "../runtime/mode-runs";
import type { IpcRegistrar } from "./types";

export type ModesIpcDependencies = {
  registrar: IpcRegistrar;
  catalog: ModeCatalogService;
  runs: ModeRunCoordinator;
  /**
   * The host's trusted shell (`shell.openPath`), injected so the mode settings
   * can open a mode's `skills/` folder without this module importing Electron.
   * A missing implementation reports the channel as unsupported instead of
   * silently doing nothing.
   */
  openPath?: (path: string) => Promise<string>;
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

function modeIdArg(value: unknown): string {
  if (!isModeId(value)) throw invalid("mode id is invalid");
  return value;
}

function sourceArg(value: unknown): string {
  if (typeof value !== "string") throw invalid("source must be a string");
  return value;
}

function sessionIdArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw invalid("sessionId is invalid");
  return value;
}

function runRequestArg(value: unknown): { sessionId: string; runId: string; expectedRevision: number; action: unknown } {
  const request = (value ?? {}) as Record<string, unknown>;
  const runId = request.runId;
  const expectedRevision = request.expectedRevision;
  if (typeof runId !== "string" || !runId.trim() || runId.length > 200) throw invalid("runId is invalid");
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw invalid("expectedRevision is invalid");
  }
  return { sessionId: sessionIdArg(request.sessionId), runId, expectedRevision, action: request.action };
}

const CONTROL_ACTIONS: readonly ModeControlAction[] = ["pause", "resume", "stop", "remove"];
/** Same ceiling as the Host's run input. */
const MAX_INPUT_LENGTH = 100_000;

function budgetLimitArg(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid(`${name} is invalid`);
  return value;
}

/** Shape check only; the Host owns the range and the run state. */
export function modeUpdateRequestArg(value: unknown): ModeUpdateRequest {
  const { action: _action, ...base } = runRequestArg(value);
  const request = (value ?? {}) as Record<string, unknown>;
  const update: ModeUpdateRequest = base;
  if (request.input !== undefined) {
    if (typeof request.input !== "string" || !request.input.trim() || request.input.length > MAX_INPUT_LENGTH) {
      throw invalid("input is invalid");
    }
    update.input = request.input;
  }
  if (request.budget !== undefined) {
    const budget = (request.budget ?? {}) as Record<string, unknown>;
    if (typeof request.budget !== "object" || request.budget === null || !("maxTurns" in budget) || !("maxTokens" in budget)) {
      throw invalid("budget is invalid");
    }
    update.budget = {
      maxTurns: budgetLimitArg(budget.maxTurns, "budget.maxTurns"),
      maxTokens: budgetLimitArg(budget.maxTokens, "budget.maxTokens"),
    } satisfies ModeRunBudget;
  }
  if (update.input === undefined && update.budget === undefined) throw invalid("nothing to update");
  return update;
}
const RESOLVE_ACTIONS: readonly ModeResolveAction[] = ["approve", "reject"];

/**
 * A bundle write: the map plus exactly the documents it names.
 *
 * Every document text is a string here; whether a reference stays inside the
 * mode directory and whether the map is well-formed is decided where the files
 * are, so this only refuses a shape that could not be a request at all.
 */
function bundleWriteArg(value: unknown): ModeBundleWriteRequest {
  const request = (value ?? {}) as Record<string, unknown>;
  const agents: Record<string, string> = {};
  if (request.agents !== undefined) {
    if (typeof request.agents !== "object" || request.agents === null || Array.isArray(request.agents)) {
      throw invalid("agents must map references to documents");
    }
    for (const [reference, text] of Object.entries(request.agents as Record<string, unknown>)) {
      if (typeof text !== "string") throw invalid(`agents["${reference}"] must be a string`);
      agents[reference] = text;
    }
  }
  return {
    id: modeIdArg(request.id),
    source: sourceArg(request.source),
    prompt: sourceArg(request.prompt),
    agents,
  };
}

function copyArg(value: unknown): ModeCopyRequest {
  const request = (value ?? {}) as Record<string, unknown>;
  return { fromId: modeIdArg(request.fromId), toId: modeIdArg(request.toId) };
}

/**
 * A mode-level patch. Only the two keys the settings page owns are accepted, and
 * at least one must be present: an empty patch would write the bundle for no
 * reason and bump the file's mtime.
 */
function bundleSettingsArg(value: unknown): ModeBundleSettingsPatch {
  const request = (value ?? {}) as Record<string, unknown>;
  const patch: ModeBundleSettingsPatch = {};
  if (request.includeGlobalSubagents !== undefined) {
    if (typeof request.includeGlobalSubagents !== "boolean") {
      throw invalid("includeGlobalSubagents must be true or false");
    }
    patch.includeGlobalSubagents = request.includeGlobalSubagents;
  }
  if (request.disabledSkills !== undefined) {
    if (!Array.isArray(request.disabledSkills)) throw invalid("disabledSkills must be a list of skill ids");
    patch.disabledSkills = request.disabledSkills.map((entry) => {
      if (typeof entry !== "string") throw invalid("disabledSkills accepts skill ids");
      return entry;
    });
  }
  if (!hasBundleSettingsPatch(patch)) throw invalid("nothing to update");
  return patch;
}

export function registerModesIpc({ registrar, catalog, runs, openPath }: ModesIpcDependencies): void {
  registrar.handle(IPC.invoke.modesCatalog, async () => catalog.catalog());
  registrar.handle(IPC.invoke.modesRead, async (id: unknown) => catalog.read(modeIdArg(id)));
  registrar.handle(IPC.invoke.modesValidate, async (request: unknown) => {
    const { id, source } = (request ?? {}) as Record<string, unknown>;
    return catalog.validate(modeIdArg(id), sourceArg(source));
  });
  registrar.handle(IPC.invoke.modesWrite, async (request: unknown) => {
    const { id, source } = (request ?? {}) as Record<string, unknown>;
    return catalog.write(modeIdArg(id), sourceArg(source));
  });
  registrar.handle(IPC.invoke.modesDelete, async (id: unknown) => catalog.remove(modeIdArg(id)));

  registrar.handle(IPC.invoke.modesRunGet, async (sessionId: unknown) => runs.get(sessionIdArg(sessionId)));
  registrar.handle(IPC.invoke.modesRunControl, async (value: unknown) => {
    const request = runRequestArg(value);
    if (!CONTROL_ACTIONS.includes(request.action as ModeControlAction)) throw invalid("action is invalid");
    return runs.control(request as ModeControlRequest);
  });
  registrar.handle(IPC.invoke.modesRunUpdate, async (value: unknown) => runs.update(modeUpdateRequestArg(value)));
  registrar.handle(IPC.invoke.modesRunResolve, async (value: unknown) => {
    const request = runRequestArg(value);
    if (!RESOLVE_ACTIONS.includes(request.action as ModeResolveAction)) throw invalid("action is invalid");
    return runs.resolve(request as ModeResolveRequest);
  });

  // --- `mode.yaml` bundles (issue #2544) ------------------------------------

  registrar.handle(IPC.invoke.modesBundleRead, async (id: unknown) => catalog.readBundle(modeIdArg(id)));
  registrar.handle(IPC.invoke.modesBundleWrite, async (value: unknown) => {
    const request = bundleWriteArg(value);
    const { id, ...contents } = request;
    return catalog.writeBundle(id, contents);
  });
  registrar.handle(IPC.invoke.modesCopy, async (value: unknown) => {
    const { fromId, toId } = copyArg(value);
    return catalog.copy(fromId, toId);
  });
  registrar.handle(IPC.invoke.modesBundleSettings, async (value: unknown) => {
    const id = modeIdArg((value as Record<string, unknown> | null)?.id);
    return saveModeBundleSettings(catalog, id, bundleSettingsArg(value));
  });
  registrar.handle(IPC.invoke.modesSkills, async (id: unknown) => readModeSkillsState(catalog, modeIdArg(id)));
  registrar.handle(IPC.invoke.modesSkillsOpen, async (id: unknown) => {
    if (!openPath) {
      throw Object.assign(new Error("this build cannot open a folder"), { errorCode: "UNSUPPORTED" });
    }
    return openModeSkillsDirectory(catalog, modeIdArg(id), openPath);
  });
}
