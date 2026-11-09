import {
  IPC,
  type ModeCatalog,
  type ModeCatalogEntry,
  type ModeDiagnostic,
  type ModeControlRequest,
  type ModeDocumentReadResult,
  type ModeDocumentValidation,
  type ModeDocumentWriteRequest,
  type ModeResolveRequest,
  type ModeRun,
  type ModesChangedEvent,
} from "@pi-desktop/shared";

/**
 * The renderer's mode surface (ADR mode-definitions).
 *
 * Electron main owns the definition files (`~/.pi/modes`) and host-core owns
 * run state; this module only forwards requests and narrows pushed payloads.
 * A rejection keeps its `MODE_*` code as `code` so the UI can name it.
 */

export type ModeRunControlResult = { run: ModeRun | null; continue: boolean };

export type ModesApiError = Error & { code?: string; details?: unknown };

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge?.invoke) throw new Error("piDesktop preload bridge unavailable");
  const result = await bridge.invoke<T>(channel, ...args);
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
      details: result.error.details,
    }) as ModesApiError;
  }
  return result.data;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** A pushed catalog has the wire shape the renderer reads, or is dropped. */
export function parseModeCatalog(value: unknown): ModeCatalog | null {
  const catalog = record(value);
  if (!catalog || !Array.isArray(catalog.modes) || typeof catalog.directory !== "string") return null;
  const modes: ModeCatalogEntry[] = [];
  for (const entry of catalog.modes) {
    const mode = record(entry);
    if (
      !mode ||
      typeof mode.id !== "string" ||
      typeof mode.label !== "string" ||
      (mode.source !== "builtin" && mode.source !== "user") ||
      typeof mode.available !== "boolean"
    ) {
      continue;
    }
    modes.push({
      id: mode.id,
      label: mode.label,
      description: typeof mode.description === "string" ? mode.description : "",
      source: mode.source,
      staged: mode.staged === true,
      available: mode.available,
      ...(mode.reserved === true ? { reserved: true } : {}),
      ...(typeof mode.filePath === "string" ? { filePath: mode.filePath } : {}),
    });
  }
  const diagnostics: ModeDiagnostic[] = [];
  for (const entry of Array.isArray(catalog.diagnostics) ? catalog.diagnostics : []) {
    const diagnostic = record(entry);
    if (!diagnostic || typeof diagnostic.modeId !== "string") continue;
    diagnostics.push({
      modeId: diagnostic.modeId,
      ...(typeof diagnostic.filePath === "string" ? { filePath: diagnostic.filePath } : {}),
      errors: strings(diagnostic.errors),
      warnings: strings(diagnostic.warnings),
    });
  }
  return { modes, diagnostics, directory: catalog.directory };
}

/** A run payload must carry the identity and revision the UI acts on. */
export function parseModeRun(value: unknown): ModeRun | null {
  const run = record(value);
  if (
    !run ||
    typeof run.id !== "string" ||
    typeof run.sessionId !== "string" ||
    typeof run.modeId !== "string" ||
    typeof run.stageId !== "string" ||
    typeof run.state !== "string" ||
    typeof run.revision !== "number"
  ) {
    return null;
  }
  return run as unknown as ModeRun;
}

export function parseModesChangedEvent(value: unknown): ModesChangedEvent | null {
  const event = record(value);
  if (!event || typeof event.sessionId !== "string" || !event.sessionId) return null;
  if (event.run === null || event.run === undefined) return { sessionId: event.sessionId, run: null };
  const run = parseModeRun(event.run);
  return run ? { sessionId: event.sessionId, run } : null;
}

function runResult(value: { run?: unknown; continue?: unknown } | null | undefined): ModeRunControlResult {
  return { run: parseModeRun(value?.run), continue: value?.continue === true };
}

export const modesApi = {
  catalog: () => invoke<unknown>(IPC.invoke.modesCatalog).then(parseModeCatalog),
  read: (id: string) => invoke<ModeDocumentReadResult>(IPC.invoke.modesRead, id),
  validate: (request: ModeDocumentWriteRequest) =>
    invoke<ModeDocumentValidation>(IPC.invoke.modesValidate, request),
  write: (request: ModeDocumentWriteRequest) =>
    invoke<unknown>(IPC.invoke.modesWrite, request).then(parseModeCatalog),
  remove: (id: string) => invoke<unknown>(IPC.invoke.modesDelete, id).then(parseModeCatalog),
  getRun: (sessionId: string) =>
    invoke<{ run?: unknown }>(IPC.invoke.modesRunGet, sessionId).then((result) => parseModeRun(result?.run)),
  controlRun: (request: ModeControlRequest) =>
    invoke<{ run?: unknown; continue?: unknown }>(IPC.invoke.modesRunControl, request).then(runResult),
  resolveRun: (request: ModeResolveRequest) =>
    invoke<{ run?: unknown; continue?: unknown }>(IPC.invoke.modesRunResolve, request).then(runResult),
  onCatalogChanged: (listener: (catalog: ModeCatalog) => void): (() => void) => {
    const bridge = window.piDesktop;
    if (!bridge?.on) return () => undefined;
    return bridge.on(IPC.event.modesCatalogChanged, (payload) => {
      const catalog = parseModeCatalog(payload);
      if (catalog) listener(catalog);
    });
  },
  onRunChanged: (listener: (event: ModesChangedEvent) => void): (() => void) => {
    const bridge = window.piDesktop;
    if (!bridge?.on) return () => undefined;
    return bridge.on(IPC.event.modesChanged, (payload) => {
      const event = parseModesChangedEvent(payload);
      if (event) listener(event);
    });
  },
};
