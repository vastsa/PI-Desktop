import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { McpOAuthManager } from "../electron/main/mcp-oauth.ts";
import { authorizationMetadataUrls } from "../electron/main/mcp-oauth-discovery.ts";

test("issuer paths cannot change the discovery origin", () => {
  const issuer = new URL("https://auth.example:8443//other.example/tenant");
  const urls = authorizationMetadataUrls(issuer).map(value => new URL(value));
  assert.ok(urls.every(url => url.origin === issuer.origin));
  assert.equal(urls[2].pathname, "//other.example/tenant/.well-known/openid-configuration");
});

// Real HTTP discovery, registration, authorization redirect and token exchange;
// only the browser launcher and encrypted host storage are external test seams.
async function authorize(t, options = {}) {
  const requests = [];
  const secrets = new Map();
  const opened = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let authorization;
  let tokenRequest;
  let registration;
  let origin;
  const issuerPath = options.issuerPath ?? "/api/auth";
  const suffix = issuerPath.replace(/\/+$/, "");
  const candidates = suffix ? [
    `/.well-known/oauth-authorization-server${suffix}`,
    `/.well-known/openid-configuration${suffix}`,
    `${suffix}/.well-known/openid-configuration`,
  ] : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
  const metadataPath = candidates[options.availableCandidate ?? 0];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      requests.push(url.pathname);
      const json = (data, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const body = async () => {
        let text = "";
        for await (const chunk of req) text += chunk;
        return text;
      };
      if (url.pathname === "/mcp") {
        const challenge = options.challenge ?? `Bearer resource_metadata="${origin}/metadata"`;
        res.setHeader("WWW-Authenticate", challenge.replaceAll("{origin}", origin));
        json({ error: "unauthorized" }, options.probeStatus ?? 401);
      } else if (url.pathname === "/metadata" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}${issuerPath}`],
          ...("resourceScopes" in options ? { scopes_supported: options.resourceScopes } : {}),
        });
      } else if (url.pathname === metadataPath) {
        json({
          issuer: `${origin}${issuerPath}`,
          authorization_endpoint: `${origin}/authorize?scope=provider-default`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          scopes_supported: ["openid", "default", "offline_access"],
        });
      } else if (url.pathname === "/register") {
        registration = JSON.parse(await body());
        json({ client_id: "fixture-client", redirect_uris: registration.redirect_uris }, 201);
      } else if (url.pathname === "/authorize") {
        authorization = url.searchParams;
        const callback = new URL(authorization.get("redirect_uri"));
        callback.searchParams.set("state", authorization.get("state"));
        callback.searchParams.set("code", "fixture-code");
        res.writeHead(302, { location: callback.toString() });
        res.end();
      } else if (url.pathname === "/token") {
        tokenRequest = new URLSearchParams(await body());
        json({ access_token: "fixture-token", token_type: "Bearer" });
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      res.writeHead(500);
      res.end();
      opened.reject(error);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const manager = new McpOAuthManager({
    call: async (method, params) => {
      if (method === "secrets.getForRuntime") return { value: secrets.get(params.secretRef) ?? null };
      if (method === "secrets.set") {
        secrets.set(params.secretRef, params.value);
        return { ok: true };
      }
      throw new Error(`Unexpected host method: ${method}`);
    },
    openExternal: async url => { opened.resolve(url); },
    emit: event => {
      if (event.kind === "error") opened.reject(new Error(event.message));
      if (event.kind === "done" || event.kind === "error") completed.resolve(event);
    },
  });
  t.after(async () => {
    manager.disposeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  await manager.start("fixture", `${origin}/mcp`);
  const authUrl = new URL(await opened.promise);
  assert.equal(authUrl.searchParams.get("scope"), options.expectedScope ?? null);
  const callbackResponse = await fetch(authUrl);
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /Authorization successful/);
  assert.equal((await completed.promise).kind, "done");
  assert.equal(await manager.getValidAccessToken("fixture"), "fixture-token");
  assert.equal(authorization.get("resource"), `${origin}/mcp`);
  assert.equal(tokenRequest.get("resource"), `${origin}/mcp`);
  assert.equal(tokenRequest.get("code"), "fixture-code");
  assert.equal(tokenRequest.get("client_id"), "fixture-client");
  assert.equal(tokenRequest.get("redirect_uri"), authorization.get("redirect_uri"));
  assert.ok(registration.redirect_uris.includes(authorization.get("redirect_uri")));
  assert.equal(authorization.get("code_challenge_method"), "S256");
  assert.equal(authorization.get("code_challenge"),
    createHash("sha256").update(tokenRequest.get("code_verifier")).digest("base64url"));
  assert.deepEqual(requests.filter(path => candidates.includes(path)),
    candidates.slice(0, (options.availableCandidate ?? 0) + 1));
}

for (const issuerPath of ["/api/auth", "/realms/team-a/", "/tenant%2Fone", ""]) {
  for (let availableCandidate = 0; availableCandidate < (issuerPath ? 3 : 2); availableCandidate++) {
    test(`OAuth login preserves issuer ${issuerPath || "/"} through discovery fallback ${availableCandidate + 1}`, { timeout: 5000 }, async t => {
      await authorize(t, { issuerPath, availableCandidate });
    });
  }
}

for (const [name, options] of [
  ["challenge overrides resource scopes", {
    challenge: 'Bearer resource_metadata="{origin}/metadata", scope="files:read files:search"',
    resourceScopes: ["files:admin"], expectedScope: "files:read files:search",
  }],
  ["challenge scope works without a metadata URL", {
    challenge: 'Bearer scope="files:read"', expectedScope: "files:read",
  }],
  ["resource metadata supplies all scopes", {
    resourceScopes: ["files:read", "files:search"], expectedScope: "files:read files:search",
  }],
  ["missing resource scopes do not inherit authorization server scopes", {}],
  ["empty resource scopes omit scope", { resourceScopes: [] }],
  ["non-string resource scopes are not sent", { resourceScopes: [null, 42, {}] }],
  ["Basic challenge scopes are ignored", {
    challenge: 'Basic realm="private, scope=admin", scope="admin", Bearer scope="files:read"',
    expectedScope: "files:read",
  }],
  ["later Basic challenge cannot supply Bearer scope", {
    challenge: 'Bearer realm="mcp", Basic realm="private", scope="admin"',
    resourceScopes: ["files:read"], expectedScope: "files:read",
  }],
  ["unquoted and case-insensitive Bearer parameters work", {
    challenge: 'bEaReR SCOPE = files:read', expectedScope: "files:read",
  }],
  ["scope is only taken from an unauthorized response", {
    challenge: 'Bearer scope="admin"', probeStatus: 200,
    resourceScopes: ["files:read"], expectedScope: "files:read",
  }],
]) {
  test(`OAuth scope: ${name}`, { timeout: 5000 }, async t => {
    await authorize(t, { issuerPath: "", ...options });
  });
}
