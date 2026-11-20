import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createBuiltinGitHubMcp } = await import("../electron/main/github/builtin-mcp.ts");

test("the built-in GitHub tools use the current connector token without sharing it with user servers", async () => {
  let enabled = true;
  let token = "fixture-connector-token";
  let statusReads = 0;
  const builtin = createBuiltinGitHubMcp({
    enabled: async () => enabled,
    connector: () => ({
      status: async () => { statusReads++; return { connected: Boolean(token) }; },
      token: async () => token,
    }),
  });
  const oauth = builtin.oauth({ getValidAccessToken: async () => "user-server-token", hasOAuth: async () => true });
  const custom = { id: "github", url: "https://example.invalid/custom" };
  const [record] = await builtin.merge([]);
  assert.equal(record.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(record.headers["X-MCP-Toolsets"], "issues,pull_requests");
  assert.equal(await oauth.getValidAccessToken("github", { ...record }), token);
  assert.equal(await oauth.getValidAccessToken("github", custom), "user-server-token");
  assert.equal(await oauth.getValidAccessToken("other", record), "user-server-token");
  assert.deepEqual(await builtin.merge([custom]), [custom]);
  assert.equal(await builtin.state([custom]), "shadowed");
  token = "replacement";
  assert.equal(await oauth.getValidAccessToken("github", record), token);
  enabled = false;
  const before = statusReads;
  assert.deepEqual(await builtin.merge([]), []);
  assert.equal(statusReads, before);
  assert.equal(await oauth.getValidAccessToken("github", record), null);
  enabled = true;
  token = null;
  assert.equal(await builtin.state([]), "disconnected");
});
