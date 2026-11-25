import type { LanCatalogChangedEvent, LanOrganizationPatch } from "@pi-desktop/shared";
import { readSidebarBackup, writeSidebarBackup } from "../sidebar-preferences";

export type LanProjectMeta = { name?: string; pinned?: boolean; archived?: boolean };
export type LanSessionMeta = { pinned?: boolean; archived?: boolean; manualTitle?: boolean };
export type LanMeta = {
  projectMeta: Record<string, LanProjectMeta>;
  sessionMeta: Record<string, LanSessionMeta>;
};
type SidebarRecord = Record<string, unknown> & {
  projectMeta: Record<string, Record<string, unknown>>;
  sessionMeta: Record<string, Record<string, unknown>>;
};

/** Same normalization as the renderer's sidebar preferences, keyed by path. */
export function normalizeProjectKey(path: string): string {
  let value = path.trim().replace(/\\/g, "/");
  if (/^\/\/\?\/[A-Za-z]:\//.test(value)) value = value.slice(4);
  value = value.replace(/(?<![A-Za-z]:)\/+$/, "");
  return value || "/";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function applyPatch(target: SidebarRecord, entry: LanOrganizationPatch): void {
  const bucket = entry.kind === "project" ? target.projectMeta : target.sessionMeta;
  const key = entry.kind === "project" ? normalizeProjectKey(entry.key) : entry.key;
  bucket[key] = { ...(isRecord(bucket[key]) ? bucket[key] : {}), ...entry.patch };
}

/**
 * Browser-originated organization edits share the Desktop sidebar backup as
 * their only durable store. The renderer mirrors whole snapshots into that
 * file, so an edit is kept "pending" and re-applied onto every renderer write
 * until the renderer acknowledges it has applied the change. IPC from one
 * renderer is ordered, so a write sent before the acknowledgement may be stale;
 * a write after it already contains the edit.
 */
export function createLanOrganization(options: {
  dataDir: string;
  notify?: (event: LanCatalogChangedEvent) => void;
}) {
  let seq = 0;
  const pending: Array<{ seq: number; entry: LanOrganizationPatch }> = [];
  const writeListeners = new Set<() => void>();
  let notify = options.notify;

  const backup = (): SidebarRecord | null => {
    let value: unknown;
    try {
      value = readSidebarBackup(options.dataDir);
    } catch {
      return null; // A damaged backup is never replaced from here.
    }
    if (!isRecord(value) || !isRecord(value.projectMeta) || !isRecord(value.sessionMeta)) return null;
    return structuredClone(value) as SidebarRecord;
  };

  const overlay = <T>(value: T): T => {
    if (!pending.length || !isRecord(value) || !isRecord(value.projectMeta) || !isRecord(value.sessionMeta)) return value;
    const next = structuredClone(value) as unknown as SidebarRecord;
    for (const { entry } of pending) applyPatch(next, entry);
    return next as unknown as T;
  };

  return {
    setNotifier(next: (event: LanCatalogChangedEvent) => void) {
      notify = next;
    },
    /** Desktop wrote its sidebar snapshot (organization may have changed). */
    onRendererWrite(listener: () => void): () => void {
      writeListeners.add(listener);
      return () => {
        writeListeners.delete(listener);
      };
    },
    rendererWrote(): void {
      for (const listener of writeListeners) listener();
    },
    read(): LanMeta {
      const base = backup() ?? { projectMeta: {}, sessionMeta: {} };
      const merged = overlay(base);
      return { projectMeta: merged.projectMeta as LanMeta["projectMeta"], sessionMeta: merged.sessionMeta as LanMeta["sessionMeta"] };
    },
    patch(entry: LanOrganizationPatch): void {
      const next = ++seq;
      pending.push({ seq: next, entry });
      const current = backup();
      if (current) {
        applyPatch(current, entry);
        writeSidebarBackup(options.dataDir, current);
      }
      notify?.({ seq: next, patches: [entry] });
    },
    /** Applied to every trusted renderer write before it reaches disk. */
    overlay,
    ack(upTo: number): void {
      while (pending.length && pending[0]!.seq <= upTo) pending.shift();
    },
    pendingCount: () => pending.length,
  };
}

export type LanOrganization = ReturnType<typeof createLanOrganization>;

const instances = new Map<string, LanOrganization>();
/** One organization owner per data directory (one Desktop install). */
export function getLanOrganization(dataDir: string): LanOrganization {
  let instance = instances.get(dataDir);
  if (!instance) {
    instance = createLanOrganization({ dataDir });
    instances.set(dataDir, instance);
  }
  return instance;
}
