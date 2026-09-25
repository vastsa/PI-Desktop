/**
 * Loads plugin renderer entries into the app window and hands each one the
 * `pi` API (`PiRendererApi`, `docs/plugin-plan/slot-contract.html`).
 *
 * An entry is a plain ES module served from
 * `plugin-renderer://<id>/g<generation>/<entry>`. The generation is the main
 * process's load counter: a reload comes with a new one, so the window
 * evaluates the new code instead of its cached module graph, and the old URLs
 * stop resolving.
 *
 * Each load is its own session. Registrations, style sheets, layers, draft
 * subscriptions and the dispatch channel belong to the load that made them, and ending the load
 * disposes all of them before the plugin's `onUnload` runs, whatever the
 * plugin does or fails to do. The `pi` of an ended load stays dead:
 * registering, injecting or opening a layer through it throws
 * `PLUGIN_UNLOADED`, dispatching rejects with it. A load that fails (the
 * import, a missing `onLoad`, a throwing `onLoad`) is torn down, reported
 * once, and not retried until the main process hands out a new generation.
 */
import {
  PLUGIN_RENDERER_SCHEME,
  type PiRendererApi,
  type PiRendererModule,
  type PluginDisposer,
  type PluginDraftListener,
  type PluginLayer,
  type PluginSlotRegistration,
} from "@pi-desktop/plugin-sdk";
import {
  isActiveInProject,
  type PluginRendererDescriptor,
  type PluginSummary,
} from "@pi-desktop/shared";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { PluginRendererError } from "../renderer-error";
import { pluginLayers } from "../renderer-layers/layer-stack";
import { slotRegistry, type SlotRegistry } from "../renderer-slots/registry";
import { injectPluginStyle } from "../renderer-slots/style-injection";
import { createDispatchChannel, type DispatchChannel } from "./dispatch";

export type RendererLoadSpec = {
  readonly pluginId: string;
  readonly version: string;
  readonly descriptor: PluginRendererDescriptor;
};

