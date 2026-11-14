import { create } from "zustand";

/** Only unrelated application services are replaced; mode IPC/store wiring stays real. */
export const goalLayoutServices = { toasts: [] as string[], sessionRefreshes: 0 };

export const useAppStore = create(() => ({
  showToast: (message: string) => { goalLayoutServices.toasts.push(message); },
  refreshSessions: async () => { goalLayoutServices.sessionRefreshes += 1; },
}));
