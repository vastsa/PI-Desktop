import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PASSWORD = "portable-backup-password";
export const MARKERS = ["S3 shared provider", "fixture-provider-secret", "S3 fixture instructions", "resource-first", "resource-updated", "fixture-mcp-secret"];
const categories = Object.fromEntries(["application", "providers", "credentials", "mcp", "skills", "subagents", "instructions", "plugins", "automation"].map((name) => [name, true]));
export const rpc = (host, method, params = {}) => host.call(method, params, 120_000);
const sync = (host) => rpc(host, "configSync.syncNow");
const settings = (host) => rpc(host, "settings.get");
const provider = async (host, id) => (await rpc(host, "providers.get", { id })).provider;

export function config(connection, deviceLabel, extra = {}) {
  return { ...connection, deviceLabel, backupPassword: PASSWORD, categories: { ...categories, memory: false }, includeSecrets: true, includeMemory: false, automaticSync: false, mode: "sync", ...extra };
}

export async function approveAll(host, state, projectPath) {
  let next = state;
  for (let n = 0; next.pendingApprovals.length; n += 1) {
    assert.ok(n < 64, "approvals must converge");
    const item = next.pendingApprovals[0];
    assert.notEqual(item.reason, "conflict", "conflicts require an explicit choice");
    if (item.mappingKey) {
      assert.ok(projectPath, "mapped capability requires a local path");
      await rpc(host, "configSync.mapProject", { logicalId: item.mappingKey, paths: [projectPath] });
    }
    next = await rpc(host, "configSync.approve", { approvalId: item.id, digest: item.digest });
  }
  return next;
}

async function choose(host, state, suffix) {
  const item = state.pendingApprovals.find((value) => value.reason === "conflict" && value.entityId.endsWith(suffix));
  assert.ok(item, `missing explicit ${suffix} conflict candidate`);
  return rpc(host, "configSync.approve", { approvalId: item.id, digest: item.digest });
}

