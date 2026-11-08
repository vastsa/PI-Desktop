/**
 * Mode definition and mode run channels (ADR mode-definitions).
 *
 * Catalog edits stay in Electron main (`~/.pi/modes`); run state stays in
 * host-core. Every renderer argument is checked here before it reaches either.
 */
import {
  IPC,
  isModeId,
  type ModeControlAction,
  type ModeControlRequest,
  type ModeResolveAction,
  type ModeResolveRequest,
} from "@pi-desktop/shared";
import type { ModeCatalogService } from "../runtime/mode-catalog";
import type { ModeRunCoordinator } from "../runtime/mode-runs";
import type { IpcRegistrar } from "./types";

export type ModesIpcDependencies = {
  registrar: IpcRegistrar;
  catalog: ModeCatalogService;
  runs: ModeRunCoordinator;
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

const CONTROL_ACTIONS: readonly ModeControlAction[] = ["pause", "resume", "stop"];
const RESOLVE_ACTIONS: readonly ModeResolveAction[] = ["approve", "reject"];

export function registerModesIpc({ registrar, catalog, runs }: ModesIpcDependencies): void {
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
  registrar.handle(IPC.invoke.modesRunResolve, async (value: unknown) => {
    const request = runRequestArg(value);
    if (!RESOLVE_ACTIONS.includes(request.action as ModeResolveAction)) throw invalid("action is invalid");
    return runs.resolve(request as ModeResolveRequest);
  });
}
