/**
 * How a hand-typed model id becomes a binding, and how a late catalog answer
 * reaches it.
 *
 * One typed id has three sources, in order: the rows the current discovery
 * already returned, the local models.dev snapshot (through the host), and the
 * generic seed. The snapshot lookup is asynchronous, so the row has to land
 * first and be upgraded later — and only while it is still the untouched seed,
 * or an answer that arrives after the user edited or removed the row would
 * overwrite their action. Keeping that ordering here means it is asserted once,
 * for the component and for the tests, instead of only existing inline.
 */
import {
  bindingForCustomModel,
  bindingForCustomModelInfo,
  bindingFromModelInfo,
  type ModelBinding,
  type ModelInfo,
} from "@pi-desktop/shared";

/** What one entry can tell the host about where a typed id belongs. */
export type CustomModelLookupContext = {
  providerId?: string;
  vendorKey?: string;
  baseUrl?: string;
};

/** Lookup input for one id, carrying only the context the entry actually has. */
export type CustomModelLookupInput = {
  modelId: string;
  providerId?: string;
  vendorKey?: string;
  baseUrl?: string;
};

/**
 * The binding a hand-typed id starts from: the discovered row's published
 * record when the service already returned this id, the generic seed otherwise.
 *
 * A row from the current discovery already passed through models.dev, so using
 * it is both more accurate and cheaper than asking again.
 */
export function customModelSeedBinding(
  id: string,
  discovered?: ModelInfo | null,
): ModelBinding {
  return discovered ? bindingFromModelInfo(discovered) : bindingForCustomModel(id);
}

/** Lookup input for one id, omitting fields this entry cannot supply. */
export function customModelLookupInput(
  id: string,
  context: CustomModelLookupContext = {},
): CustomModelLookupInput {
  const input: CustomModelLookupInput = { modelId: id };
  if (context.providerId) input.providerId = context.providerId;
  if (context.vendorKey) input.vendorKey = context.vendorKey;
  if (context.baseUrl) input.baseUrl = context.baseUrl;
  return input;
}

/**
 * Apply a snapshot answer to the binding list.
 *
 * A miss (`null`) keeps the seed, so a failed or unpublished lookup is just the
 * old behavior. A hit replaces the row the lookup was asked about, and only
 * while that row still equals the seed: an edit, a removal, or a re-add then
 * edit leaves the stored answer alone.
 */
export function applyCustomModelLookup(
  current: ModelBinding[],
  seed: ModelBinding,
  info: ModelInfo | null,
): ModelBinding[] {
  if (!info) return current;
  let changed = false;
  const next = current.map((binding) => {
    if (binding.id !== seed.id || !isUntouchedSeed(binding, seed)) return binding;
    changed = true;
    // The stored id stays exactly what the user typed; the catalog spelling is
    // metadata, not the string the provider is addressed with.
    return bindingForCustomModelInfo(seed.id, info);
  });
  return changed ? next : current;
}

function isUntouchedSeed(binding: ModelBinding, seed: ModelBinding): boolean {
  return JSON.stringify(binding) === JSON.stringify(seed);
}
