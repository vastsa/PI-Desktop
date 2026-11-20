import {
  GITHUB_MCP_SERVER_ID, GITHUB_MCP_TOOLSETS, GITHUB_MCP_URL,
  type GitHubConnectorStatus, type McpServerRecord,
} from "@pi-desktop/shared";
import type { UserMcpOAuthHandler } from "../user-mcp";
import { getActiveGitHubConnector, type GitHubConnector } from "./connector";

export const builtInGitHub = Symbol.for("pi-desktop.built-in-github-mcp");
type MarkedRecord = McpServerRecord & { [builtInGitHub]?: true };
export type GitHubAgentToolsState = NonNullable<GitHubConnectorStatus["agentTools"]>;

export function createBuiltinGitHubMcp(deps: {
  connector: () => Pick<GitHubConnector, "status" | "token"> | null;
  enabled(): Promise<boolean>;
  url?: string;
}) {
  async function state(records: McpServerRecord[]): Promise<GitHubAgentToolsState> {
    if (records.some((record) => record.id === GITHUB_MCP_SERVER_ID)) return "shadowed";
    if (!await deps.enabled()) return "disabled";
    const status = await deps.connector()?.status();
    return status?.connected && !status.needsReauthentication ? "active" : "disconnected";
  }
  return {
    state,
    async merge(records: McpServerRecord[], configured = records): Promise<McpServerRecord[]> {
      if (await state(configured) !== "active") return records;
      const server: MarkedRecord = {
        id: GITHUB_MCP_SERVER_ID, label: "GitHub", transport: "http", url: deps.url ?? GITHUB_MCP_URL,
        headers: { "X-MCP-Toolsets": GITHUB_MCP_TOOLSETS }, enabled: true, level: "global", timeoutSeconds: 60,
        createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", [builtInGitHub]: true,
      };
      return [...records, server];
    },
    oauth(inner: UserMcpOAuthHandler): UserMcpOAuthHandler {
      return {
        async getValidAccessToken(id, record) {
          if (id !== GITHUB_MCP_SERVER_ID || !(record as MarkedRecord | undefined)?.[builtInGitHub]) return inner.getValidAccessToken(id, record);
          if (!await deps.enabled()) return null;
          return (await deps.connector()?.token()) ?? null;
        },
        async hasOAuth(id, record) {
          if (id !== GITHUB_MCP_SERVER_ID || !(record as MarkedRecord | undefined)?.[builtInGitHub]) return inner.hasOAuth(id, record);
          return await deps.enabled() && Boolean(await deps.connector()?.token());
        },
      };
    },
  };
}

let active: ReturnType<typeof createBuiltinGitHubMcp> | null = null;
export function configureBuiltinGitHubMcp(enabled: () => Promise<boolean>) {
  active = createBuiltinGitHubMcp({ connector: getActiveGitHubConnector, enabled });
  return active;
}
export function getBuiltinGitHubMcp() { return active; }
