import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  McpOAuthManager,
  escapeHtml,
  parseExpiresIn,
  assertTlsProtectedUrl,
  canReuseDcrClient,
  isLoopbackHostname,
  LOOPBACK_REDIRECT_PORTLESS,
} from "../electron/main/mcp-oauth.ts";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";

function fakeHost() {
  const secrets = new Map();
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "secrets.set":
        secrets.set(params.secretRef, params.value);
        return { ok: true };
      case "secrets.getForRuntime":
        return { value: secrets.get(params.secretRef) ?? null };
      case "secrets.has":
        return { has: secrets.has(params.secretRef) };
      case "secrets.delete":
        secrets.delete(params.secretRef);
        return { ok: true };
      default:
        throw new Error(`unexpected host call: ${method}`);
    }
  };
  return { call, secrets, calls };
}

async function waitUntil(predicate, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function createMockFetch(options = {}) {
  const registeredClients = [];
  const tokenRequests = [];
  let refreshCount = 0;

  const mockFetch = async (input, init = {}) => {
    const urlStr = typeof input === "string" ? input : input.url;
    const url = new URL(urlStr);
    const method = init.method ?? "GET";

    if (url.pathname === "/mcp") {
      const auth = init.headers?.authorization ?? init.headers?.Authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer resource_metadata="https://notion.test/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search_pages" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return new Response(JSON.stringify({
        resource: "https://notion.test/mcp",
        authorization_servers: ["https://notion.test"],
        scopes_supported: ["read", "write"],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(JSON.stringify({
        issuer: "https://notion.test",
        authorization_endpoint: "https://notion.test/authorize",
        token_endpoint: "https://notion.test/token",
        registration_endpoint: "https://notion.test/register",
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/register" && method === "POST") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const client = {
        client_id: `registered-client-${registeredClients.length + 1}`,
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
      };
      registeredClients.push(client);
      return new Response(JSON.stringify(client), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/token" && method === "POST") {
      const params = new URLSearchParams(init.body);
      tokenRequests.push(Object.fromEntries(params.entries()));
      const grantType = params.get("grant_type");

      if (grantType === "authorization_code") {
        const code = params.get("code");
        if (code === "valid-code") {
          return new Response(JSON.stringify({
            access_token: "mock-access-token-123",
            token_type: "Bearer",
            refresh_token: "mock-refresh-token-456",
            expires_in: options.stringExpiresIn ? "3600" : 3600,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (grantType === "refresh_token") {
        refreshCount++;
        if (options.refreshStatus) {
          return new Response(JSON.stringify({ error: "unavailable" }), {
            status: options.refreshStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        const refreshToken = params.get("refresh_token");
        if (refreshToken === "mock-refresh-token-456") {
          return new Response(JSON.stringify({
            access_token: `mock-refreshed-token-${refreshCount}`,
            token_type: "Bearer",
            refresh_token: `mock-refresh-token-${refreshCount}`,
            expires_in: options.stringExpiresIn ? "3600" : 3600,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(null, { status: 404 });
  };

  return { mockFetch, registeredClients, tokenRequests, getRefreshCount: () => refreshCount };
}

function createMockServerFactory(options = {}) {
  let activeRequestListener = null;
  let closed = false;
  let assignedPort = options.port ?? 54321;
  const listenPorts = [];
  let failPreferred = options.failPreferred === true;

  const mockCreateServer = (requestListener) => {
    activeRequestListener = requestListener;
    closed = false;
    const emitter = new EventEmitter();
    emitter.listen = (port, _host, callback) => {
      listenPorts.push(port);
      if (port && port !== 0 && failPreferred) {
        failPreferred = false;
        queueMicrotask(() => {
          emitter.emit(
            "error",
            Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
          );
        });
        return emitter;
      }
      assignedPort = !port || port === 0 ? (options.port ?? 54321) : port;
      if (callback) queueMicrotask(callback);
      return emitter;
    };
    emitter.address = () => ({
      port: assignedPort,
      family: "IPv4",
      address: "127.0.0.1",
    });
    emitter.close = (cb) => {
      closed = true;
      activeRequestListener = null;
      if (cb) cb();
      return emitter;
    };
    return emitter;
  };

  const simulateCallback = async (pathWithQuery) => {
    if (!activeRequestListener) {
      throw new Error("No active mock server listener");
    }
    const req = new EventEmitter();
    req.url = pathWithQuery;
    req.headers = { host: `127.0.0.1:${assignedPort}` };

    let statusCode = 200;
    const headers = {};
    let body = "";

    const res = {
      writeHead: (status, h) => {
        statusCode = status;
        if (h) Object.assign(headers, h);
      },
      end: (chunk) => {
        if (chunk) body += chunk;
      },
    };

    await activeRequestListener(req, res);
    return { statusCode, headers, body };
  };

  return {
    mockCreateServer,
    simulateCallback,
    isClosed: () => closed,
    listenPorts,
    getPort: () => assignedPort,
  };
}

test("McpOAuthManager: discovers metadata through RFC 9728 and RFC 8414", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch();
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  const metadata = await manager.discoverMetadata("https://notion.test/mcp");
  assert.ok(metadata, "Metadata should be discovered");
  assert.equal(metadata.resource, "https://notion.test/mcp");
  assert.equal(metadata.authorizationEndpoint, "https://notion.test/authorize");
  assert.equal(metadata.tokenEndpoint, "https://notion.test/token");
  assert.equal(metadata.registrationEndpoint, "https://notion.test/register");
});

test("McpOAuthManager: executes full authorization flow with DCR, PKCE, 127.0.0.1 redirect, and RFC 8707 resource", async (t) => {
  const host = fakeHost();
  const { mockFetch, registeredClients, tokenRequests } = createMockFetch();
  const { mockCreateServer, simulateCallback } = createMockServerFactory();
  const events = [];

  let openedUrl = null;
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    emit: (event) => events.push(event),
    openExternal: async (url) => {
      openedUrl = url;
    },
  });
  t.after(() => manager.disposeAll());

  const serverRecord = {
    id: "notion-test",
    label: "Notion Test",
    transport: "http",
    url: "https://notion.test/mcp",
  };

  // Launch non-blocking flow
  const startResult = await manager.start(serverRecord.id, serverRecord.url);
  assert.equal(startResult.ok, true);
  assert.ok(startResult.loginId);

  // Poll for browser open external
  for (let i = 0; i < 50; i++) {
    if (openedUrl) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(openedUrl, "Should have opened external authorization URL");

  const parsedUrl = new URL(openedUrl);
  assert.equal(parsedUrl.origin, "https://notion.test");
  assert.equal(parsedUrl.pathname, "/authorize");
  assert.ok(parsedUrl.searchParams.get("client_id"));
  assert.ok(parsedUrl.searchParams.get("code_challenge"));
  assert.equal(parsedUrl.searchParams.get("code_challenge_method"), "S256");

  // Verify RFC 8707 resource parameter on authorization URL
  assert.equal(parsedUrl.searchParams.get("resource"), "https://notion.test/mcp");

  // Verify redirect_uri is on 127.0.0.1, not localhost (RFC 8252)
  assert.equal(parsedUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:54321/callback");
  assert.equal(registeredClients.length, 1);
  assert.deepEqual(registeredClients[0].redirect_uris, [
    LOOPBACK_REDIRECT_PORTLESS,
    "http://127.0.0.1:54321/callback",
  ]);

  const state = parsedUrl.searchParams.get("state");
  assert.ok(state);

  // Simulate user authorization callback
  const callbackRes = await simulateCallback(`/callback?code=valid-code&state=${encodeURIComponent(state)}`);
  assert.equal(callbackRes.statusCode, 200);
  assert.ok(callbackRes.body.includes("Authorization successful!"));

  // Verify RFC 8707 resource on token exchange request
  const tokenReq = tokenRequests.find((r) => r.grant_type === "authorization_code");
  assert.ok(tokenReq);
  assert.equal(tokenReq.resource, "https://notion.test/mcp");
  assert.equal(tokenReq.redirect_uri, "http://127.0.0.1:54321/callback");

  // Verify event stream delivered "done"
  const doneEvent = events.find((e) => e.kind === "done");
  assert.ok(doneEvent);
  assert.equal(doneEvent.status.hasOauth, true);

  const hasAuth = await manager.hasOAuth("notion-test");
  assert.equal(hasAuth, true);

  const token = await manager.getValidAccessToken("notion-test");
  assert.equal(token, "mock-access-token-123");
});

test("McpOAuthManager: escapes HTML on error callback to prevent reflected XSS", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch();
  const { mockCreateServer, simulateCallback } = createMockServerFactory();
  const events = [];

  let openedUrl = null;
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    emit: (event) => events.push(event),
    openExternal: async (url) => {
      openedUrl = url;
    },
  });
  t.after(() => manager.disposeAll());

  await manager.start("xss-test", "https://notion.test/mcp");
  await waitUntil(() => openedUrl);

  const xssPayload = '<script>alert("xss")</script>';
  const unmatched = await simulateCallback(
    `/callback?error=access_denied&error_description=${encodeURIComponent(xssPayload)}`,
  );
  assert.equal(unmatched.statusCode, 400);
  assert.equal(unmatched.body.includes("<script>"), false);
  assert.equal(events.some((event) => event.kind === "error"), false);

  const state = new URL(openedUrl).searchParams.get("state");
  const matched = await simulateCallback(
    `/callback?error=access_denied&error_description=${encodeURIComponent(xssPayload)}&state=${encodeURIComponent(state)}`,
  );
  assert.equal(matched.statusCode, 400);
  assert.equal(matched.body.includes("<script>"), false);
  assert.ok(matched.body.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));
  const errEvent = events.find((event) => event.kind === "error");
  assert.ok(errEvent);
  assert.ok(errEvent.message.includes("access_denied"));
});

test("McpOAuthManager: parses string expires_in and automatically refreshes near-expiry token", async (t) => {
  const host = fakeHost();
  const { mockFetch, tokenRequests } = createMockFetch({ stringExpiresIn: true });
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  assert.equal(parseExpiresIn("3600"), 3600);
  assert.equal(parseExpiresIn(3600), 3600);
  assert.equal(parseExpiresIn("invalid"), undefined);

  const nearExpiryPayload = {
    serverId: "notion-refresh-test",
    accessToken: "old-token",
    refreshToken: "mock-refresh-token-456",
    expiresAt: Date.now() + 5_000,
    tokenEndpoint: "https://notion.test/token",
    clientId: "test-client-id",
    resource: "https://notion.test/mcp",
  };
  await host.call("secrets.set", {
    secretRef: "secret:mcp:notion-refresh-test:oauth",
    value: JSON.stringify(nearExpiryPayload),
  });

  const refreshedToken = await manager.getValidAccessToken("notion-refresh-test");
  assert.equal(refreshedToken, "mock-refreshed-token-1");

  // Verify refresh_token grant request occurred with RFC 8707 resource
  const lastReq = tokenRequests[tokenRequests.length - 1];
  assert.equal(lastReq.grant_type, "refresh_token");
  assert.equal(lastReq.refresh_token, "mock-refresh-token-456");
  assert.equal(lastReq.resource, "https://notion.test/mcp");
});

test("McpOAuthManager: serializes concurrent token refreshes without racing", async (t) => {
  const host = fakeHost();
  const { mockFetch, getRefreshCount } = createMockFetch();
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  await host.call("secrets.set", {
    secretRef: "secret:mcp:race-test:oauth",
    value: JSON.stringify({
      serverId: "race-test",
      accessToken: "old-token",
      refreshToken: "mock-refresh-token-456",
      expiresAt: Date.now() + 5_000,
      tokenEndpoint: "https://notion.test/token",
      clientId: "test-client-id",
    }),
  });

  // Trigger two concurrent refresh operations
  const [token1, token2] = await Promise.all([
    manager.getValidAccessToken("race-test"),
    manager.getValidAccessToken("race-test"),
  ]);

  // Both callers receive the same refreshed token
  assert.equal(token1, "mock-refreshed-token-1");
  assert.equal(token2, "mock-refreshed-token-1");
  // Exactly one refresh request took place
  assert.equal(getRefreshCount(), 1);
});

test("McpOAuthManager: reuses stored DCR client credentials on subsequent logins", async (t) => {
  const host = fakeHost();
  const { mockFetch, registeredClients } = createMockFetch();
  const { mockCreateServer } = createMockServerFactory();
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  // First login registers client
  await manager.start("reuse-test", "https://notion.test/mcp");
  for (let i = 0; i < 50 && registeredClients.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(registeredClients.length, 1);
  const firstClientId = registeredClients[0].client_id;

  // Seed existing token with that registration endpoint
  await host.call("secrets.set", {
    secretRef: "secret:mcp:reuse-test:oauth",
    value: JSON.stringify({
      clientId: firstClientId,
      registrationEndpoint: "https://notion.test/register",
      tokenEndpoint: "https://notion.test/token",
      accessToken: "mock-token",
      redirectUris: [LOOPBACK_REDIRECT_PORTLESS],
    }),
  });

  // Second login should reuse firstClientId without re-registering
  await manager.start("reuse-test", "https://notion.test/mcp");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(registeredClients.length, 1, "Should not have registered a second client");
});

test("McpOAuthManager: transferOAuth migrates secret between server IDs", async (t) => {
  const host = fakeHost();
  const manager = new McpOAuthManager({ call: host.call, openExternal: async () => {} });

  await host.call("secrets.set", {
    secretRef: "secret:mcp:orig-server:oauth",
    value: JSON.stringify({ accessToken: "transferred-token-123" }),
  });

  assert.equal(await manager.hasOAuth("orig-server"), true);
  assert.equal(await manager.hasOAuth("moved-server"), false);

  await manager.transferOAuth("orig-server", "moved-server");

  assert.equal(await manager.hasOAuth("orig-server"), false);
  assert.equal(await manager.hasOAuth("moved-server"), true);

  const movedSecret = await host.call("secrets.getForRuntime", {
    secretRef: "secret:mcp:moved-server:oauth",
  });
  assert.equal(JSON.parse(movedSecret.value).accessToken, "transferred-token-123");
});

test("McpOAuthManager: cancel stops loopback server and emits cancelled event", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch();
  const { mockCreateServer, isClosed } = createMockServerFactory();
  const events = [];

  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    emit: (event) => events.push(event),
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  const result = await manager.start("cancel-test", "https://notion.test/mcp");
  await new Promise((r) => setTimeout(r, 20));

  const canceled = manager.cancel(result.loginId);
  assert.equal(canceled, true);
  assert.equal(isClosed(), true);

  const cancelEvent = events.find((e) => e.kind === "cancelled");
  assert.ok(cancelEvent);
});

test("UserMcpRuntime: rebuilds live client when OAuth token is updated", async (t) => {
  const host = fakeHost();
  const manager = new McpOAuthManager({ call: host.call, openExternal: async () => {} });

  await host.call("secrets.set", {
    secretRef: "secret:mcp:rebuild-test:oauth",
    value: JSON.stringify({ accessToken: "initial-token" }),
  });

  const createdClients = [];
  const mockClientFactory = (config) => {
    let connected = false;
    const client = {
      config,
      connect: async () => {
        connected = true;
        return [{ name: "tool1" }];
      },
      close: () => {
        connected = false;
      },
      isConnected: () => connected,
      getTools: () => [{ name: "tool1" }],
      callTool: async () => "result",
    };
    createdClients.push(client);
    return client;
  };

  const runtime = new UserMcpRuntime({
    createClient: mockClientFactory,
    oauth: manager,
  });
  t.after(() => runtime.disposeAll());

  const record = {
    id: "rebuild-test",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    enabled: true,
  };
  runtime.setRecords([record]);

  // First connection uses initial token
  await runtime.test(record.id);
  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0].config.server.headers.Authorization, "Bearer initial-token");

  // Token is updated in host-core secrets
  await host.call("secrets.set", {
    secretRef: "secret:mcp:rebuild-test:oauth",
    value: JSON.stringify({ accessToken: "updated-token-new" }),
  });

  // Re-testing drops old client and rebuilds with new token
  await runtime.test(record.id);
  assert.equal(createdClients.length, 2);
  assert.equal(createdClients[1].config.server.headers.Authorization, "Bearer updated-token-new");
});

test("UserMcpRuntime: maps 401 in callTool to authRequired", async (t) => {
  let fail401 = false;
  const mockClient = {
    connect: async () => [{ name: "test_tool" }],
    close: () => {},
    isConnected: () => true,
    getTools: () => [{ name: "test_tool" }],
    callTool: async () => {
      if (fail401) {
        throw new Error("HTTP 401 Unauthorized: token revoked");
      }
      return "ok";
    },
  };

  const runtime = new UserMcpRuntime({
    createClient: () => mockClient,
  });
  t.after(() => runtime.disposeAll());

  const record = {
    id: "tool-401-test",
    label: "Tool 401 Test",
    transport: "http",
    url: "https://mcp.test",
    enabled: true,
  };
  runtime.setRecords([record]);

  // Initial connect
  await runtime.test(record.id);
  assert.equal(runtime.statusFor(record.id).authRequired, false);

  // Normal tool call succeeds
  const res = await runtime.callTool("mcp_tool_401_test_test_tool", {}, null);
  assert.equal(res, "ok");

  // Trigger 401 on tool call
  fail401 = true;
  await assert.rejects(
    () => runtime.callTool("mcp_tool_401_test_test_tool", {}, null),
    /401 Unauthorized/,
  );

  // Status must now reflect authRequired: true
  const status = runtime.statusFor(record.id);
  assert.equal(status.state, "failed");
  assert.equal(status.authRequired, true);
});

test("HTML escaping helper prevents script and attribute injection", () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("Tom & Jerry 'cat'"), "Tom &amp; Jerry &#39;cat&#39;");
});

test("TLS helpers allow HTTPS and loopback HTTP only", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("evil.test"), false);
  assert.equal(assertTlsProtectedUrl("https://auth.example/x", "authorization_endpoint").protocol, "https:");
  assert.equal(assertTlsProtectedUrl("http://127.0.0.1:9/x", "token_endpoint").hostname, "127.0.0.1");
  assert.throws(
    () => assertTlsProtectedUrl("http://evil.test/token", "token_endpoint"),
    /must use HTTPS/,
  );
  assert.equal(
    canReuseDcrClient(
      {
        clientId: "abc",
        registrationEndpoint: "https://auth.example/register",
        tokenEndpoint: "https://auth.example/token",
        accessToken: "t",
        redirectUris: [LOOPBACK_REDIRECT_PORTLESS],
      },
      "https://auth.example/register",
      "http://127.0.0.1:9/callback",
    ),
    true,
  );
  assert.equal(
    canReuseDcrClient(
      {
        clientId: "abc",
        registrationEndpoint: "https://auth.example/register",
        tokenEndpoint: "https://auth.example/token",
        accessToken: "t",
        redirectUris: ["http://127.0.0.1:11111/callback"],
      },
      "https://auth.example/register",
      "http://127.0.0.1:54321/callback",
    ),
    false,
  );
});

test("McpOAuthManager: rejects non-loopback HTTP authorization servers", async (t) => {
  const host = fakeHost();
  const mockFetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return new Response(JSON.stringify({
        resource: "http://insecure.test/mcp",
        authorization_servers: ["http://insecure.test"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  };
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());
  await assert.rejects(
    () => manager.discoverMetadata("http://insecure.test/mcp"),
    /authorization_server must use HTTPS/,
  );
});

test("McpOAuthManager: unmatched state does not abort login; replay is rejected", async (t) => {
  const host = fakeHost();
  const { mockFetch, tokenRequests } = createMockFetch();
  const { mockCreateServer, simulateCallback } = createMockServerFactory();
  const events = [];
  let openedUrl = null;
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    emit: (event) => events.push(event),
    openExternal: async (url) => {
      openedUrl = url;
    },
  });
  t.after(() => manager.disposeAll());

  await manager.start("csrf-test", "https://notion.test/mcp");
  await waitUntil(() => openedUrl);
  const state = new URL(openedUrl).searchParams.get("state");

  const mismatch = await simulateCallback(`/callback?code=valid-code&state=deadbeef`);
  assert.equal(mismatch.statusCode, 400);
  assert.equal(events.some((event) => event.kind === "error" || event.kind === "done"), false);

  const [first, second] = await Promise.all([
    simulateCallback(`/callback?code=valid-code&state=${encodeURIComponent(state)}`),
    simulateCallback(`/callback?code=valid-code&state=${encodeURIComponent(state)}`),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort((a, b) => a - b), [200, 409]);
  assert.equal(tokenRequests.filter((req) => req.grant_type === "authorization_code").length, 1);
  await waitUntil(() => events.some((event) => event.kind === "done"));
});

test("McpOAuthManager: re-registers when stored redirect is a different exact port", async (t) => {
  const host = fakeHost();
  const { mockFetch, registeredClients } = createMockFetch();
  const { mockCreateServer } = createMockServerFactory({ failPreferred: true });
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  await host.call("secrets.set", {
    secretRef: "secret:mcp:port-lock:oauth",
    value: JSON.stringify({
      clientId: "old-client",
      registrationEndpoint: "https://notion.test/register",
      tokenEndpoint: "https://notion.test/token",
      accessToken: "mock-token",
      redirectUris: ["http://127.0.0.1:11111/callback"],
    }),
  });

  await manager.start("port-lock", "https://notion.test/mcp");
  await waitUntil(() => registeredClients.length === 1);
  assert.equal(registeredClients[0].client_id, "registered-client-1");
  assert.ok(registeredClients[0].redirect_uris.includes("http://127.0.0.1:54321/callback"));
});

test("McpOAuthManager: invalid_grant refresh deletes the stored token", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch();
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  await host.call("secrets.set", {
    secretRef: "secret:mcp:dead-refresh:oauth",
    value: JSON.stringify({
      clientId: "test-client-id",
      tokenEndpoint: "https://notion.test/token",
      accessToken: "old-token",
      refreshToken: "revoked-refresh",
      expiresAt: Date.now() + 5_000,
    }),
  });

  const token = await manager.getValidAccessToken("dead-refresh");
  assert.equal(token, null);
  assert.equal(await manager.hasOAuth("dead-refresh"), false);
});

test("McpOAuthManager: 5xx refresh keeps the existing access token", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch({ refreshStatus: 503 });
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    openExternal: async () => {},
  });
  t.after(() => manager.disposeAll());

  await host.call("secrets.set", {
    secretRef: "secret:mcp:refresh-5xx:oauth",
    value: JSON.stringify({
      clientId: "test-client-id",
      tokenEndpoint: "https://notion.test/token",
      accessToken: "old-token",
      refreshToken: "mock-refresh-token-456",
      expiresAt: Date.now() + 5_000,
    }),
  });

  const token = await manager.getValidAccessToken("refresh-5xx");
  assert.equal(token, "old-token");
  assert.equal(await manager.hasOAuth("refresh-5xx"), true);
});

test("McpOAuthManager: onAuthorized receives the server record", async (t) => {
  const host = fakeHost();
  const { mockFetch } = createMockFetch();
  const { mockCreateServer, simulateCallback } = createMockServerFactory();
  let authorized = null;
  let openedUrl = null;
  const manager = new McpOAuthManager({
    call: host.call,
    fetchImpl: mockFetch,
    createServer: mockCreateServer,
    openExternal: async (url) => {
      openedUrl = url;
    },
    onAuthorized: async (serverId, record) => {
      authorized = { serverId, record };
      return {
        serverId,
        state: "ready",
        toolCount: 3,
        updatedAt: Date.now(),
      };
    },
  });
  t.after(() => manager.disposeAll());

  const record = {
    id: "proj-mcp",
    label: "Project MCP",
    transport: "http",
    url: "https://notion.test/mcp",
  };
  await manager.start(record.id, record.url, record);
  await waitUntil(() => openedUrl);
  const state = new URL(openedUrl).searchParams.get("state");
  const callbackRes = await simulateCallback(
    `/callback?code=valid-code&state=${encodeURIComponent(state)}`,
  );
  assert.equal(callbackRes.statusCode, 200);
  await waitUntil(() => authorized);
  assert.equal(authorized.serverId, record.id);
  assert.equal(authorized.record, record);
});
