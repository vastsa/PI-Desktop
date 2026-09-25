/**
 * The main-process half of a plugin's renderer extension
 * (`docs/plugin-plan/ui/`, `docs/plugin-plan/render/plugin-call/`).
 *
 * `PluginRuntime` owns which plugins are loaded; this module owns what a
 * loaded plugin's renderer extension may reach, so the runtime only delegates:
 *
 * - the descriptor the renderer host loads from, stamped with a per-load
 *   generation so a reload evaluates fresh modules;
 * - the `plugin-renderer://` source resolver: current generation only, real
 *   paths inside the package only, regular files only;
 * - the `plugin.call` relay: method whitelist, UTF-8 size ceiling, QPS brake,
 *   2s timeout and a failure breaker, answering the renderer only in coded
 *   errors.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginManifest } from "@pi-desktop/plugin-sdk";
import type { PluginRendererDescriptor } from "@pi-desktop/shared";

export const RENDERER_EXTENSION_PERMISSION = "renderer.extension";

/** `plugin.call` relay limits (`docs/plugin-plan/render/plugin-call/`). */
export const RENDERER_CALL_QPS = 10;
/** Args and answer together, counted in UTF-8 bytes of their JSON text. */
export const RENDERER_CALL_MAX_BYTES = 64 * 1024;
export const RENDERER_CALL_TIMEOUT_MS = 2_000;
export const RENDERER_CALL_BREAKER_THRESHOLD = 5;
export const RENDERER_CALL_BREAKER_COOLDOWN_MS = 30_000;

/** What of a loaded plugin the renderer extension reads. */
export type RendererExtensionPlugin = {
  readonly manifest: PluginManifest;
  readonly path: string;
  readonly permissions: ReadonlySet<string>;
  readonly disposing: boolean;
};

/**
 * A refusal the renderer can branch on. `errorCode` is what the IPC layer
 * forwards as the result's code; `code` keeps main-side callers uniform with
 * the runtime's other API errors.
 */
export type RendererCallError = Error & { code: string; errorCode: string };

export function rendererCallError(code: string, message: string): RendererCallError {
  const error = new Error(message) as RendererCallError;
  error.code = code;
  error.errorCode = code;
  return error;
}

function servesRenderer(plugin: RendererExtensionPlugin | undefined): plugin is RendererExtensionPlugin {
  return Boolean(
    plugin &&
      !plugin.disposing &&
      plugin.permissions.has(RENDERER_EXTENSION_PERMISSION) &&
      plugin.manifest.renderer,
  );
}

/**
 * Load generations, keyed by the runtime's per-load record: a reload builds a
 * new record, so it can never inherit the previous load's generation, and an
 * unloaded record takes its entry with it.
 */
let generationCounter = 0;
const generations = new WeakMap<object, number>();

export function rendererGeneration(plugin: object): number {
  let generation = generations.get(plugin);
  if (generation === undefined) {
    generation = ++generationCounter;
    generations.set(plugin, generation);
  }
  return generation;
}

/** The renderer host's view of a loaded plugin, or nothing to load. */
export function rendererDescriptorFor(
  plugin: RendererExtensionPlugin | undefined,
): PluginRendererDescriptor | undefined {
  if (!servesRenderer(plugin)) return undefined;
  const { manifest } = plugin;
  return {
    entry: manifest.renderer as string,
    generation: rendererGeneration(plugin),
    actions: [...(manifest.rendererActions ?? [])],
    callMethods: [...(manifest.rendererCallMethods ?? [])],
    tools: (manifest.contributes?.agentTools ?? []).map((tool) => tool.name),
  };
}

/**
 * The file behind `plugin-renderer://<id>/g<generation>/<requestPath>`, or
 * null. The generation must be the one the current load handed out, so a
 * module URL from before a reload stops resolving; containment is checked on
 * real paths, so a symlink inside the package cannot point out of it.
 */
export function resolveRendererSourcePath(
  plugin: RendererExtensionPlugin | undefined,
  generation: number,
  requestPath: string,
): string | null {
  if (!servesRenderer(plugin)) return null;
  // Peek, never assign: only a descriptor hands a generation out.
  if (generations.get(plugin) !== generation) return null;
  try {
    const base = realpathSync(resolve(plugin.path));
    const target = realpathSync(resolve(base, requestPath));
    const inside = relative(base, target);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return null;
    }
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

export type RendererCallPayload = { method: string; args: unknown };

/** Relays one call into the plugin's host process. */
export type RendererCallSend<T> = (
  plugin: T,
  payload: RendererCallPayload,
  timeoutMs: number,
) => Promise<unknown>;

type RelayState = {
  /** Relayed call timestamps inside the current 1s window. */
  calls: number[];
  /** Consecutive relayed failures. */
  failures: number;
  disabledUntil: number;
};

/** JSON text of a value, or undefined when it has none (function, cycle, BigInt). */
function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : undefined;
}

