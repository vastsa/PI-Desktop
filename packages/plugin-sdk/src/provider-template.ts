import type { PluginProviderContrib, PluginProviderOAuthContrib } from "./index.js";

/** Public-client protocols executed by the Host, never by plugin code. */
export type PluginProviderTemplateOAuthV1 = PluginProviderOAuthContrib & {
  /** Omission retains the legacy onProviderOAuth callback contract. */
  flow?: "custom" | "authorization_code" | "device_code";
  clientId?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  deviceAuthorizationUrl?: string;
  scopes?: string[];
  /** Loopback callback pathname; defaults to /callback. */
  redirectPath?: string;
};

export type PluginProviderTemplateV1 = Omit<PluginProviderContrib, "oauth"> & {
  version: 1;
  oauth?: PluginProviderTemplateOAuthV1;
};

/** Persistence/reconciliation projection; declarative OAuth stays in the manifest. */
export type NormalizedPluginProviderTemplate = PluginProviderContrib;

export function normalizeProviderTemplate(template: PluginProviderTemplateV1): NormalizedPluginProviderTemplate {
  const { version: _version, oauth, ...provider } = template;
  return {
    ...provider,
    ...(oauth === undefined ? {} : { oauth: {
      ...(oauth.loginLabel === undefined ? {} : { loginLabel: oauth.loginLabel }),
      ...(oauth.isSubscription === undefined ? {} : { isSubscription: oauth.isSubscription }),
    } }),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

// JS length counts UTF-16 code units, matching the Host's encode_utf16 bounds.
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function localized(value: unknown, max: number): boolean {
  return object(value)
    ? closed(value, ["en", "zh-CN"]) && text(value.en, max) && text(value["zh-CN"], max)
    : text(value, max);
}
function transportUrl(value: unknown): value is string {
  if (!text(value, 2048) || !/^https?:\/\/[^/?#@]+(?:[/?]|$)/i.test(value) || /[\s\\#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Syntax only: the Host must additionally enforce outbound DNS/proxy policy. */
export function isProviderTemplateHttpsUrl(value: unknown): value is string {
  return transportUrl(value) && /^https:\/\//i.test(value);
}

/** Closed OAuth schema, shared by manifest parsing and the Host engine. No secrets are echoed. */
export function validateProviderTemplateOAuth(value: unknown): string | undefined {
  if (!object(value) || !closed(value, ["loginLabel", "isSubscription", "flow", "clientId", "authorizationUrl", "tokenUrl", "deviceAuthorizationUrl", "scopes", "redirectPath"])) {
    return "provider template oauth contains unsupported fields or is not an object";
  }
  if (value.loginLabel !== undefined && !text(value.loginLabel, 128)) return "invalid oauth.loginLabel";
  if (value.isSubscription !== undefined && typeof value.isSubscription !== "boolean") return "invalid oauth.isSubscription";
  const flow = value.flow === undefined ? "custom" : value.flow;
  if (typeof flow !== "string" || !["custom", "authorization_code", "device_code"].includes(flow)) return "invalid oauth.flow";
  if (flow === "custom") {
    return Object.keys(value).some(key => !["loginLabel", "isSubscription", "flow"].includes(key)) ? "custom OAuth does not accept declarative fields" : undefined;
  }
  if (!text(value.clientId, 512)) return "invalid oauth.clientId";
  if (!isProviderTemplateHttpsUrl(value.tokenUrl)) return "invalid oauth.tokenUrl";
  if (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.length > 64 || new Set(value.scopes).size !== value.scopes.length || value.scopes.some(scope => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope)))) return "invalid oauth.scopes";
  if (flow === "authorization_code") {
    if (!isProviderTemplateHttpsUrl(value.authorizationUrl)) return "invalid oauth.authorizationUrl";
    if (value.deviceAuthorizationUrl !== undefined) return "authorization_code does not accept deviceAuthorizationUrl";
    if (value.redirectPath !== undefined && (typeof value.redirectPath !== "string" || value.redirectPath.length > 256 || !/^\/[A-Za-z0-9/_-]*$/.test(value.redirectPath) || value.redirectPath.startsWith("//"))) return "invalid oauth.redirectPath";
  } else {
    if (!isProviderTemplateHttpsUrl(value.deviceAuthorizationUrl)) return "invalid oauth.deviceAuthorizationUrl";
    if (value.authorizationUrl !== undefined || value.redirectPath !== undefined) return "device_code does not accept authorizationUrl or redirectPath";
  }
  return undefined;
}

/** Closed/versioned bounds before the shared provider/adapter contract checks. */
export function validateProviderTemplateSchema(value: unknown): string | undefined {
  if (!object(value) || value.version !== 1 || !closed(value, ["version", "id", "name", "category", "description", "vendorKey", "baseUrl", "apiStyle", "authKind", "oauth", "adapter", "models"])) return "provider template must use version 1 and supported fields only";
  if (!text(value.name, 128)) return "invalid provider template name";
  if (value.vendorKey !== undefined && !text(value.vendorKey, 128)) return "invalid provider template vendorKey";
  for (const [field, max] of [["category", 128], ["description", 280]] as const) {
    if (value[field] !== undefined && !localized(value[field], max)) return `invalid provider template ${field}`;
  }
  if (value.baseUrl !== undefined && !transportUrl(value.baseUrl)) return "invalid provider template baseUrl";
  if (!Array.isArray(value.models) || value.models.length > 64) return "invalid provider template model count";
  for (const model of value.models) {
    if (!object(model) || !closed(model, ["id", "name", "contextWindow", "maxTokens", "supportsImages", "thinkingLevels", "defaultThinkingLevel", "operations"])) return "provider template models must contain supported fields only";
    if (!text(model.id, 256)) return "invalid provider template model id";
    if (model.name !== undefined && !text(model.name, 128)) return "invalid provider template model name";
    if (model.defaultThinkingLevel !== undefined && !text(model.defaultThinkingLevel, 64)) return "invalid provider template defaultThinkingLevel";
    if (model.thinkingLevels !== undefined && (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.length > 16 || model.thinkingLevels.some(level => !text(level, 64)))) return "invalid provider template thinkingLevels";
    for (const field of ["contextWindow", "maxTokens"]) {
      const limit = model[field];
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 0xffffffff)) return "provider template model limits must be positive uint32 integers";
    }
  }
  if (value.oauth !== undefined) return value.authKind !== "oauth" ? "provider template oauth requires authKind oauth" : validateProviderTemplateOAuth(value.oauth);
  return undefined;
}
