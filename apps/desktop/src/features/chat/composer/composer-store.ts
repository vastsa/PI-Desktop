import { createContext, useContext } from "react";
import { useAppStore } from "../../../stores/app-store";

/** Each mounted composer reads its own session without navigating the main chat. */
export const ComposerStoreContext = createContext<typeof useAppStore | null>(null);
export function useComposerStore(): typeof useAppStore {
  return useContext(ComposerStoreContext) ?? useAppStore;
}
