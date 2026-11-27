import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/** One matching line of a project file, as the search dialog renders it. */
export type ProjectTextMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};

export type ProjectTextSearchResult = {
  /** Traversal engine that produced the rows, for diagnostics. */
  engine: string;
  /** One page of match rows, starting at `offset`. */
  matches: ProjectTextMatch[];
  /** Every match the scan found, not just this page. */
  total: number;
  /** Files holding at least one match. */
  fileCount: number;
  offset: number;
  nextOffset: number | null;
  scannedFiles: number;
  elapsedMs: number;
  /** True when the page came from the cached scan instead of a new walk. */
  cached: boolean;
};

export type ProjectTextSearchInput = {
  root: string;
  query: string;
  caseSensitive?: boolean;
  offset?: number;
  limit?: number;
};

export type FileSearchIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

/**
 * Global search dialog "Files" tab: project content search.
 *
 * The renderer must not touch the filesystem, so the channel only forwards the
 * request to host-core, which walks with ripgrep's `ignore` engine and applies
 * the private-key / `.env` denylist before anything reaches the window.
 *
 * The scan is complete; `offset` / `limit` only bound one IPC frame, so the
 * dialog can page through a result set far larger than a single message.
 */
export function registerFileSearchIpc({
  registrar,
  getHost,
}: FileSearchIpcDependencies): void {
  registrar.handle(
    IPC.invoke.filesSearchText,
    async (input: ProjectTextSearchInput): Promise<ProjectTextSearchResult> => {
      const root = typeof input?.root === "string" ? input.root : "";
      const query = typeof input?.query === "string" ? input.query : "";
      if (!root || !query.trim()) {
        throw new Error("root and query are required");
      }
      const host = getHost();
      if (!host) throw new Error("host is not ready");
      const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset ?? 0)) : 0;
      const limit = Number.isFinite(input.limit) ? Math.floor(input.limit ?? 0) : 0;
      return host.call<ProjectTextSearchResult>("files.searchText", {
        root,
        query,
        caseSensitive: input.caseSensitive === true,
        offset,
        ...(limit > 0 ? { limit } : {}),
      });
    },
  );
}
