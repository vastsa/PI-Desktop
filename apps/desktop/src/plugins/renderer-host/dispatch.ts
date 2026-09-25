/**
 * The outbound gate of plugin renderer code (`slot-contract.html` §3,
 * `docs/plugin-plan/render/plugin-call/`).
 *
 * Every load of a plugin gets its own channel, bound to the plugin's id and
 * to its `manifest.rendererActions`, so a component can only ever act as its
 * own plugin and only through the words it declared. `plugin.call` crosses to
 * the plugin's headless entry through the main-process relay, which owns the
 * method whitelist, the size and rate limits and the breaker;
 * `composer.insertText` never leaves the renderer and goes through the
 * composer's insert bridge. Closing the channel when its load ends refuses
 * every later dispatch and rejects the calls still in flight, so a late
 * answer never reaches the components of an unloaded plugin.
 */
import {
  PLUGIN_INSERT_TEXT_MAX_BYTES,
  PLUGIN_RENDERER_ACTIONS,
  type PluginRendererDispatch,
} from "@pi-desktop/plugin-sdk";
import { insertComposerText } from "../../features/chat/composer/insert-bridge";
import { api } from "../../lib/api";
import { PluginRendererError } from "../renderer-error";

/** Where the implemented words go. The defaults are the live app's. */
export type DispatchRoutes = {
  /** The main-process `plugin.call` relay; rejects with its coded errors. */
  pluginCall(pluginId: string, method: string, args: unknown): Promise<unknown>;
  /** Inserts at the composer caret; false when no composer is mounted. */
  insertText(text: string): boolean;
};

const appRoutes: DispatchRoutes = {
  pluginCall: (pluginId, method, args) => api.pluginRendererCall(pluginId, method, args),
  insertText: insertComposerText,
};

export type DispatchChannel = {
  /** The `pi.dispatch` of one load. */
  readonly dispatch: PluginRendererDispatch;
  /** End the load: refuse later dispatches and reject the ones in flight. */
  close(): void;
};

const utf8 = new TextEncoder();

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON reading of `args`, which is exactly what the plugin receives. */
function jsonArgs(args: unknown): unknown {
  if (args === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(args);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    throw new PluginRendererError("PLUGIN_CALL_UNSERIALIZABLE", "plugin.call args must be JSON");
  }
  return JSON.parse(text) as unknown;
}

export function createDispatchChannel(
  pluginId: string,
  declared: readonly string[],
  routes: DispatchRoutes = appRoutes,
): DispatchChannel {
  let closed = false;
  const inFlight = new Set<(error: unknown) => void>();

  const unloaded = () =>
    new PluginRendererError("PLUGIN_UNLOADED", `${pluginId} unloaded before the action settled`);

  /** Settle as `work` does, unless the channel closes first. */
  const untilClosed = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      inFlight.add(reject);
      work.then(
        (value) => {
          if (inFlight.delete(reject)) resolve(value);
        },
        (error: unknown) => {
          if (inFlight.delete(reject)) reject(error);
        },
      );
    });

  const dispatch = async (action: unknown, payload: unknown): Promise<unknown> => {
    if (closed) throw unloaded();
    if (
      typeof action !== "string" ||
      !(PLUGIN_RENDERER_ACTIONS as readonly string[]).includes(action)
    ) {
      throw new PluginRendererError("PLUGIN_ACTION_UNKNOWN", `unknown action ${describe(action)}`);
    }
    if (!declared.includes(action)) {
      throw new PluginRendererError(
        "PLUGIN_ACTION_UNDECLARED",
        `${action} is not in ${pluginId}'s manifest.rendererActions`,
      );
    }
    if (!isRecord(payload)) {
      throw new PluginRendererError(
        "PLUGIN_ACTION_INVALID_PAYLOAD",
        `${action} takes an object payload`,
      );
    }
    if (action === "plugin.call") {
      const method = payload.method;
      if (typeof method !== "string" || !method) {
        throw new PluginRendererError(
          "PLUGIN_ACTION_INVALID_PAYLOAD",
          "plugin.call requires a method name",
        );
      }
      return untilClosed(routes.pluginCall(pluginId, method, jsonArgs(payload.args)));
    }
    const text = payload.text;
    if (
      typeof text !== "string" ||
      !text ||
      utf8.encode(text).byteLength > PLUGIN_INSERT_TEXT_MAX_BYTES
    ) {
      throw new PluginRendererError(
        "PLUGIN_ACTION_INVALID_PAYLOAD",
        `composer.insertText requires non-empty text of at most ${PLUGIN_INSERT_TEXT_MAX_BYTES} UTF-8 bytes`,
      );
    }
    if (!routes.insertText(text)) {
      throw new PluginRendererError(
        "PLUGIN_ACTION_NO_COMPOSER",
        "no composer is mounted to take the text",
      );
    }
    return { ok: true };
  };

  return {
    // Plugins are untyped JavaScript, so the gate checks every argument at
    // run time; the SDK's generic signature is the documentation of it.
    dispatch: dispatch as PluginRendererDispatch,
    close() {
      if (closed) return;
      closed = true;
      const pending = [...inFlight];
      inFlight.clear();
      for (const reject of pending) reject(unloaded());
    },
  };
}
