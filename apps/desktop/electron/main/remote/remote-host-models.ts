/**
 * Validate the two model/usage resources a paired Host publishes before they
 * reach the renderer. A Host is a separate machine and a separate release, so
 * its payload is untrusted input at this boundary: the renderer only ever sees
 * a value that already matches the RACP shape (spec §5.2).
 */
import type {
  RacpHostModel,
  RacpHostModelCatalog,
  RacpSessionUsage,
  RacpTurnUsage,
} from "@pi-desktop/shared";

const MAX_MODELS = 2_000;
const MAX_TEXT = 256;
const MAX_LABELS = 32;
const MAX_CONTEXT_WINDOW = 10_000_000;

function invalid(): never {
  throw Object.assign(new Error("invalid remote host response"), { errorCode: "INVALID_ARGUMENT" });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) invalid();
  return value;
}

function optionalText(value: unknown, max = MAX_TEXT): string | undefined {
  return value === undefined || value === null ? undefined : text(value, max);
}

/** A token count is a non-negative integer; anything else is not a measurement. */
function count(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function contextWindow(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_CONTEXT_WINDOW) invalid();
  return value;
}

function labels(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LABELS) invalid();
  return value.map((entry) => text(entry, 64));
}

function model(value: unknown): RacpHostModel {
  const row = record(value);
  const providerId = text(row.providerId);
  const modelId = text(row.modelId);
  const displayName = optionalText(row.displayName, 200);
  const providerName = optionalText(row.providerName, 200);
  const window = contextWindow(row.contextWindow);
  const capabilities = labels(row.capabilities);
  const thinking = labels(row.supportedThinkingLevels);
  if (row.fastMode !== undefined && typeof row.fastMode !== "boolean") invalid();
  return {
    providerId,
    providerName: providerName ?? providerId,
    modelId,
    displayName: displayName ?? modelId,
    ...(window ? { contextWindow: window } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(thinking ? { supportedThinkingLevels: thinking } : {}),
    ...(row.fastMode === true ? { fastMode: true } : {}),
  };
}

/** Normalize an untrusted `models/list` payload into the RACP catalog shape. */
export function validateModelCatalog(value: unknown): RacpHostModelCatalog {
  const result = record(value);
  if (!Array.isArray(result.models) || result.models.length > MAX_MODELS) invalid();
  const defaultProviderId = optionalText(result.defaultProviderId);
  const defaultModelId = optionalText(result.defaultModelId);
  return {
    models: result.models.map(model),
    ...(defaultProviderId ? { defaultProviderId } : {}),
    ...(defaultModelId ? { defaultModelId } : {}),
  };
}

function turnUsage(value: unknown): RacpTurnUsage {
  const usage = record(value);
  const inputTokens = count(usage.inputTokens) ?? 0;
  const outputTokens = count(usage.outputTokens) ?? 0;
  const cacheReadTokens = count(usage.cacheReadTokens);
  const cacheWriteTokens = count(usage.cacheWriteTokens);
  const reasoningTokens = count(usage.reasoningTokens);
  const totalTokens = count(usage.totalTokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    totalTokens,
  };
}

/** Normalize an untrusted `session/usage` payload into the RACP usage shape. */
export function validateSessionUsage(value: unknown): RacpSessionUsage {
  const result = record(value);
  const used = result.usage === undefined || result.usage === null ? undefined : turnUsage(result.usage);
  const providerId = optionalText(result.providerId);
  const modelId = optionalText(result.modelId);
  const window = contextWindow(result.contextWindow);
  const updatedAt = optionalText(result.updatedAt, 64);
  return {
    ...(used ? { usage: used } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(window ? { contextWindow: window } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}