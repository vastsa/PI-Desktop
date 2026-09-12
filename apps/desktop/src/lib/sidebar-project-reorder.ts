/** Pointer travel that arms a title drag (click vs ChatGPT-style press-and-move). */
export const PROJECT_REORDER_ARM_PX = 8;

export function projectReorderShouldArm(
  dx: number,
  dy: number,
  thresholdPx = PROJECT_REORDER_ARM_PX,
): boolean {
  return dx * dx + dy * dy > thresholdPx * thresholdPx;
}

export function projectReorderInsertAfter(
  clientY: number,
  targetTop: number,
  targetHeight: number,
): boolean {
  return clientY > targetTop + targetHeight / 2;
}

export function sameProjectReorderBucket(
  source: { archived?: boolean; pinned?: boolean },
  target: { archived?: boolean; pinned?: boolean },
): boolean {
  return (
    Boolean(source.archived) === Boolean(target.archived) &&
    Boolean(source.pinned) === Boolean(target.pinned)
  );
}

export function projectGroupKeyFromPoint(
  clientX: number,
  clientY: number,
  doc: Pick<Document, "elementFromPoint"> = document,
): { key: string; top: number; height: number } | null {
  const node = doc.elementFromPoint(clientX, clientY);
  if (!node || typeof (node as Element).closest !== "function") return null;
  const group = (node as Element).closest("[data-sidebar-project-group]");
  if (!group) return null;
  const key = group.getAttribute("data-sidebar-project-group");
  if (!key) return null;
  const rect = group.getBoundingClientRect();
  return { key, top: rect.top, height: rect.height };
}
