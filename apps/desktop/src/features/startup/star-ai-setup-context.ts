import { createContext } from "react";
import type { StarAiCatalog } from "@pi-desktop/shared";

// The account window already fetched the directory. Seed this one visit to
// model settings so its picker opens with the result of that same sign-in.
export const StarAiSetupCatalog = createContext<StarAiCatalog | null>(null);
