import type { ConfigSyncCategorySelection, ConfigSyncConfigureInput, ConfigSyncConnection, ConfigSyncMode, ConfigSyncState, ConfigSyncTestInput } from "@pi-desktop/shared";
import type { ConfigSyncDraft } from "./config-sync-preferences";

/** Transient form memory only. Never serialize this object directly. */
export type ConfigSyncForm = ConfigSyncConnection & {
  mode: ConfigSyncMode;
  automaticSync: boolean;
  deviceLabel: string;
  secretAccessKey: string;
  sessionToken: string;
  clearSessionToken: boolean;
  backupPassword: string;
  currentBackupPassword: string;
  newBackupPassword: string;
};

export function selectionFromDraft(categories?: Partial<ConfigSyncCategorySelection>): ConfigSyncCategorySelection {
  const selection: ConfigSyncCategorySelection = {
    application: true, providers: true, credentials: false, mcp: true,
    skills: true, subagents: true, instructions: true,
    plugins: true, automation: true, memory: false,
  };
  // Project selection from older drafts is no longer part of the portable contract.
  for (const key of Object.keys(selection) as Array<keyof ConfigSyncCategorySelection>) {
    if (typeof categories?.[key] === "boolean") selection[key] = categories[key];
  }
  return selection;
}

export function initialConfigSyncForm(draft: ConfigSyncDraft = {}): ConfigSyncForm {
  return {
    endpoint: draft.endpoint ?? "",
    region: draft.region ?? "us-east-1",
    bucket: draft.bucket ?? "",
    prefix: draft.prefix ?? "pi-desktop/config",
    accessKeyId: draft.accessKeyId ?? "",
    pathStyle: draft.pathStyle ?? true,
    mode: draft.mode ?? "sync",
    automaticSync: draft.automaticSync ?? true,
    deviceLabel: draft.deviceLabel ?? "",
    secretAccessKey: "", sessionToken: "", clearSessionToken: false,
    backupPassword: "", currentBackupPassword: "", newBackupPassword: "",
  };
}

export function draftFromState(next: ConfigSyncState): ConfigSyncDraft {
  return {
    endpoint: next.endpoint, region: next.region, bucket: next.bucket,
    prefix: next.prefix, accessKeyId: next.accessKeyId, pathStyle: next.pathStyle,
    mode: next.mode, automaticSync: next.automaticSync, deviceLabel: next.deviceLabel,
    categories: selectionFromDraft({ ...next.categories, credentials: next.includeSecrets, memory: next.includeMemory }),
    saved: true,
  };
}

export function draftFromForm(form: ConfigSyncForm, categories: ConfigSyncCategorySelection): ConfigSyncDraft {
  return {
    endpoint: form.endpoint, region: form.region, bucket: form.bucket,
    prefix: form.prefix, accessKeyId: form.accessKeyId, pathStyle: form.pathStyle,
    mode: form.mode, automaticSync: form.automaticSync, deviceLabel: form.deviceLabel,
    categories: selectionFromDraft(categories), saved: false,
  };
}

/** One request projection for connection tests and saves. Secrets stay byte-exact. */
export function configSyncTestInput(form: ConfigSyncForm, categories: ConfigSyncCategorySelection, defaultDevice: string): ConfigSyncTestInput {
  return {
    endpoint: form.endpoint.trim(), region: form.region.trim(), bucket: form.bucket.trim(),
    prefix: form.prefix.trim(), accessKeyId: form.accessKeyId.trim(), pathStyle: form.pathStyle,
    mode: form.mode, automaticSync: form.automaticSync,
    deviceLabel: form.deviceLabel.trim() || defaultDevice,
    secretAccessKey: form.secretAccessKey || undefined,
    // A complete replacement must not accidentally reuse an old temporary token.
    sessionToken: form.clearSessionToken ? "" : form.sessionToken || (form.secretAccessKey ? "" : undefined),
    categories: selectionFromDraft(categories), includeSecrets: categories.credentials, includeMemory: categories.memory,
  };
}

export function configSyncConfigureInput(form: ConfigSyncForm, categories: ConfigSyncCategorySelection, defaultDevice: string): ConfigSyncConfigureInput {
  return { ...configSyncTestInput(form, categories, defaultDevice), backupPassword: form.backupPassword };
}

export function clearConfigSyncFormSecrets(form: ConfigSyncForm): ConfigSyncForm {
  return { ...form, secretAccessKey: "", sessionToken: "", clearSessionToken: false,
    backupPassword: "", currentBackupPassword: "", newBackupPassword: "" };
}
