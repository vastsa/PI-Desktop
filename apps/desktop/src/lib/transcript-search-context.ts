import { createContext } from "react";
import type { TranscriptSearchTarget } from "./transcript-reading";

export const TranscriptSearchContext = createContext<TranscriptSearchTarget | null>(null);