/** How a load ended up. `cancelled`: it was unloaded before it finished. */
export type RendererLoadOutcome =
  | { readonly status: "loaded" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled" };

export type RendererLoaderDeps = {
  importModule(url: string): Promise<unknown>;
  registry: Pick<SlotRegistry, "register">;
  injectStyle(pluginId: string, css: string): PluginDisposer;
  openLayer(pluginId: string): PluginLayer;
  openChannel(pluginId: string, actions: readonly string[]): DispatchChannel;
  subscribeDraft(pluginId: string, listener: PluginDraftListener): PluginDisposer;
  warn(message: string, error: unknown): void;
};

const LOADED: RendererLoadOutcome = { status: "loaded" };
const CANCELLED: RendererLoadOutcome = { status: "cancelled" };

/** The module URL of a load's entry; the protocol decodes each segment. */
export function rendererModuleUrl(
  pluginId: string,
  descriptor: Pick<PluginRendererDescriptor, "entry" | "generation">,
): string {
  const entry = descriptor.entry
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${PLUGIN_RENDERER_SCHEME}://${encodeURIComponent(pluginId)}/g${descriptor.generation}/${entry}`;
}

/** Named `onLoad`/`onUnload` exports, or a default export object with them. */
function rendererModuleOf(namespace: unknown): PiRendererModule | undefined {
  const exported = namespace as { onLoad?: unknown; default?: unknown } | null;
  if (typeof exported?.onLoad === "function") return exported as PiRendererModule;
  const fallback = exported?.default as { onLoad?: unknown } | null | undefined;
  if (typeof fallback?.onLoad === "function") return fallback as PiRendererModule;
  return undefined;
}

function settled(run: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** One load of one plugin: its `pi`, what it registered, and its teardown. */
class RendererLoad {
  readonly signature: string;
  readonly ready: Promise<RendererLoadOutcome>;
  private readonly spec: RendererLoadSpec;
  private readonly deps: RendererLoaderDeps;
  private alive = true;
  private readonly disposers = new Set<PluginDisposer>();
  private readonly channel: DispatchChannel;
  private readonly pi: PiRendererApi;
  private module: PiRendererModule | undefined;
  /** Settles once `onLoad` has returned or thrown; never rejects. */
  private onLoadSettled: Promise<unknown> = Promise.resolve();
  private ending: Promise<void> | undefined;

  constructor(signature: string, spec: RendererLoadSpec, deps: RendererLoaderDeps) {
    this.signature = signature;
    this.spec = spec;
    this.deps = deps;
    this.channel = deps.openChannel(spec.pluginId, spec.descriptor.actions);
    this.pi = this.createPi();
    this.ready = this.run();
  }

  private createPi(): PiRendererApi {
    const { pluginId, version, descriptor } = this.spec;
    return Object.freeze({
      plugin: Object.freeze({ id: pluginId, version }),
      slots: Object.freeze({
        register: (registration: PluginSlotRegistration) => {
          this.assertAlive();
          return this.track(this.deps.registry.register(pluginId, registration, descriptor.tools));
        },
      }),
      ui: Object.freeze({
        injectStyle: (css: string) => {
          this.assertAlive();
          return this.track(this.deps.injectStyle(pluginId, css));
        },
        openLayer: () => {
          this.assertAlive();
          const layer = this.deps.openLayer(pluginId);
          return Object.freeze({ element: layer.element, close: this.track(layer.close) });
        },
      }),
      composer: Object.freeze({
        subscribeDraft: (listener: PluginDraftListener) => {
          this.assertAlive();
          // Following the draft reads it, so it takes the same declaration.
          if (!descriptor.actions.includes("composer.readDraft")) {
            throw new PluginRendererError(
              "PLUGIN_ACTION_UNDECLARED",
              `composer.readDraft is not in ${pluginId}'s manifest.rendererActions`,
            );
          }
          if (typeof listener !== "function") {
            throw new TypeError("composer.subscribeDraft takes a listener function");
          }
          return this.track(this.deps.subscribeDraft(pluginId, listener));
        },
      }),
      dispatch: this.channel.dispatch,
    });
  }

  private assertAlive(): void {
    if (!this.alive) {
      throw new PluginRendererError("PLUGIN_UNLOADED", `${this.spec.pluginId} is unloaded`);
    }
  }

  /** Hand the plugin a disposer that the end of this load also runs. */
  private track(dispose: PluginDisposer): PluginDisposer {
    const tracked: PluginDisposer = () => {
      if (this.disposers.delete(tracked)) dispose();
    };
    this.disposers.add(tracked);
    return tracked;
  }

  private async run(): Promise<RendererLoadOutcome> {
    let namespace: unknown;
    try {
      namespace = await this.deps.importModule(
        rendererModuleUrl(this.spec.pluginId, this.spec.descriptor),
      );
    } catch (error) {
      return this.alive ? this.fail(error) : CANCELLED;
    }
    if (!this.alive) return CANCELLED;
    const module = rendererModuleOf(namespace);
    if (!module) return this.fail(new Error("the renderer entry does not export onLoad(pi)"));
    this.module = module;
    const loading = settled(() => module.onLoad(this.pi));
    this.onLoadSettled = loading.catch(() => undefined);
    try {
      await loading;
    } catch (error) {
      return this.alive ? this.fail(error) : CANCELLED;
    }
    return this.alive ? LOADED : CANCELLED;
  }

  private fail(error: unknown): RendererLoadOutcome {
    this.deps.warn(`[plugin-renderer] ${this.spec.pluginId} failed to load`, error);
    void this.end();
    return { status: "failed", error };
  }

  /**
   * End this load: the host side at once, then the plugin's `onUnload` once
   * `onLoad` has settled. Idempotent; resolves when `onUnload` has run.
   */
  end(): Promise<void> {
    if (this.ending) return this.ending;
    this.alive = false;
    this.channel.close();
    for (const dispose of [...this.disposers]) dispose();
    this.ending = this.onLoadSettled.then(() => this.runOnUnload());
    return this.ending;
  }

  private async runOnUnload(): Promise<void> {
    const module = this.module;
    if (typeof module?.onUnload !== "function") return;
    try {
      await module.onUnload();
    } catch (error) {
      this.deps.warn(`[plugin-renderer] ${this.spec.pluginId} onUnload failed`, error);
    }
  }
}

export class RendererModuleLoader {
  private readonly loads = new Map<string, RendererLoad>();
  private readonly deps: RendererLoaderDeps;

  constructor(deps: RendererLoaderDeps) {
    this.deps = deps;
  }

  /**
   * Bring a plugin to the load `spec` describes. The same generation is one
   * load, however often it is asked for; a new one ends the previous load
   * first. Resolves with the load's outcome and never rejects.
   */
  load(spec: RendererLoadSpec): Promise<RendererLoadOutcome> {
    const signature = `${spec.descriptor.generation}:${spec.descriptor.entry}`;
    const current = this.loads.get(spec.pluginId);
    if (current?.signature === signature) return current.ready;
    if (current) void this.unload(spec.pluginId);
    const next = new RendererLoad(signature, spec, this.deps);
    this.loads.set(spec.pluginId, next);
    return next.ready;
  }

  /** End a plugin's load; resolves once its `onUnload` has run. */
  unload(pluginId: string): Promise<void> {
    const current = this.loads.get(pluginId);
    if (!current) return Promise.resolve();
    this.loads.delete(pluginId);
    return current.end();
  }

  /** Load exactly `specs`: start or keep each of them, end every other load. */
  sync(specs: readonly RendererLoadSpec[]): void {
    const wanted = new Set(specs.map((spec) => spec.pluginId));
    for (const pluginId of this.loadedPluginIds()) {
      if (!wanted.has(pluginId)) void this.unload(pluginId);
    }
    for (const spec of specs) void this.load(spec);
  }

  /** Plugins with a load, failed ones included, so they are not retried. */
  loadedPluginIds(): string[] {
    return [...this.loads.keys()];
  }
}

/**
 * The loads a plugin list asks for: every plugin the main process hands a
 * renderer descriptor (it is running, declares `manifest.renderer` and holds
 * `renderer.extension`) that is active in the open project. A project-scoped
 * plugin's slots belong to its projects, like its views and tools.
 */
export function rendererLoadSpecs(
  plugins: readonly PluginSummary[],
  projectPath: string | null | undefined,
): RendererLoadSpec[] {
  return plugins.flatMap((summary) =>
    summary.renderer && isActiveInProject(summary, projectPath)
      ? [{ pluginId: summary.id, version: summary.version, descriptor: summary.renderer }]
      : [],
  );
}

/** The app window's loader. */
export const rendererModules = new RendererModuleLoader({
  importModule: (url) => import(/* @vite-ignore */ url),
  registry: slotRegistry,
  injectStyle: injectPluginStyle,
  openLayer: (pluginId) => pluginLayers.open(pluginId),
  openChannel: (pluginId, actions) => createDispatchChannel(pluginId, actions),
  subscribeDraft: (pluginId, listener) => composerDraftBridge.subscribe(pluginId, listener),
  warn: (message, error) => console.warn(message, error),
});
