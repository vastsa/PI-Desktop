export type ReorderPlacement = "before" | "after";

export type DropTarget = { id: string; placement: ReorderPlacement };

/** Upper half including the midpoint inserts before; below the midpoint inserts after. */
export function dropPlacement(
  clientY: number,
  targetTop: number,
  targetHeight: number,
): ReorderPlacement {
  return clientY > targetTop + targetHeight / 2 ? "after" : "before";
}

/** Adjacent *visible* row for ArrowUp / ArrowDown; hidden filter matches stay put. */
export function visibleNeighborMove<T extends { id: string }>(
  visible: readonly T[],
  id: string,
  direction: "up" | "down",
): { targetId: string; placement: ReorderPlacement } | null {
  const index = visible.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const target = visible[index + (direction === "down" ? 1 : -1)];
  if (!target) return null;
  return {
    targetId: target.id,
    placement: direction === "down" ? "after" : "before",
  };
}

export function sameDropTarget(
  current: DropTarget | null,
  next: DropTarget | null,
): boolean {
  return current?.id === next?.id && current?.placement === next?.placement;
}

/** Move one item without rebuilding it or dropping items hidden by a filter. */
export function reorderItem<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
  placement: ReorderPlacement,
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;

  const insertionIndex =
    targetIndex + (placement === "after" ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0);
  if (insertionIndex === sourceIndex) return items;
  const next = [...items];
  const [item] = next.splice(sourceIndex, 1);
  next.splice(insertionIndex, 0, item);
  return next;
}
