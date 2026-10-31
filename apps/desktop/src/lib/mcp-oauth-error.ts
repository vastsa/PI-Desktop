import type { McpOAuthLoginErrorCode } from "@pi-desktop/shared";

type McpOAuthErrorTranslationKey = "extensions.mcp.authDcrUnavailable";

export function mcpOAuthErrorTranslationKey(
  errorCode: McpOAuthLoginErrorCode | undefined,
): McpOAuthErrorTranslationKey | undefined {
  switch (errorCode) {
    case "MCP_OAUTH_DCR_UNAVAILABLE":
      return "extensions.mcp.authDcrUnavailable";
    default:
      return undefined;
  }
}
