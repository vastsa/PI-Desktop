import type { SessionCollaborationSummary } from "@pi-desktop/shared";

const STATUS_KEYS = {
  idle: "sessionCollaboration.statusIdle",
  queued: "sessionCollaboration.statusQueued",
  running: "sessionCollaboration.statusRunning",
  waiting_permission: "sessionCollaboration.statusPermission",
  completed: "sessionCollaboration.statusCompleted",
  failed: "sessionCollaboration.statusFailed",
  cancelled: "sessionCollaboration.statusCancelled",
  interrupted: "sessionCollaboration.statusInterrupted",
} as const;

export function collaborationStatusKey(status: SessionCollaborationSummary["status"]) {
  // A host status this renderer does not know yet must not render as "undefined".
  return STATUS_KEYS[status] ?? "sessionCollaboration.statusUnknown";
}

/**
 * Only an explicit `available: false` from the host means the referenced
 * session is gone; a host that predates the field stays navigable.
 */
export function sessionReferenceAvailable(reference: { available?: boolean }): boolean {
  return reference.available !== false;
}

export function sessionPreview(value: string | undefined, limit = 300): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** A reused session must not present its previous task's report as the current result. */
export function currentCollaborationResult(summary: SessionCollaborationSummary) {
  const { currentTask, result, status } = summary;
  if (!result || status === "running" || status === "queued" || status === "waiting_permission") {
    return undefined;
  }
  if (currentTask && (
    currentTask.messageId !== result.messageId ||
    currentTask.status === "running" ||
    currentTask.status === "queued" ||
    (currentTask.turnId && currentTask.turnId !== result.turnId)
  )) return undefined;
  return result;
}

export function formatSessionTimestamp(value: string | undefined, locale?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  const absolute = (locale ?? "").toLowerCase().startsWith("zh");
  return new Intl.DateTimeFormat(locale || undefined, {
    year: "numeric",
    month: absolute ? "2-digit" : "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: !absolute,
  }).format(parsed);
}

/** Prefer the existing below/above placement; use the side for a taller overview. */
export function positionSessionHoverCard(
  anchor: { top: number; bottom: number; left: number; right: number },
  card: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const padding = 8;
  const gap = 6;
  const maxLeft = Math.max(padding, viewport.width - card.width - padding);
  const maxTop = Math.max(padding, viewport.height - card.height - padding);
  let left = Math.max(padding, Math.min(anchor.left, maxLeft));
  let top: number;
  if (anchor.bottom + gap + card.height <= viewport.height - padding) {
    top = anchor.bottom + gap;
  } else if (anchor.top - gap - card.height >= padding) {
    top = anchor.top - gap - card.height;
  } else {
    if (anchor.right + gap <= maxLeft) left = anchor.right + gap;
    top = Math.max(padding, Math.min(anchor.top, maxTop));
  }
  return { left, top };
}
