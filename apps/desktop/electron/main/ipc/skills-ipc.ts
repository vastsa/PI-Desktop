import { dialog, shell } from "electron";
import { IPC, type ActivationScope, type AgentCapabilityQuery, type UserSkillRecord, type UserSubagentRecord } from "@pi-desktop/shared";
import { loadSubagentDefinitions, type UserSubagentDocument } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type SkillsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  optionalWorkspaceRoot: () => Promise<string | null>;
  activeUserSubagentDocuments: (projectPath: string | undefined) => Promise<UserSubagentDocument[]>;
  stripWinLongPrefix: (path: string) => string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
};

/** Register user-owned skill and subagent definition channels. */
export function registerSkillsIpc({
  registrar,
  getHost,
  optionalWorkspaceRoot,
  activeUserSubagentDocuments,
  stripWinLongPrefix,
  sendToRenderer,
}: SkillsIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };
// --- Skills the user owns -------------------------------------------------

  handle(IPC.invoke.skillList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("skills.list", query);
  });

  handle(IPC.invoke.skillCreate, async (skill: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("skills.create", { skill });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  /** Import exactly one markdown file into the selected capability directory. */
  handle(IPC.invoke.skillImport, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    const picked = await dialog.showOpenDialog({
      title: "Import skill",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const res = await host.call("skills.import", {
      path: picked.filePaths[0],
      ...query,
    });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  handle(
    IPC.invoke.skillUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...skill } = payload;
      const res = await host.call("skills.update", { id, skill });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillRead,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      return host.call("skills.read", request);
    },
  );

  handle(
    IPC.invoke.skillRemove,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call("skills.remove", request);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  /**
   * Show a skill document in the OS file manager. The level and project travel
   * with the id because `skills.read` falls back to the global directory when
   * they are absent, which never resolves a project-only document.
   */
  handle(
    IPC.invoke.skillReveal,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call<{ skill: UserSkillRecord | null }>("skills.read", request);
      const path = res.skill?.path;
      if (!path) throw new Error("skill not found");
      shell.showItemInFolder(stripWinLongPrefix(path));
      return { ok: true };
    },
  );

  // --- Subagents the user owns ----------------------------------------------

  handle(IPC.invoke.subagentList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.list");
  });

  /**
   * The effective catalog: what `Task` would actually offer right now, merged
   * across builtin, registry and project documents. The renderer needs this to
   * show read-only rows and to name the definition that wins each handle.
   */
  handle(IPC.invoke.subagentCatalog, async () => {
    const projectPath = (await optionalWorkspaceRoot()) ?? undefined;
    const { definitions, diagnostics } = await loadSubagentDefinitions(
      projectPath,
      { userDocuments: await activeUserSubagentDocuments(projectPath) },
    );
    return { subagents: definitions, diagnostics, projectPath: projectPath ?? null };
  });

  handle(IPC.invoke.subagentCreate, async (subagent: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.create", { subagent });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...subagent } = payload;
      const res = await host.call("agents.update", { id, subagent });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(IPC.invoke.subagentRead, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.read", { id });
  });

  handle(IPC.invoke.subagentRemove, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.remove", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentSetEnabled,
    async (payload: { id: string; enabled: boolean }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(
    IPC.invoke.subagentSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  /**
   * Show a definition document in the OS file manager. The path always comes
   * from the host registry: a renderer-supplied path is never handed to the
   * shell, so this channel cannot be used to reveal arbitrary locations.
   */
  handle(IPC.invoke.subagentReveal, async (payload: { id?: string; path?: string }) => {
    if (!host) throw new Error("host unavailable");
    if (!payload.id) throw new Error("subagent id required");
    const res = await host.call<{ subagent: UserSubagentRecord | null }>(
      "agents.read",
      { id: payload.id },
    );
    const path = res.subagent?.path;
    if (!path) throw new Error("subagent not found");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { ok: true };
  });

}
