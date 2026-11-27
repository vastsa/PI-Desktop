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
  matches: ProjectTextMatch[];
  truncated: boolean;
  scannedFiles: number;
  elapsedMs: number;
};

export type ProjectTextSearchInput = {
  root: string;
  query: string;
  caseSensitive?: boolean;
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
      return host.call<ProjectTextSearchResult>("files.searchText", {
        root,
        query,
        caseSensitive: input.caseSensitive === true,
      });
    },
  );
}
