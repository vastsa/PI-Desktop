import { IPC, parseMcpImport, type ActivationScope, type AgentCapabilityQuery, type McpServerInput, type McpServerRecord, type McpServerStatus } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { McpRegistrySearchResult } from "../mcp-registry-catalog";
import type { UserMcpRuntime } from "../user-mcp";
import type { IpcRegistrar } from "./types";

export type McpIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  userMcp: UserMcpRuntime;
  currentWorkspacePath: () => string | null;
  refreshUserMcp: (projectPath?: string | null) => Promise<McpServerRecord[]>;
  describeError: (error: unknown) => string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  searchMcpRegistry: (query: string) => Promise<McpRegistrySearchResult>;
};

/** Register user-owned MCP server registry and runtime channels. */
export function registerMcpIpc({
  registrar,
  getHost,
  userMcp,
  currentWorkspacePath,
  refreshUserMcp,
  describeError,
  sendToRenderer,
  searchMcpRegistry,
}: McpIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  // The market's registry client never touches the host process, so it
  // registers outside the host-bound wrapper.
  registrar.handle(IPC.invoke.mcpMarketSearch, async ({ query }: { query?: string } = {}) =>
    searchMcpRegistry(query ?? ""),
  );

handle(IPC.invoke.mcpList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ servers: McpServerRecord[]; statuses?: McpServerStatus[] }>(
      "mcp.list",
      query,
    );
    // Status belongs to the currently open project's active runtime, while the
    // list itself must include disabled records for the settings page.
    await refreshUserMcp(currentWorkspacePath());
    return { servers: result.servers ?? [], statuses: userMcp.listStatuses() };
  });

  handle(IPC.invoke.mcpUpsert, async (server: McpServerInput) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
    await refreshUserMcp(currentWorkspacePath());
    sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: res.server?.id });
    return res;
  });

  handle(
    IPC.invoke.mcpRemove,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.remove", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setEnabled", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setScope", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpTest,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const query = {
        ...(payload.level ? { level: payload.level } : {}),
        ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
      } satisfies Partial<AgentCapabilityQuery>;
      const listed = await host.call<{ servers: McpServerRecord[] }>("mcp.list", query);
      // Test may target a project different from the current session. Keep the
      // requested record long enough for the handshake, then restore the
      // current project's active runtime below.
      userMcp.setRecords([
        ...userMcp.listRecords().filter((record) => !listed.servers.some((item) => item.id === record.id)),
        ...(listed.servers ?? []),
      ]);
      const status = await userMcp.test(payload.id);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return { status };
    },
  );

  /**
   * Import a pasted MCP configuration. Servers are saved one at a time so a
   * single bad entry costs that entry rather than the whole paste.
   */
  handle(IPC.invoke.mcpImport, async (payload: { text: string }) => {
    if (!host) throw new Error("host unavailable");
    const parsed = parseMcpImport(String(payload?.text ?? ""));
    const imported: McpServerRecord[] = [];
    const failed = [...parsed.skipped];
    for (const server of parsed.servers) {
      try {
        const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
        imported.push(res.server);
      } catch (error) {
        failed.push({ id: server.id, reason: describeError(error) });
      }
    }
    await refreshUserMcp(currentWorkspacePath());
    if (imported.length) {
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp" });
    }
    return { imported, failed };
  });

}
