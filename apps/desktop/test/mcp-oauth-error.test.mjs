import assert from "node:assert/strict";
import test from "node:test";

import { mcpOAuthErrorTranslationKey } from "../src/lib/mcp-oauth-error.ts";

test("the no-DCR OAuth error selects localized recovery guidance", () => {
  assert.equal(
    mcpOAuthErrorTranslationKey("MCP_OAUTH_DCR_UNAVAILABLE"),
    "extensions.mcp.authDcrUnavailable",
  );
  assert.equal(mcpOAuthErrorTranslationKey(undefined), undefined);
});
