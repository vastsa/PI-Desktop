/** Renderer-only: not a host setting or an exact tokenizer budget. */
const STORAGE_KEY = "pi-desktop:session-reference-budget-percent";

export function normalizeSessionReferenceBudgetPercent(value: unknown): number {
  return value === 10 || value === 25 || value === 50 || value === 100 ? value : 25;
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

export function getSessionReferenceBudgetPercent(): number {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return normalizeSessionReferenceBudgetPercent(value == null ? undefined : Number(value));
  } catch {
    return 25;
  }
}

export function setSessionReferenceBudgetPercent(value: number): void {
  try {
    storage()?.setItem(STORAGE_KEY, String(normalizeSessionReferenceBudgetPercent(value)));
  } catch {
    // Blocked or full storage must not prevent composing or changing settings.
  }
}
