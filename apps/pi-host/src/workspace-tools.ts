import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { RacpError } from "@pi-desktop/agent-host";
import { isCommandShellCatalog, type CommandShellCatalog, type WorkspaceToolExecute, type WorkspaceToolResult } from "@pi-desktop/shared";
import type { HostRpc } from "@pi-desktop/host-runtime";
import type { RacpHostOperations } from "@pi-desktop/racp";

type Owner = { deviceId: string; connectionId: string };
type Active = { owner: Owner; host: HostRpc; sessionId: string; toolCallId: string; cancelled: boolean };
const TOOLS = new Set(["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
const MAX_ACTIVE = 32;
const MAX_SEEN = 4096;
const MAX_BYTES = 1024 * 1024;

/** Tool-only owner service. No provider, session or project persistence is needed. */
export function createWorkspaceTools(getHost: () => HostRpc | null): NonNullable<RacpHostOperations["workspaceTools"]> {
  const active = new Map<string, Active>();
  const seen = new Set<string>();
  const id = (owner: Owner, sessionId: string) => createHash("sha256").update(JSON.stringify([owner.deviceId, sessionId])).digest("hex");
  const key = (owner: Owner, sessionId: string, toolCallId: string) => JSON.stringify([owner.deviceId, sessionId, toolCallId]);
  const unavailable = () => new RacpError("AGENT_UNAVAILABLE", "workspace tool Host is unavailable");
  const abortEntry = async (entry: Active) => {
    entry.cancelled = true;
    await entry.host.call("tools.workspaceAbort", { sessionId: entry.sessionId, toolCallId: entry.toolCallId });
  };
  return {
    async execute(input: WorkspaceToolExecute, owner: Owner): Promise<WorkspaceToolResult> {
      if (!owner.deviceId || !TOOLS.has(input.toolName) || !isAbsolute(input.path) || /[\u0000-\u001f]/.test(input.path)
        || Buffer.byteLength(JSON.stringify(input.args)) > MAX_BYTES) throw new RacpError("INVALID_ARGUMENT", "invalid workspace tool request");
      const requestKey = key(owner, input.sessionId, input.toolCallId);
      if (active.has(requestKey) || seen.has(requestKey)) throw new RacpError("CONFLICT", "workspace tool execution cannot be replayed");
      if (active.size >= MAX_ACTIVE) throw new RacpError("CONFLICT", "workspace tool execution capacity is exhausted");
      const host = getHost();
      if (!host) throw unavailable();
      const entry: Active = { owner, host, sessionId: id(owner, input.sessionId), toolCallId: input.toolCallId, cancelled: false };
      seen.add(requestKey);
      while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
      active.set(requestKey, entry);
      try {
        const path = await realpath(input.path).catch(() => undefined);
        if (!path || !(await stat(path)).isDirectory()) throw new RacpError("REMOTE_PATH_NOT_FOUND", "workspace directory is unavailable");
        if (entry.cancelled || getHost() !== host) throw unavailable();
        const result = await host.call<WorkspaceToolResult>("tools.workspaceExecute", {
          ...input, path, sessionId: entry.sessionId,
        });
        if (entry.cancelled || getHost() !== host) throw unavailable();
        if (!result || typeof result.ok !== "boolean" || !Object.hasOwn(result, "content")
          || Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new RacpError("INTERNAL", "invalid workspace tool response");
        return { ...result, toolCallId: input.toolCallId };
      } finally {
        if (active.get(requestKey) === entry) active.delete(requestKey);
      }
    },
    async abort(input, owner) {
      const entry = active.get(key(owner, input.sessionId, input.toolCallId));
      if (entry) await abortEntry(entry);
    },
    async shell() {
      const host = getHost();
      if (!host) throw unavailable();
      const catalog = await host.call<CommandShellCatalog>("commandShells.list", {});
      if (getHost() !== host) throw unavailable();
      if (!isCommandShellCatalog(catalog) || !catalog.effective?.available) throw new RacpError("CAPABILITY_UNAVAILABLE", "workspace command shell is unavailable");
      return catalog.effective;
    },
    async disconnect(connectionId) {
      await Promise.all([...active.values()].filter(entry => entry.owner.connectionId === connectionId).map(abortEntry));
    },
  };
}