export async function runSyncJourney({ a, b, connection, store, step }) {
  const configA = config(connection, "Device A");
  const configB = config(connection, "Device B", { includeSecrets: false });
  step("configure-and-credential-reuse");
  assert.deepEqual(await rpc(a, "configSync.test", configA), { ok: true, conditionalWrites: true });
  assert.equal((await rpc(a, "configSync.configure", configA)).mode, "sync");
  const { secretAccessKey: _secret, sessionToken: _token, ...reuse } = configA;
  assert.equal((await rpc(a, "configSync.configure", { ...reuse, backupPassword: "" })).configured, true);
  await rpc(a, "settings.set", { theme: "light", language: "en", networkPolicy: { mode: "strict" } });
  // Strict mode is device-local. Local HTTP is tested under relaxed policy only.
  if (connection.endpoint.startsWith("http:")) await rpc(a, "settings.set", { networkPolicy: { mode: "relaxed" } });
  await sync(a);
  const { provider: shared } = await rpc(a, "providers.create", {
    name: MARKERS[0], vendorKey: "s3-fixture", type: "openai_compatible", protocol: "openai_compatible",
    authKind: "api_key_and_base_url", secretValue: MARKERS[1], baseUrl: "http://127.0.0.1:9/v1", models: [],
  });
  await rpc(b, "settings.set", { theme: "light", language: "en" });
  await sync(a);
  await rpc(b, "configSync.configure", configB);
  step("new-device-approval-and-credential-opt-out");
  let state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.entityId.includes(shared.id)));
  assert.equal(await provider(b, shared.id), null, "provider must not appear before approval");
  state = await approveAll(b, state);
  assert.equal((await provider(b, shared.id)).hasSecret, false);
  assert.equal((await provider(b, shared.id)).enabled, false);
  assert.equal((await provider(a, shared.id)).hasSecret, true);
  assert.equal((await settings(b)).theme, "light");
  assert.equal((await settings(b)).networkPolicy.mode, "relaxed", "local policy is not synchronized");
  step("mcp-approval-and-credential-opt-out");
  await rpc(a, "mcp.upsert", { id: "s3-mcp", label: "S3 fixture MCP", level: "global", transport: "stdio", command: "never-execute-this-fixture", env: { API_KEY: MARKERS[5] }, enabled: false });
  await sync(a);
  state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.domain === "mcp"));
  assert.equal((await rpc(b, "mcp.list", { level: "global" })).servers.length, 0);
  await approveAll(b, state);
  const importedMcp = (await rpc(b, "mcp.list", { level: "global" })).servers.find((item) => item.id === "s3-mcp");
  assert.ok(importedMcp);
  assert.deepEqual(importedMcp.env ?? {}, {});
  assert.deepEqual(importedMcp.headers ?? {}, {});
  assert.equal(importedMcp.enabled, false);
  await rpc(a, "mcp.remove", { id: "s3-mcp", level: "global" });
  await sync(a);
  await approveAll(b, await sync(b));
  await sync(b);
  await sync(a);
  assert.equal((await rpc(b, "mcp.list", { level: "global" })).servers.length, 0);


  step("concurrent-disjoint-edits");
  await rpc(a, "settings.set", { theme: "dark" });
  await rpc(b, "settings.set", { language: "de" });
  await Promise.all([sync(a), sync(b)]);
  await sync(a);
  await sync(b);
  for (const host of [a, b]) {
    const value = await settings(host);
    assert.equal(value.theme, "dark");
    assert.equal(value.language, "de");
    assert.equal((await rpc(host, "configSync.getState")).pendingApprovals.length, 0);
  }

  step("same-entity-conflict-explicit-choice");
  await rpc(a, "settings.set", { theme: "light" });
  await rpc(b, "settings.set", { theme: "system" });
  await sync(a);
  state = await sync(b);
  assert.equal(state.status, "conflict");
  assert.equal((await settings(b)).theme, "system", "unapproved conflict must not overwrite local settings");
  await choose(b, state, ":remote");
  assert.equal((await settings(b)).theme, "light");
  await sync(b);
  await sync(a);

  step("remote-deletion-versus-offline-edit");
  await rpc(b, "providers.update", { id: shared.id, name: "Offline provider edit" });
  await rpc(a, "providers.delete", { id: shared.id });
  await sync(a);
  state = await sync(b);
  assert.equal(state.status, "conflict");
  assert.equal((await provider(b, shared.id)).name, "Offline provider edit");
  await choose(b, state, ":local");
  assert.equal((await provider(b, shared.id)).name, "Offline provider edit");
  await sync(b);
  await approveAll(a, await sync(a));
  assert.equal((await provider(a, shared.id)).name, "Offline provider edit");
  await rpc(a, "providers.delete", { id: shared.id });
  await sync(a);
  await approveAll(b, await sync(b));
  await sync(b);
  await sync(a);
  assert.equal(await provider(b, shared.id), null, "unchanged opted-out receiver must accept deletion");

  step("project-metadata-stays-local");
  const projectA = join(a.dataDir, "project-a");
  const projectB = join(b.dataDir, "project-b");
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  const { group: sourceGroup } = await rpc(a, "project.group.create", { name: "Device A workspace", folders: [projectA] });
  const remoteProjectsBefore = await rpc(b, "projects.list");
  const remoteGroupsBefore = await rpc(b, "project.groups.list");
  await sync(a);
  await approveAll(b, await sync(b));
  assert.deepEqual(await rpc(b, "projects.list"), remoteProjectsBefore, "sync must not register source projects on another device");
  assert.deepEqual(await rpc(b, "project.groups.list"), remoteGroupsBefore, "sync must not create source project groups");
  // Workspace registration is a local user action, independent of sync mappings.
  await rpc(b, "project.group.create", { name: "Device B workspace", folders: [projectB] });
  const localGroups = await rpc(b, "project.groups.list");
  await rpc(a, "project.group.rename", { groupId: sourceGroup.id, name: "Renamed Device A workspace" });

  step("mapped-skill-approval-resource-update-and-deletion");
  const { skill } = await rpc(a, "skills.create", {
    id: "s3-resource-skill", name: "S3 resource skill", level: "project", projectPath: projectA,
    body: MARKERS[2], shape: "dir",
  });
  const source = join(dirname(skill.path), "data.txt");
  await writeFile(source, MARKERS[3]);
  await sync(a);
  state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.mappingKey));
  assert.equal((await rpc(b, "skills.list", { level: "project", projectPath: projectB })).skills.length, 0);
  await approveAll(b, state, projectB);
  const imported = (await rpc(b, "skills.list", { level: "project", projectPath: projectB })).skills.find((item) => item.id === skill.id);
  assert.ok(imported);
  assert.ok(imported.path.startsWith(projectB), "source machine path must not become destination");
  const destination = join(dirname(imported.path), "data.txt");
  assert.equal(await readFile(destination, "utf8"), MARKERS[3]);
  assert.deepEqual(await rpc(b, "project.groups.list"), localGroups, "mapped capability import must preserve device-local group metadata");
  await writeFile(source, MARKERS[4]);
  await sync(a);
  await approveAll(b, await sync(b), projectB);
  assert.equal(await readFile(destination, "utf8"), MARKERS[4]);
  await rpc(a, "skills.remove", { id: skill.id, level: "project", projectPath: projectA });
  await sync(a);
  await approveAll(b, await sync(b), projectB);
  assert.equal((await rpc(b, "skills.list", { level: "project", projectPath: projectB })).skills.length, 0);
  await sync(b);
  await sync(a);

  await approveAll(a, await sync(a), projectA);
  await approveAll(b, await sync(b), projectB);
  step("sync-restore-publishes-and-survives-restart");
  await rpc(a, "settings.set", { theme: "dark" });
  const oldRevision = (await sync(a)).lastRevisionId;
  await sync(b);
  await rpc(a, "settings.set", { theme: "light" });
  await sync(a);
  await sync(b);
  await assert.rejects(rpc(a, "configSync.restore", { revisionId: oldRevision }), /CONFIG_SYNC_INVALID/);
  const restored = await rpc(a, "configSync.restore", { revisionId: oldRevision, acknowledgePropagation: true });
  assert.notEqual(restored.lastRevisionId, oldRevision);
  await approveAll(a, restored, projectA);
  assert.equal((await settings(a)).theme, "dark");
  await approveAll(b, await sync(b), projectB);
  assert.equal((await settings(b)).theme, "dark");
  const files = await readdir(join(a.dataDir, "config-sync"), { recursive: true });
  assert.ok(files.some((name) => name.includes("recovery")), "restore must create local recovery data");
  await b.restart();
  const restartedState = await rpc(b, "configSync.getState");
  assert.equal(restartedState.configured, true, "Host restart must preserve S3 configuration");
  assert.equal((await settings(b)).theme, "dark");
  await sync(b);
  if (store.failWith) {
    step("temporary-outage-and-retry");
    store.failWith(502);
    await assert.rejects(sync(b), /CONFIG_SYNC_SERVER/);
    assert.equal((await rpc(b, "configSync.getState")).status, "offline");
    store.failWith(null);
    await sync(b);
    assert.equal((await settings(b)).theme, "dark");
  }
  return { projectA, projectB };
}

