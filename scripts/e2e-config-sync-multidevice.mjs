#!/usr/bin/env node
/**
 * Two-device configuration-sync E2E against an ephemeral local WebDAV server.
 *
 * The fixture is intentionally in this script instead of using a real account:
 * it proves conditional writes, encrypted remote objects, and the approval
 * boundary without network credentials or production data. Each Host process
 * has its own data directory, while both point at the same WebDAV collection.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const PASSWORD = "portable-backup-password";
const WEBDAV_USERNAME = "alice";
const WEBDAV_PASSWORD = "webdav-fixture-password";

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function normalizePath(rawPath) {
  return decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, "");
}

async function startWebDavFixture() {
  const state = {
    collections: new Set(["dav"]),
    objects: new Map(),
    nextEtag: 0,
    requests: [],
  };

  const server = createServer(async (request, response) => {
    const path = normalizePath(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    const method = request.method ?? "GET";
    const body = method === "PUT" ? await readBody(request) : Buffer.alloc(0);
    state.requests.push({ method, path });

    const send = (status, payload = Buffer.alloc(0), headers = {}) => {
      response.writeHead(status, {
        "Content-Length": payload.length,
        Connection: "close",
        ...headers,
      });
      response.end(payload);
    };

    const expectedAuthorization = `Basic ${Buffer.from(
      `${WEBDAV_USERNAME}:${WEBDAV_PASSWORD}`,
    ).toString("base64")}`;
    if (request.headers.authorization !== expectedAuthorization) {
      return send(401, Buffer.alloc(0), { "WWW-Authenticate": 'Basic realm="fixture"' });
    }

    if (method === "MKCOL") {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !state.collections.has(parent)) return send(409);
      if (state.collections.has(path)) return send(405);
      state.collections.add(path);
      return send(201);
    }

    if (method === "GET") {
      const value = state.objects.get(path);
      if (!value) return send(404);
      return send(200, value.body, { ETag: `"${value.etag}"` });
    }

    if (method === "PROPFIND") {
      if (!state.collections.has(path)) return send(404);
      const prefix = `${path}/`;
      const entries = new Set([`${path}/`]);
      for (const candidate of [...state.collections, ...state.objects.keys()]) {
      if (
        candidate.startsWith(prefix) &&
        !candidate.slice(prefix.length).includes("/")
      ) {
        entries.add(candidate);
      }
      }
      const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<D:multistatus xmlns:D="DAV:">',
        ...[...entries].map(
          (entry) => `<D:response><D:href>/${xmlEscape(entry)}</D:href></D:response>`,
        ),
        "</D:multistatus>",
      ].join("");
      return send(207, Buffer.from(xml), { "Content-Type": "application/xml" });
    }

    if (method === "PUT") {
      const existing = state.objects.get(path);
      const ifNoneMatch = request.headers["if-none-match"];
      const ifMatch = request.headers["if-match"];
      if (
        (ifNoneMatch === "*" && existing) ||
        (ifMatch && (!existing || ifMatch !== `"${existing.etag}"`))
      ) {
        return send(412);
      }
      const etag = ++state.nextEtag;
      state.objects.set(path, { body, etag });
      return send(201, Buffer.alloc(0), { ETag: `"${etag}"` });
    }

    if (method === "DELETE") {
      state.objects.delete(path);
      return send(204);
    }

    return send(405);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/dav/`,
    state,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function syncConfig(endpoint, deviceLabel, appPassword, backupPassword = PASSWORD) {
  const config = {
    endpoint,
    username: WEBDAV_USERNAME,
    directory: "pi-desktop",
    deviceLabel,
    backupPassword,
    categories: {
      application: true,
      providers: true,
      credentials: false,
      mcp: true,
      skills: true,
      subagents: true,
      instructions: true,
      projects: true,
      plugins: true,
      automation: true,
      memory: false,
    },
    includeSecrets: false,
    includeMemory: false,
    automaticSync: false,
    remoteMode: "strict",
  };
  if (appPassword !== undefined) config.appPassword = appPassword;
  return config;
}

async function approveAll(host, state) {
  let next = state;
  for (let attempt = 0; next.pendingApprovals.length > 0; attempt += 1) {
    assert.ok(attempt < 64, "approval queue did not converge");
    const item = next.pendingApprovals[0];
    next = await host.call(
      "configSync.approve",
      { approvalId: item.id, digest: item.digest },
      120_000,
    );
  }
  return next;
}

const fixture = await startWebDavFixture();
const dataRoot = await mkdtemp(join(tmpdir(), "pi-config-sync-multidevice-"));
const hostBinary = resolveHostBinary();
const hostA = new Host(hostBinary, join(dataRoot, "device-a"));
const hostB = new Host(hostBinary, join(dataRoot, "device-b"));
const previousAgentsDir = process.env.PI_DESKTOP_AGENTS_DIR;
process.env.PI_DESKTOP_AGENTS_DIR = join(dataRoot, "agents");

try {
  await Promise.all([hostA.start(), hostB.start()]);
  // The fixture intentionally uses loopback HTTP. Set the same explicit
  // relaxed LAN policy a user would choose before entering a plaintext URL.
  await Promise.all([
    hostA.call("settings.set", { networkPolicy: { mode: "relaxed" } }),
    hostB.call("settings.set", { networkPolicy: { mode: "relaxed" } }),
  ]);

  const configuredA = await hostA.call(
    "configSync.configure",
    syncConfig(fixture.endpoint, "Device A", WEBDAV_PASSWORD),
    120_000,
  );
  assert.equal(configuredA.configured, true);
  assert.equal(configuredA.remoteMode, "strict");

  // Re-saving with the same endpoint/account and no appPassword must reuse
  // the Host-owned WebDAV secret instead of asking the renderer for it again.
  const reusedPasswordA = await hostA.call(
    "configSync.configure",
    syncConfig(fixture.endpoint, "Device A", undefined, ""),
    120_000,
  );
  assert.equal(reusedPasswordA.configured, true);

  await hostA.call("configSync.syncNow", {}, 120_000);
  const { provider: sharedProvider } = await hostA.call("providers.create", {
    name: "Shared provider",
    vendorKey: "webdav-fixture",
    type: "openai_compatible",
    protocol: "openai_compatible",
    authKind: "api_key_and_base_url",
    secretValue: "fixture-provider-secret",
    baseUrl: "http://127.0.0.1:9/v1",
    apiStyle: "chat_completions",
    defaultModelId: "shared-model",
    models: [{
      id: "shared-model",
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["off"],
      defaultThinkingLevel: "off",
    }],
  });
  await hostA.call("configSync.syncNow", {}, 120_000);

  const configuredB = await hostB.call(
    "configSync.configure",
    syncConfig(fixture.endpoint, "Device B", WEBDAV_PASSWORD),
    120_000,
  );
  assert.equal(configuredB.configured, true);
  assert.equal(configuredB.endpoint, fixture.endpoint);

  const reusedPasswordB = await hostB.call(
    "configSync.configure",
    syncConfig(fixture.endpoint, "Device B", undefined, ""),
    120_000,
  );
  assert.equal(reusedPasswordB.configured, true);

  let stateB = await hostB.call("configSync.syncNow", {}, 120_000);
  assert.ok(
    stateB.pendingApprovals.some((item) => item.entityId.includes(sharedProvider.id)),
    `device B should stage device A's provider for local approval (provider=${sharedProvider.id}, pending=${JSON.stringify(
      stateB.pendingApprovals.map((item) => ({
        entityId: item.entityId,
        label: item.label,
        reason: item.reason,
      })),
    )})`,
  );
  stateB = await approveAll(hostB, stateB);
  assert.equal(stateB.pendingApprovals.length, 0);

  const providersB = await hostB.call("providers.list", { includeDisabled: true });
  assert.ok(
    providersB.providers.some((provider) => provider.name === "Shared provider"),
    "approved provider should be available on device B",
  );

  await hostB.call("settings.set", { theme: "light" });
  const stateAfterLocalEdit = await hostB.call("configSync.syncNow", {}, 120_000);
  assert.ok(["upToDate", "localChangesPending"].includes(stateAfterLocalEdit.status));
  const stateA = await hostA.call("configSync.syncNow", {}, 120_000);
  assert.notEqual(stateA.status, "error");

  const immutableFiles = [...fixture.state.objects.keys()].filter(
    (path) => path.includes("/revisions/") || path.includes("/objects/"),
  );
  assert.ok(
    immutableFiles.length > 0,
    "WebDAV should contain encrypted immutable files",
  );
  const remotePayloads = [...fixture.state.objects.values()].map(({ body }) => body.toString("utf8"));
  assert.ok(
    remotePayloads.every((payload) => !payload.includes("Shared provider")),
    "WebDAV payloads must not expose provider labels in plaintext",
  );
  assert.ok(
    remotePayloads.every((payload) => !payload.includes("fixture-provider-secret")),
    "WebDAV payloads must not expose provider secrets in plaintext",
  );
  assert.ok(
    fixture.state.requests.some(({ method }) => method === "PROPFIND"),
    "fixture should observe WebDAV capability/listing requests",
  );
  console.log(
    "CONFIG_SYNC_MULTIDEVICE " +
      JSON.stringify({
        endpoint: fixture.endpoint,
        devices: 2,
        providerId: sharedProvider.id,
        remoteObjects: immutableFiles.length,
        requests: fixture.state.requests.length,
        statusA: stateA.status,
        statusB: stateAfterLocalEdit.status,
      }),
  );
} finally {
  await Promise.all([hostA.stop(), hostB.stop()]).catch(() => undefined);
  await fixture.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
  if (previousAgentsDir === undefined) delete process.env.PI_DESKTOP_AGENTS_DIR;
  else process.env.PI_DESKTOP_AGENTS_DIR = previousAgentsDir;
}
