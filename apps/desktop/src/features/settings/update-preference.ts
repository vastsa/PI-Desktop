import type { AppSettings, UpdatePreference } from "@pi-desktop/shared";

export function isUpdatePreference(value: unknown): value is UpdatePreference {
  return value === "automatic" || value === "manual";
}

export async function persistUpdatePreference(
  value: string,
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>,
): Promise<boolean> {
  if (!isUpdatePreference(value)) return false;
  await saveSettings({ updatePreference: value });
  return true;
}
