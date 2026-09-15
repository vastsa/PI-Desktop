/** Move one binding without rebuilding it or dropping models hidden by a filter. */
export function reorderModel<T extends { id: string }>(
  models: T[],
  sourceId: string,
  targetId: string,
  placement: "before" | "after",
): T[] {
  const sourceIndex = models.findIndex((model) => model.id === sourceId);
  const targetIndex = models.findIndex((model) => model.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return models;

  const insertionIndex =
    targetIndex + (placement === "after" ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0);
  if (insertionIndex === sourceIndex) return models;
  const next = [...models];
  const [binding] = next.splice(sourceIndex, 1);
  next.splice(insertionIndex, 0, binding);
  return next;
}