export async function runBackupJourney({ a, b, c, d, connection, step }) {
  step("backup-isolation-and-local-only-restore");
  const backupConfig = config(connection, "Backup C", { mode: "backup" });
  await rpc(c, "configSync.configure", backupConfig);
  await rpc(c, "settings.set", { theme: "system" });
  const syncHead = (await rpc(a, "configSync.listHistory"))[0].revisionId;
  const first = (await sync(c)).lastRevisionId;
  assert.equal((await settings(c)).theme, "system");
  assert.equal((await rpc(c, "providers.list")).providers.length, 0);
  assert.equal((await sync(c)).lastRevisionId, first, "unchanged backup must not duplicate revisions");
  await rpc(d, "configSync.configure", config(connection, "Backup D", { mode: "backup" }));
  await rpc(d, "settings.set", { theme: "light" });
  const second = (await sync(d)).lastRevisionId;
  assert.notEqual(second, first);
  assert.equal((await settings(d)).theme, "light");
  assert.equal((await sync(c)).lastRevisionId, first, "another device's backup is not merged");
  assert.equal((await settings(c)).theme, "system");
  const history = await rpc(c, "configSync.listHistory");
  assert.equal(history[0].revisionId, second);
  assert.ok(history.some((entry) => entry.revisionId === first));
  await rpc(c, "settings.set", { theme: "dark" });
  await rpc(c, "configSync.restore", { revisionId: first });
  assert.equal((await settings(c)).theme, "system");
  assert.equal((await rpc(c, "configSync.listHistory"))[0].revisionId, second);
  assert.equal((await rpc(a, "configSync.listHistory"))[0].revisionId, syncHead);
  assert.equal((await settings(a)).theme, "dark");

  step("password-rewrap-new-device-and-existing-device");
  const nextPassword = "replacement-backup-password";
  await rpc(a, "configSync.changePassword", { currentPassword: PASSWORD, newPassword: nextPassword });
  await sync(b); // An unlocked peer retains the data key: rewrap is not revocation.
  await rpc(d, "configSync.disconnect");
  await assert.rejects(rpc(d, "configSync.configure", config(connection, "Fresh D")), /CONFIG_SYNC_CRYPTO/);
  await rpc(d, "configSync.configure", config(connection, "Fresh D", { backupPassword: nextPassword, mode: "backup" }));
  assert.equal((await rpc(d, "configSync.getState")).configured, true);
}
