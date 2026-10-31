import type { ClientIdentity } from "@earendil-works/pi-ai";

/** Preserve pi-ai's detailed User-Agent without opting requests into pi attribution headers. */
export const DESKTOP_AGENT_IDENTITY: ClientIdentity = { attribution: null };
