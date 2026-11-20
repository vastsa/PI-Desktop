import type { RemoteSessionTarget } from "@pi-desktop/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type Repository = RemoteSessionTarget["repository"] & { defaultBranch: string };
type Selection = {
  environmentId: string;
  repository?: Repository;
  baseBranch?: string;
};
type TargetStore = Selection & {
  setEnvironment(id: string): void;
  setRepository(repository?: Repository): void;
  setBaseBranch(branch: string): void;
  preselect(environmentId: string, repository: Repository): void;
};

export const useSessionTargetStore = create<TargetStore>()(persist((set) => ({
  environmentId: "local",
  setEnvironment: (environmentId) => set({ environmentId }),
  setRepository: (repository) => set({ repository, baseBranch: repository?.defaultBranch }),
  setBaseBranch: (baseBranch) => set({ baseBranch }),
  preselect: (environmentId, repository) => set({ environmentId, repository, baseBranch: repository.defaultBranch }),
}), { name: "pi-desktop.sessionTarget.v1", partialize: ({ environmentId, repository, baseBranch }) => ({ environmentId, repository, baseBranch }) }));
