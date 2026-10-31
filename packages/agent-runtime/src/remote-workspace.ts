import { posix } from "node:path";

/** Bookkeeping only; the remote Host canonicalizes and authorizes actual paths. */
export function remoteMutationIdentity(workspace: { hostKey: string; path: string }, path: string): string {
  return JSON.stringify([workspace.hostKey, posix.resolve(workspace.path, path)]);
}
