import {
  assertPluginSecretKey,
  assertPluginSecretValue,
  PLUGIN_SECRETS_PERMISSION,
  type PluginSecretsApi,
} from "@pi-desktop/plugin-sdk";

/** Trusted Main-to-Host transport; never expose it to the plugin process. */
export type PluginSecretsHostCall = (
  method: "plugins.secrets.get" | "plugins.secrets.set" | "plugins.secrets.delete",
  params: Readonly<{ pluginId: string; key: string; value?: string }>,
) => Promise<unknown>;

export type PluginSecretsContext = {
  /** Derived from the loaded manifest, never from a plugin-controlled payload. */
  pluginId: string;
  /** Must check current declared AND granted permissions on every operation. */
  assertPermission: (permission: typeof PLUGIN_SECRETS_PERMISSION) => void;
  callHost: PluginSecretsHostCall;
};

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function assertWriteResult(result: unknown): void {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
    throw failure("INTERNAL", "invalid plugin secret storage response");
  }
}

/** Bind identity once; do not accept a plugin id or secret reference from callers. */
export function createPluginSecretsApi(context: PluginSecretsContext): PluginSecretsApi {
  const { pluginId, assertPermission, callHost } = context;
  if (typeof pluginId !== "string" || !pluginId || pluginId.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) {
    throw failure("INVALID_ARGUMENT", "invalid plugin identity for secret storage");
  }
  const authorize = (key: unknown): string => {
    assertPermission(PLUGIN_SECRETS_PERMISSION);
    assertPluginSecretKey(key);
    return key;
  };
  const invoke: PluginSecretsHostCall = async (method, params) => {
    try {
      return await callHost(method, params);
    } catch {
      // Transport errors can contain request payloads. Never forward them.
      throw failure("INTERNAL", "plugin secret storage operation failed");
    }
  };
  return {
    get: async (key) => {
      const result = await invoke("plugins.secrets.get", { pluginId, key: authorize(key) });
      if (!result || typeof result !== "object" || !("value" in result) ||
          (result.value !== null && typeof result.value !== "string")) {
        throw failure("INTERNAL", "invalid plugin secret storage response");
      }
      if (result.value !== null) {
        try { assertPluginSecretValue(result.value); } catch {
          throw failure("INTERNAL", "invalid plugin secret storage response");
        }
      }
      assertPermission(PLUGIN_SECRETS_PERMISSION);
      return result.value;
    },
    set: async (key, value) => {
      const checkedKey = authorize(key);
      assertPluginSecretValue(value);
      const result = await invoke("plugins.secrets.set", { pluginId, key: checkedKey, value });
      assertWriteResult(result);
    },
    delete: async (key) => {
      const result = await invoke("plugins.secrets.delete", { pluginId, key: authorize(key) });
      assertWriteResult(result);
    },
  };
}
