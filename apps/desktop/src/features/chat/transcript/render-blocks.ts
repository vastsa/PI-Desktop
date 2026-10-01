import { useLayoutEffect, useMemo, useRef } from "react";

export type RenderBlock<T> = { key: string; items: readonly T[] };
export const TRANSCRIPT_RENDER_BLOCK_SIZE = 64;

/**
 * Non-DOM reconciliation boundaries. Keep prior block membership rather than
 * rechunking from index zero: prepended history must not remount every leaf.
 * Work here is deliberately a shallow O(N) key/reference scan. Only changed
 * blocks reconstruct React children; no message text or payload is inspected.
 */
export function reconcileRenderBlocks<T>(
  previous: readonly RenderBlock<T>[] | undefined,
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly RenderBlock<T>[] {
  const membership = new Map<string, string>();
  const priorBlocks = new Map<string, RenderBlock<T>>();
  for (const block of previous ?? []) {
    priorBlocks.set(block.key, block);
    for (const item of block.items) membership.set(keyOf(item), block.key);
  }
  const result: RenderBlock<T>[] = [];
  const used = new Set<string>();
  let current: T[] = [];
  let currentKey = "";
  let owner: string | undefined;
  const flush = () => {
    if (!current.length) return;
    const prior = priorBlocks.get(currentKey);
    result.push(prior && prior.items.length === current.length &&
      prior.items.every((item, index) => item === current[index])
      ? prior : { key: currentKey, items: current });
    used.add(currentKey);
    current = [];
  };
  for (const item of items) {
    const key = keyOf(item);
    const knownOwner = membership.get(key);
    if (current.length && ((knownOwner !== undefined && knownOwner !== owner) ||
      current.length >= TRANSCRIPT_RENDER_BLOCK_SIZE)) flush();
    if (!current.length) {
      owner = knownOwner;
      currentKey = knownOwner ?? key;
      // A corrected order can split one prior block into disjoint segments.
      // Even the row-key fallback may equal a key already claimed by an earlier
      // segment (the old block's first row may now appear later). Check every
      // candidate, using deterministic encoded suffixes rather than a counter
      // shared across renders or a remount-prone index-based block key.
      for (let suffix = 1; used.has(currentKey); suffix += 1) {
        currentKey = JSON.stringify(["transcript-block", key, suffix]);
      }
    }
    current.push(item);
  }
  flush();
  return previous && previous.length === result.length && previous.every((block, index) => block === result[index])
    ? previous : result;
}

export function useRenderBlocks<T>(items: readonly T[], keyOf: (item: T) => string) {
  const committed = useRef<readonly RenderBlock<T>[] | undefined>(undefined);
  const blocks = useMemo(() => reconcileRenderBlocks(committed.current, items, keyOf), [items, keyOf]);
  // Abandoned/deferred renders must not replace the committed membership.
  useLayoutEffect(() => { committed.current = blocks; }, [blocks]);
  return blocks;
}
