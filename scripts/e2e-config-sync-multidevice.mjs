#!/usr/bin/env node
/** Actual isolated Host processes; local S3 by default, authorized live S3 by opt-in. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { startS3Fixture } from "./e2e/config-sync-s3-fixture.mjs";
import { MARKERS, PASSWORD, rpc, runSyncJourney, runBackupJourney } from "./e2e/config-sync-journey.mjs";

const { values } = parseArgs({ options: { "live-s3": { type: "boolean" }, "env-file": { type: "string" } } });
if (Boolean(values["live-s3"]) !== Boolean(values["env-file"])) throw new Error("Live tests require both --live-s3 and --env-file");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prefix = `pi-desktop-tests/s3-config-sync-${randomUUID()}`;
const binary = resolveHostBinary();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const base = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root });
const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
const dataRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-config-sync-e2e-"));
const hosts = [];
const errors = [];
let store;
let report;
let cleanup;
let currentStep = "setup";
const step = (name) => { currentStep = name; console.log(`CONFIG_SYNC_STEP ${name}`); };
try {
  store = values["live-s3"]
    ? await (await import("./e2e/config-sync-live-s3.mjs")).openLiveS3(values["env-file"], prefix)
    : await startS3Fixture(prefix);
  assert.equal((await store.inventory()).length, 0, "new test namespace must be empty");
  console.log(`CONFIG_SYNC_NAMESPACE ${prefix}`);
  for (const name of ["a", "b", "c", "d"]) {
    const home = join(dataRoot, name, "home");
    await mkdir(home, { recursive: true });
    hosts.push(new Host(binary, join(dataRoot, name, "data"), {
      env: { HOME: home, USERPROFILE: home, PI_DESKTOP_AGENTS_DIR: join(home, "agents"), XDG_CONFIG_HOME: join(home, ".config"), DEBUG_HOST: "" },
      quiet: Boolean(values["live-s3"]),
    }));
  }
  await Promise.all(hosts.map((host) => host.start()));
  await Promise.all(hosts.map((host) => rpc(host, "settings.set", { networkPolicy: { mode: "relaxed" } })));
  const [a, b, c, d] = hosts;
  const context = { a, b, c, d, connection: store.connection, store, step };
  await runSyncJourney(context);
  await runBackupJourney(context);
  step("ciphertext-retention-and-disconnect");
  const inventory = await store.inventory();
  assert.ok(inventory.some((key) => key.includes("/revisions/")));
  assert.ok(inventory.some((key) => key.includes("/objects/")));
  const inspected = await store.inspect([...MARKERS, PASSWORD, store.connection.secretAccessKey, store.connection.sessionToken].filter(Boolean));
  for (const host of hosts) assert.equal((await rpc(host, "configSync.disconnect")).configured, false);
  assert.deepEqual(await store.inventory(), inventory, "disconnect must not delete remote data");
  report = { mode: values["live-s3"] ? "live-s3" : "local-s3", devices: hosts.length, prefix, candidate: revision, base, workingDiff: true, binarySha256, ...inspected };
} catch (error) {
  errors.push(error);
} finally {
  const stopped = await Promise.allSettled(hosts.map((host) => host.stop()));
  for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
  if (store) {
    try {
      assert.ok(stopped.every((result) => result.status === "fulfilled"), "refusing cloud cleanup while a Host may still publish");
      cleanup = await store.cleanup();
      assert.equal(cleanup.remaining, 0);
      assert.equal(cleanup.versions, 0);
    } catch (error) { errors.push(error); }
    try { await store.close(); } catch (error) { errors.push(error); }
  }
  // Retain isolated data if a process could still be using it.
  if (stopped.every((result) => result.status === "fulfilled")) {
    try { await rm(dataRoot, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
}
if (errors.length) {
  // Never print raw live RPC/SDK errors, which may contain endpoint or credential data.
  console.error("CONFIG_SYNC_FAILED " + JSON.stringify({ step: currentStep, prefix, cleanup, binarySha256, failures: errors.length, codes: errors.map((error) => ({ code: /^CONFIG_SYNC_[A-Z_]+$/.test(error.errorCode ?? "") ? error.errorCode : undefined, status: error.safeStatus, actual: ["boolean", "number"].includes(typeof error.actual) ? error.actual : undefined, expected: ["boolean", "number"].includes(typeof error.expected) ? error.expected : undefined, diagnostics: error.message?.match(/CONFIG_SYNC_[A-Z_]+|HTTP \d{3}|probe cleanup could not be verified|SignatureDoesNotMatch|AuthorizationHeaderMalformed|InvalidRequest|InvalidArgument|MissingContentLength|InvalidAccessKeyId|RequestTimeTooSkewed|RequestExpired|InvalidToken|ExpiredToken|AccessDenied|XAmzContentSHA256Mismatch|InvalidHostHeader/g), location: error.stack?.split("\n").find((line) => line.includes("config-sync-journey.mjs:"))?.match(/config-sync-journey\.mjs:\d+:\d+/)?.[0] })) }));
  if (!values["live-s3"]) for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("CONFIG_SYNC_MULTIDEVICE " + JSON.stringify({ ...report, cleanup, result: "passed" }));
}
