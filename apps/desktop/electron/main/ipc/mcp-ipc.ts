import { IPC, parseMcpImport, type ActivationScope, type AgentCapabilityMove, type AgentCapabilityQuery, type MarketSource, type McpServerInput, type McpServerRecord, type McpServerStatus } from "@pi-desktop/shared";
import type { McpOAuthManager } from "../mcp-oauth";
import type { HostProcess } from "../host-process";
import type { McpRegistrySearchResult } from "../mcp-registry-catalog";
import type { UserMcpRuntime } from "../user-mcp";
import type { IpcRegistrar } from "./types";

export type McpIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  userMcp: UserMcpRuntime;
  oauth?: McpOAuthManager;
  currentWorkspacePath: () => string | null;
  refreshUserMcp: (projectPath?: string | null) => Promise<McpServerRecord[]>;
  describeError: (error: unknown) => string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  searchMcpMarket: (
    query: string,
    sources: MarketSource[],
    options?: { more?: boolean },
  ) => Promise<McpRegistrySearchResult>;
};

/** Register user-owned MCP server registry and runtime channels. */
export function registerMcpIpc({
  registrar,
  getHost,
  userMcp,
  oauth,
  currentWorkspacePath,
  refreshUserMcp,
  describeError,
  sendToRenderer,
  searchMcpMarket,
}: McpIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  // The market's source aggregator never touches the host process, so it
  // registers outside the host-bound wrapper.
  registrar.handle(
    IPC.invoke.mcpMarketSearch,
    async ({
      query,
      sources,
      more,
    }: { query?: string; sources?: MarketSource[]; more?: boolean } = {}) =>
      searchMcpMarket(query ?? "", Array.isArray(sources) ? sources : [], { more: more === true }),
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
    const statuses = await Promise.all(
      userMcp.listStatuses().map(async (status) => ({
        ...status,
        hasOauth: oauth ? await oauth.hasOAuth(status.serverId) : false,
      })),
    );
    return { servers: result.servers ?? [], statuses };
  });

  handle(IPC.invoke.mcpUpsert, async (server: McpServerInput) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
    await refreshUserMcp(currentWorkspacePath());
    sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: res.server?.id });
    if (res.server && res.server.enabled !== false) {
      void userMcp
        .test(res.server.id)
        .then(() => {
          sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: res.server.id });
        })
        .catch(() => {});
    }
    return res;
  });

  handle(
    IPC.invoke.mcpRemove,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.remove", payload);
      await oauth?.deleteOAuth(payload.id);
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

  /**
   * Move a server between the global and a project's `.agents/servers`.
   *
   * Ownership changes, so both levels change: the project runtime is rebuilt and
   * the renderer is told which id the server ended up under, because a move into
   * an occupied destination renames it.
   */
  handle(IPC.invoke.mcpTransfer, async (payload: AgentCapabilityMove) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ server: McpServerRecord }>("mcp.transfer", payload);
    if (res.server?.id && payload.id && payload.id !== res.server.id) {
      await oauth?.transferOAuth(payload.id, res.server.id);
    }
    await refreshUserMcp(currentWorkspacePath());
    sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: res.server?.id });
    return res;
  });

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
      const hasOauth = oauth ? await oauth.hasOAuth(payload.id) : false;
      return { status: { ...status, hasOauth } };
    },
  );

  handle(
    IPC.invoke.mcpOauthStart,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      if (!oauth) throw new Error("OAuth manager unavailable");
      const query = {
        ...(payload.level ? { level: payload.level } : {}),
        ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
      } satisfies Partial<AgentCapabilityQuery>;
      const listed = await host.call<{ servers: McpServerRecord[] }>("mcp.list", query);
      const server = listed.servers.find((item) => item.id === payload.id);
      if (!server) throw new Error(`MCP server not found: ${payload.id}`);
      if (server.transport !== "http" || !server.url) {
        throw new Error(`MCP server ${payload.id} is not an HTTP transport server`);
      }

      return oauth.start(server.id, server.url, server);
    },
  );

  handle(
    IPC.invoke.mcpOauthCancel,
    async (payload: { loginId?: string; id?: string }) => {
      if (!oauth) return { ok: false };
      const target = payload?.loginId || payload?.id;
      return { ok: typeof target === "string" && oauth.cancel(target) };
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
