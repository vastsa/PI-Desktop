/** Explicit permission required for every plugin secret operation. */
export const PLUGIN_SECRETS_PERMISSION = "secrets.store" as const;
export const MAX_PLUGIN_SECRET_KEY_LENGTH = 128;
/** Maximum UTF-8 encoded value size, including non-ASCII characters. */
export const MAX_PLUGIN_SECRET_VALUE_BYTES = 64 * 1024;

/**
 * Host-owned encrypted storage scoped to the calling plugin's installed id.
 * Declare `secrets.store` in the manifest; every operation requires its grant.
 * Keys are 1..128 ASCII characters: an alphanumeric followed by alphanumerics,
 * dots, underscores or hyphens. Values are strings of at most 64 KiB in UTF-8.
 * Empty values are supported. Missing keys return null; deletion is idempotent.
 * No plugin id, provider id, file path or host secret reference is accepted.
 */
export type PluginSecretsApi = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

/** Validate untrusted keys without including their contents in errors. */
export function assertPluginSecretKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length > MAX_PLUGIN_SECRET_KEY_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw invalid("secret key must be 1..128 ASCII alphanumeric, dot, underscore or hyphen characters and start with an alphanumeric");
  }
}

/** Validate UTF-8 byte bounds before a value crosses the host boundary. */
export function assertPluginSecretValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_PLUGIN_SECRET_VALUE_BYTES ||
      new TextEncoder().encode(value).byteLength > MAX_PLUGIN_SECRET_VALUE_BYTES) {
    throw invalid("secret value must be a string of at most 65536 UTF-8 bytes");
  }
}
