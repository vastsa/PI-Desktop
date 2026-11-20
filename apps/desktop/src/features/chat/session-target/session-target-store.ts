import type { RemoteSessionTarget } from "@pi-desktop/shared";
import type { RemoteProjectTarget } from "../../../lib/remote-project-session";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type Repository = RemoteSessionTarget["repository"] & { defaultBranch: string };
export type DraftSessionTarget = {
  environmentId: string;
  repository?: Repository;
  baseBranch?: string;
  defaultEnvironmentId?: string;
  remoteProject?: RemoteProjectTarget;
  folderProject?: { path: string; hostKey: string };
};
type TargetStore = DraftSessionTarget & {
  setEnvironment(id: string, hostKey?: string): void;
  setRepository(repository?: Repository): void;
  setBaseBranch(branch: string): void;
  beginDraft(target?: DraftSessionTarget): void;
};

export const useSessionTargetStore = create<TargetStore>()(persist((set) => ({
  environmentId: "local",
  setEnvironment: (environmentId, hostKey) => set((current) => ({
    environmentId,
    ...(hostKey ? {
      defaultEnvironmentId: `default:${hostKey}`,
      folderProject: current.folderProject?.hostKey === hostKey ? current.folderProject : undefined,
      remoteProject: current.remoteProject?.hostKey === hostKey ? current.remoteProject : undefined,
    } : {}),
  })),
  setRepository: (repository) => set({ repository, baseBranch: repository?.defaultBranch }),
  setBaseBranch: (baseBranch) => set({ baseBranch }),
  beginDraft: (target = { environmentId: "local" }) => set({
    environmentId: target.environmentId,
    repository: target.repository,
    baseBranch: target.baseBranch ?? target.repository?.defaultBranch,
    defaultEnvironmentId: target.defaultEnvironmentId,
    remoteProject: target.remoteProject,
    folderProject: target.folderProject,
  }),
}), { name: "pi-desktop.sessionTarget.v1", partialize: ({ environmentId, repository, baseBranch }) => ({ environmentId, repository, baseBranch }) }));