/**
 * The `plugin.call` relay. Refusals before the relay (not loaded, undeclared
 * method, cooling down, over the rate, unserializable or oversize args) are
 * the caller's problem and never count against the plugin. Everything after
 * the relay (timeout, a thrown error, a missing `onRendererCall`, an answer
 * that is not JSON or too large) is the plugin's, and five in a row close the
 * relay for 30s; one success reopens the count.
 */
export class RendererCallRelay {
  private readonly states = new WeakMap<object, RelayState>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async call<T extends RendererExtensionPlugin>(
    pluginId: string,
    plugin: T | undefined,
    method: string,
    args: unknown,
    send: RendererCallSend<T>,
  ): Promise<unknown> {
    if (!plugin || plugin.disposing) {
      throw rendererCallError("PLUGIN_NOT_FOUND", `renderer plugin not loaded: ${pluginId}`);
    }
    if (!plugin.permissions.has(RENDERER_EXTENSION_PERMISSION)) {
      throw rendererCallError("PLUGIN_PERMISSION_DENIED", `${RENDERER_EXTENSION_PERMISSION} is not granted`);
    }
    if (!plugin.manifest.renderer || !plugin.manifest.rendererCallMethods?.includes(method)) {
      throw rendererCallError("PLUGIN_CALL_NO_HANDLER", `method not declared: ${method}`);
    }
    const state = this.stateFor(plugin);
    const startedAt = this.now();
    if (startedAt < state.disabledUntil) {
      throw rendererCallError(
        "PLUGIN_CALL_DISABLED",
        "plugin.call is cooling down after repeated failures",
      );
    }
    state.calls = state.calls.filter((at) => startedAt - at < 1_000);
    if (state.calls.length >= RENDERER_CALL_QPS) {
      throw rendererCallError(
        "PLUGIN_CALL_RATE_LIMITED",
        `plugin.call exceeds ${RENDERER_CALL_QPS} calls/s`,
      );
    }
    // Omitted args relay as omitted; anything else must be JSON, and the
    // plugin receives the JSON reading of it rather than the raw value.
    const argsText = args === undefined ? undefined : jsonText(args);
    if (args !== undefined && argsText === undefined) {
      throw rendererCallError("PLUGIN_CALL_UNSERIALIZABLE", "plugin.call args must be JSON");
    }
    const argsBytes = argsText === undefined ? 0 : Buffer.byteLength(argsText, "utf8");
    if (argsBytes > RENDERER_CALL_MAX_BYTES) {
      throw rendererCallError("PLUGIN_CALL_TOO_LARGE", "plugin.call args exceed 64KB");
    }
    state.calls.push(startedAt);

    let answer: unknown;
    try {
      answer = await send(
        plugin,
        { method, args: argsText === undefined ? undefined : JSON.parse(argsText) },
        RENDERER_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      this.recordFailure(state);
      const code = errorCodeOf(error);
      if (code === "TIMEOUT") {
        throw rendererCallError(
          "PLUGIN_CALL_TIMEOUT",
          `plugin ${pluginId} did not answer ${method} within ${RENDERER_CALL_TIMEOUT_MS}ms`,
        );
      }
      // The plugin's own code passes through so its component can branch on
      // it; an uncoded failure still reaches the renderer as a coded one.
      throw rendererCallError(
        code ?? "PLUGIN_CALL_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    const answerText = jsonText(answer ?? null);
    if (answerText === undefined) {
      this.recordFailure(state);
      throw rendererCallError("PLUGIN_CALL_UNSERIALIZABLE", "plugin.call answer must be JSON");
    }
    if (argsBytes + Buffer.byteLength(answerText, "utf8") > RENDERER_CALL_MAX_BYTES) {
      this.recordFailure(state);
      throw rendererCallError("PLUGIN_CALL_TOO_LARGE", "plugin.call args and answer exceed 64KB");
    }
    state.failures = 0;
    return JSON.parse(answerText) as unknown;
  }

  private stateFor(plugin: object): RelayState {
    let state = this.states.get(plugin);
    if (!state) {
      state = { calls: [], failures: 0, disabledUntil: 0 };
      this.states.set(plugin, state);
    }
    return state;
  }

  private recordFailure(state: RelayState): void {
    state.failures += 1;
    if (state.failures < RENDERER_CALL_BREAKER_THRESHOLD) return;
    state.failures = 0;
    state.disabledUntil = this.now() + RENDERER_CALL_BREAKER_COOLDOWN_MS;
  }
}
