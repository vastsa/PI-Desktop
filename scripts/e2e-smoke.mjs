#!/usr/bin/env node
/**
 * PI-Desktop e2e smoke tests (headless protocol-level).
 * Covers host-core RPC, tools, secrets, plugins, and optional live model chat.
 *
 * Env:
 *  PI_DESKTOP_TEST_BASE_URL
 *  PI_DESKTOP_TEST_MODEL
 *  PI_DESKTOP_TEST_API_KEY
 *  PI_DESKTOP_HOST_BIN (optional)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { readNdjsonLines } from "../packages/shared/dist/ndjson.js";
import {
  loadDevelopmentPlugin,
  resolvePluginExecution,
  waitForPluginExecution,
} from "./e2e/plugin.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const hostBinCandidates = [];
const configuredHostBin = process.env.PI_DESKTOP_HOST_BIN?.trim();
if (configuredHostBin) {
  const configured = resolve(configuredHostBin);
  hostBinCandidates.push(configured);
  if (process.platform === "win32" && !configured.toLowerCase().endsWith(".exe")) {
    hostBinCandidates.push(`${configured}.exe`);
  }
}
const hostBinaryName = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
hostBinCandidates.push(join(root, "target", "debug", hostBinaryName));
hostBinCandidates.push(join(root, "..", "..", "..", "target", "debug", hostBinaryName));
const hostBin = hostBinCandidates.find((candidate) => existsSync(candidate));

const BASE_URL = process.env.PI_DESKTOP_TEST_BASE_URL || "https://api.oj.ink/v1";
const MODEL = process.env.PI_DESKTOP_TEST_MODEL || "mimo-v2.5";
const API_KEY = process.env.PI_DESKTOP_TEST_API_KEY || "";

if (!hostBin) {
  console.error("host binary missing; tried:", hostBinCandidates.join(", "));
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-"));
const results = [];

function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
}

function skip(id, detail) {
  results.push({ id, ok: true, skipped: true, detail });
  console.log(`SKIP ${id} — ${detail}`);
}

// The Host stores a project path in its canonical spelling
// (`db::canonical_project_path`): the directory is resolved and the separators are
// normalized, so `projects.list` reports forward slashes on every platform.
// Compare list output against that spelling — a native `realpathSync` path never
// equals it on Windows, which is how the project "removed / still there" clauses
// passed for the wrong reason.
const storedProjectPath = (path) => realpathSync(path).replace(/\\/g, "/");

class Host {
  constructor(bin, dataDir) {
    if (process.env.DEBUG_HOST) {
      console.error(`[e2e host] spawn ${bin} dataDir=${dataDir}`);
    }
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
    });
    this.pending = new Map();
    this.notifications = [];
    this.child.stderr.on("data", (b) => {
      // keep quiet unless debugging
      if (process.env.DEBUG_HOST) process.stderr.write(b);
    });
    readNdjsonLines(this.child.stdout, (line) => {
      if (process.env.DEBUG_HOST) console.error(`[e2e host stdout] ${line}`);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(String(msg.id));
        if (p) {
          this.pending.delete(String(msg.id));
          if (msg.error) p.reject(msg.error);
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.child.on("exit", (code, signal) => {
      if (process.env.DEBUG_HOST) {
        console.error(`[e2e host] exit code=${code} signal=${signal}`);
      }
      for (const pending of this.pending.values()) {
        pending.reject({ message: `host exited code=${code} signal=${signal}` });
      }
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject({ message: `timeout ${method}` });
        }
      }, 30_000);
    });
  }
  async dispose() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await exited;
    }
  }
}

async function main() {
  const host = new Host(hostBin, dataDir);
  try {
    // E2E-003 host health / handshake
    const hs = await host.call("app.handshake", {
      protocolVersion: PROTOCOL_VERSION,
    });
    record(
      "E2E-003-handshake",
      hs.protocolVersion === PROTOCOL_VERSION,
      `v=${hs.protocolVersion}`,
    );
    const health = await host.call("app.health");
    record("E2E-003-health", health.ok === true, `uptime=${health.uptimeMs}`);

    const sample = join(root, "examples/fixtures/sample-project");
    await host.call("workspace.set", { path: sample });

    // provider + secret
    const created = await host.call("providers.create", {
      name: "E2E Provider",
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: BASE_URL,
      authKind: "api_key_and_base_url",
      defaultModelId: MODEL,
      secretValue: API_KEY || "test-key-not-for-live",
      apiStyle: "chat_completions",
    });
    record(
      "E2E-005-provider",
      created.provider?.hasSecret === true && !("secretValue" in created.provider),
      created.provider?.id,
    );

    // list providers must not leak secret
    const listed = await host.call("providers.list", { includeDisabled: true });
    const leaked = JSON.stringify(listed).includes(API_KEY) && API_KEY.length > 8;
    record("E2E-027-no-secret-leak-list", !leaked);

    // session persistence
    const session = await host.call("session.create", {
      title: "E2E session",
      mode: "agent",
      providerId: created.provider.id,
      modelId: MODEL,
      projectPath: sample,
    });
    await host.call("session.appendMessage", {
      sessionId: session.session.id,
      message: {
        id: randomUUID(),
        role: "user",
        content: "hello",
        createdAt: new Date().toISOString(),
        status: "complete",
      },
    });
    const got = await host.call("session.get", { id: session.session.id });
    record(
      "E2E-020-session-persist",
      got.session?.messages?.length === 1,
      `messages=${got.session?.messages?.length}`,
    );

    // Durable notification lifecycle: terminal turns create one inbox item,
    // read state mutates in place, and clear removes the retained history.
    const notificationTurn = await host.call("session.beginTurn", {
      sessionId: session.session.id,
      providerId: created.provider.id,
      modelId: MODEL,
    });
    const ended = await host.call("session.endTurn", {
      turnId: notificationTurn.turnId,
      status: "completed",
    });
    const notificationList = await host.call("notification.list", { limit: 20 });
    const notification = notificationList.notifications?.[0];
    record(
      "E2E-035-notification-created",
      ended.notification?.id === notification?.id &&
        notification?.kind === "task.completed" &&
        notificationList.unreadCount === 1,
      notification?.id,
    );
    const visibleTurn = await host.call("session.beginTurn", {
      sessionId: session.session.id,
      providerId: created.provider.id,
      modelId: MODEL,
    });
    const visibleEnded = await host.call("session.endTurn", {
      turnId: visibleTurn.turnId,
      status: "completed",
      createNotification: false,
    });
    const afterVisible = await host.call("notification.list", { limit: 20 });
    record(
      "E2E-064-visible-notification-suppressed",
      visibleEnded.ok === true &&
        visibleEnded.notification === undefined &&
        afterVisible.notifications?.length === 1 &&
        afterVisible.unreadCount === 1,
    );
    await host.call("notification.markRead", { id: notification?.id });
    const readList = await host.call("notification.list", { unreadOnly: true });
    record(
      "E2E-035-notification-read",
      readList.unreadCount === 0 && readList.notifications?.length === 0,
    );
    await host.call("notification.clear");
    const clearedList = await host.call("notification.list");
    record(
      "E2E-035-notification-clear",
      clearedList.unreadCount === 0 && clearedList.notifications?.length === 0,
    );

    // workspace + tools
    const read = await host.call("tools.execute", {
      sessionId: session.session.id,
      toolCallId: randomUUID(),
      toolName: "Read",
      args: { path: "README.md" },
      mode: "agent",
    });
    record(
      "E2E-013-read-tool",
      read.ok === true && String(read.content?.content || "").includes("Sample Project"),
    );

    const glob = await host.call("tools.execute", {
      sessionId: session.session.id,
      toolCallId: randomUUID(),
      toolName: "Glob",
      args: { pattern: "src/**/*.js" },
      mode: "agent",
    });
    record("E2E-013-glob-tool", glob.ok === true && (glob.content?.count ?? 0) >= 2);

    // External paths require an explicit denial before execution can report
    // the sandbox result. This keeps the smoke harness aligned with the
    // host's permission contract instead of leaving the request pending.
    const escapeToolCallId = randomUUID();
    const escapePending = host.call("tools.execute", {
      sessionId: session.session.id,
      toolCallId: escapeToolCallId,
      toolName: "Read",
      args: { path: "../outside.txt" },
      mode: "agent",
    });
    let escapePermission = null;
    for (let i = 0; i < 100 && !escapePermission; i++) {
      escapePermission = host.notifications.find(
        (notification) =>
          notification.method === "permissions.request" &&
          notification.params?.toolCallId === escapeToolCallId,
      );
      if (!escapePermission) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (escapePermission) {
      await host.call("permissions.resolve", {
        requestId: escapePermission.params.requestId,
        decision: "deny",
      });
    }
    const escape = await escapePending;
    record(
      "E2E-019-path-sandbox",
      escapePermission !== null && escape.ok === false && escape.errorCode === "TOOL_DENIED",
      escape.errorCode || escape.content?.code,
    );

    // Durable Plan mode hard-denies write even when the request forges Agent.
    const planSession = await host.call("session.create", {
      title: "E2E Plan session",
      mode: "plan",
      projectPath: sample,
    });
    const planWrite = await host.call("tools.execute", {
      sessionId: planSession.session.id,
      toolCallId: randomUUID(),
      toolName: "Write",
      args: { path: "x.txt", content: "nope" },
      mode: "agent",
    });
    record(
      "E2E-018-plan-write-denied",
      planWrite.denied === true && planWrite.errorCode === "WRITE_DISABLED_IN_PLAN",
      planWrite.errorCode,
    );

    // plugin load
    const hello = join(root, "examples/plugins/hello");
    const plugin = await loadDevelopmentPlugin(host, hello);
    record(
      "E2E-022-plugin-load",
      plugin.id === "demo.hello" && plugin.enabled === true,
    );

    // E2E-0PLUGIN-I18N: plugin labels follow the pushed app language. The
    // manifest carries both contract locales, and the host — not the renderer —
    // picks the entry, so the row the desktop draws changes with the language
    // while the stored manifest does not.
    {
      const localizedDir = join(dataDir, "labels-i18n");
      mkdirSync(localizedDir, { recursive: true });
      writeFileSync(join(localizedDir, "main.js"), "function onLoad() {}\nfunction onUnload() {}\n");
      writeFileSync(
        join(localizedDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "e2e.labels",
          name: "小清新待办",
          version: "0.1.0",
          description: "作者原话",
          main: "main.js",
          permissions: [],
          i18n: {
            en: { name: "Todo List", description: "A calm todo list" },
            "zh-CN": { name: "小清新待办", description: "轻盈的待办清单" },
          },
        }),
      );
      const loadedRow = await loadDevelopmentPlugin(host, localizedDir);
      const enRow = (await host.call("plugins.list")).plugins.find(
        (candidate) => candidate.id === "e2e.labels",
      );
      await host.call("plugins.setLocale", { locale: "zh-CN" });
      const zhRow = (await host.call("plugins.list")).plugins.find(
        (candidate) => candidate.id === "e2e.labels",
      );
      // A plugin is not required to translate itself into every shell locale:
      // zh-TW reads the English entry rather than half a zh-CN guess (ADR 0182).
      await host.call("plugins.setLocale", { locale: "zh-TW" });
      const twRow = (await host.call("plugins.list")).plugins.find(
        (candidate) => candidate.id === "e2e.labels",
      );
      // `auto` is a setting, not a locale: the desktop shell resolves it, and
      // the host must keep reading the locale it was last given.
      const afterAuto = await host.call("plugins.setLocale", { locale: "auto" });
      await host.call("plugins.setLocale", { locale: "en" });
      record(
        "E2E-0PLUGIN-I18N",
        loadedRow.name === "Todo List" &&
          enRow?.description === "A calm todo list" &&
          zhRow?.name === "小清新待办" &&
          zhRow?.description === "轻盈的待办清单" &&
          twRow?.name === "Todo List" &&
          afterAuto?.locale === "zh-TW" &&
          enRow !== undefined &&
          !("i18n" in enRow),
        `en=${enRow?.name} zh=${zhRow?.name} zh-TW=${twRow?.name}`,
      );
    }

    // E2E-024: plugin agent tool dispatch roundtrip. The smoke harness acts
    // as the desktop runner: host emits plugins.execute, we answer via
    // plugins.resolveExecution, and tools.execute returns the plugin result.
    {
      const toolName = "plugin_demo_hello_echo_text";
      const dispatchP = host.call("tools.execute", {
        sessionId: session.session.id,
        toolCallId: randomUUID(),
        toolName,
        declaredRisk: "low",
        args: { text: "roundtrip" },
        mode: "agent",
      });
      // wait for the plugins.execute notification and answer it
      const execNote = await waitForPluginExecution(host, toolName);
      if (execNote) {
        await resolvePluginExecution(host, execNote, {
          ok: true,
          content: { echo: String(execNote.params.args?.text || "") },
        });
      }
      const dispatched = await dispatchP;
      record(
        "E2E-024-plugin-tool-dispatch",
        Boolean(execNote) &&
          dispatched.ok === true &&
          dispatched.content?.echo === "roundtrip",
        execNote ? `echo=${dispatched.content?.echo}` : "no plugins.execute notification",
      );
    }

    await host.call("plugins.disable", { id: "demo.hello" });
    const plugins = await host.call("plugins.list");
    const disabled = plugins.plugins.find((p) => p.id === "demo.hello");
    record("E2E-025-plugin-disable", disabled?.enabled === false);

    // onboarding
    const onboarding = await host.call("app.getOnboarding");
    record(
      "E2E-004-onboarding",
      Array.isArray(onboarding.steps) && onboarding.steps.length >= 4,
    );

    // Project removal coverage (E2E-PROJECT-delete-*). The on-disk layout is
    // derived from host-core instead of guessed: per-session transcripts are
    // `<data>/sessions/<id>.jsonl` (crates/host-core/src/transcripts.rs
    // `base_dir` + `path_for`), scratch dirs are `<data>/scratch/<id>`
    // (crates/host-core/src/scratch.rs `session_dir`), and review dirs are
    // `<data>/review-changes/<id>` (crates/host-core/src/review.rs `REVIEW_DIR`
    // + `session_review_dir`).
    const transcriptPathFor = (sessionId) =>
      join(dataDir, "sessions", `${sessionId}.jsonl`);
    const scratchDirFor = (sessionId) => join(dataDir, "scratch", sessionId);
    const reviewDirFor = (sessionId) =>
      join(dataDir, "review-changes", sessionId);
    const walkDataDir = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? [path, ...walkDataDir(path)] : [path];
      });
    // Layout-agnostic safety net: every path under the data dir whose own name
    // carries a session id is per-session state the delete path must own.
    const sessionArtifacts = (sessionIds) =>
      walkDataDir(dataDir).filter((path) =>
        sessionIds.some((id) => path.includes(id)),
      );

    // E2E-PROJECT-delete-removes-project-and-owned-sessions — removing a
    // project drops its durable row plus every session attached to it, their
    // per-session files, and its durable memory; the folder stays on disk.
    // Projects are registered with `projects.create` (the file's `workspace.set`
    // style would also rebind the active workspace used by earlier scenarios).
    {
      const removedProjectDir = join(dataDir, "e2e-project-removed");
      const keptProjectDir = join(dataDir, "e2e-project-kept");
      mkdirSync(removedProjectDir, { recursive: true });
      mkdirSync(keptProjectDir, { recursive: true });
      await host.call("projects.create", { path: removedProjectDir });
      await host.call("projects.create", { path: keptProjectDir });
      // projects.list stores the canonical spelling (db.rs canonical_project_path).
      // Keep the request paths platform-native, the way a real client sends them,
      // and compare list output against the stored spelling (`storedProjectPath`).
      const removedProjectStored = storedProjectPath(removedProjectDir);
      const keptProjectStored = storedProjectPath(keptProjectDir);
      const removedProjectPath = realpathSync(removedProjectDir);
      const keptProjectPath = realpathSync(keptProjectDir);

      const deletedSessionIds = [];
      for (const title of ["E2E removed session 1", "E2E removed session 2"]) {
        const bound = await host.call("session.create", {
          title,
          mode: "agent",
          projectPath: removedProjectPath,
        });
        deletedSessionIds.push(bound.session.id);
        await host.call("session.appendMessage", {
          sessionId: bound.session.id,
          message: {
            id: randomUUID(),
            role: "user",
            content: "hello",
            createdAt: new Date().toISOString(),
            status: "complete",
          },
        });
      }
      const keptSession = await host.call("session.create", {
        title: "E2E kept session",
        mode: "agent",
        projectPath: keptProjectPath,
      });
      const savedMemory = await host.call("project.memory.set", {
        path: removedProjectPath,
        content: "Use the staging database.",
      });

      // Create the per-session side data the delete path owns, so the absence
      // checks below cannot pass vacuously.
      for (const id of deletedSessionIds) {
        const scratch = scratchDirFor(id);
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, "draft.txt"), "scratch");
        const review = reviewDirFor(id);
        mkdirSync(review, { recursive: true });
        writeFileSync(join(review, "artifact.txt"), "review");
      }
      const transcriptsBefore = deletedSessionIds.map(transcriptPathFor);
      // Captured now: the record() condition below runs after the removal.
      const transcriptsExistedBefore = transcriptsBefore.every((path) =>
        existsSync(path),
      );
      const artifactsBefore = sessionArtifacts(deletedSessionIds);

      const removal = await host.call("projects.remove", {
        path: removedProjectPath,
      });
      const projectsAfter = await host.call("projects.list");
      const sessionsAfter = await host.call("session.list");
      const memoryAfter = await host.call("project.memory.get", {
        path: removedProjectPath,
      });
      const artifactsAfter = sessionArtifacts(deletedSessionIds);
      record(
        "E2E-PROJECT-delete-removes-project-and-owned-sessions",
        transcriptsExistedBefore &&
          savedMemory.memory?.content === "Use the staging database." &&
          artifactsBefore.length >= deletedSessionIds.length * 3 &&
          removal.removed === true &&
          removal.sessionsRemoved === 2 &&
          projectsAfter.projects.every(
            (project) => project.path !== removedProjectStored,
          ) &&
          projectsAfter.projects.some(
            (project) => project.path === keptProjectStored,
          ) &&
          sessionsAfter.sessions.every(
            (session) => !deletedSessionIds.includes(session.id),
          ) &&
          sessionsAfter.sessions.some(
            (session) => session.id === keptSession.session.id,
          ) &&
          String(memoryAfter.memory?.content ?? "") === "" &&
          transcriptsBefore.every((path) => !existsSync(path)) &&
          artifactsAfter.length === 0 &&
          existsSync(removedProjectDir),
        `removed=${removal.removed} sessionsRemoved=${removal.sessionsRemoved} artifacts=${artifactsBefore.length}->${artifactsAfter.length}`,
      );
    }

    // E2E-PROJECT-delete-removes-project-and-owned-sessions (running refusal) —
    // a project with a
    // running turn is refused with CONFLICT and nothing is deleted; the same
    // call succeeds once that turn ends.
    {
      const busyProjectDir = join(dataDir, "e2e-project-busy");
      mkdirSync(busyProjectDir, { recursive: true });
      await host.call("projects.create", { path: busyProjectDir });
      const busyProjectPath = realpathSync(busyProjectDir);
      const busyProjectStored = storedProjectPath(busyProjectDir);
      const busySession = await host.call("session.create", {
        title: "E2E busy session",
        mode: "agent",
        projectPath: busyProjectPath,
      });
      const turn = await host.call("session.beginTurn", {
        sessionId: busySession.session.id,
      });

      let refusal = null;
      try {
        await host.call("projects.remove", { path: busyProjectPath });
      } catch (error) {
        refusal = error;
      }
      const projectsWhileBusy = await host.call("projects.list");
      const sessionsWhileBusy = await host.call("session.list");
      const refusedWhileBusy =
        refusal?.code === 1008 && refusal?.data?.errorCode === "CONFLICT";
      const nothingDeleted =
        projectsWhileBusy.projects.some(
          (project) => project.path === busyProjectStored,
        ) &&
        sessionsWhileBusy.sessions.some(
          (session) => session.id === busySession.session.id,
        );

      await host.call("session.endTurn", {
        turnId: turn.turnId,
        status: "completed",
      });
      const idleRemoval = await host.call("projects.remove", {
        path: busyProjectPath,
      });
      record(
        "E2E-PROJECT-delete-removes-project-and-owned-sessions-refuses-while-running",
        refusedWhileBusy &&
          nothingDeleted &&
          idleRemoval.removed === true &&
          idleRemoval.sessionsRemoved === 1,
        `refused=${refusal?.code}/${refusal?.data?.errorCode ?? "none"} then removed=${idleRemoval.removed} sessionsRemoved=${idleRemoval.sessionsRemoved}`,
      );
    }

    // E2E-PROJECT-delete-removes-project-and-owned-sessions (unknown path) — a
    // blank path is invalid,
    // a path with no durable row is a no-op.
    {
      let blankError = null;
      try {
        await host.call("projects.remove", { path: "   " });
      } catch (error) {
        blankError = error;
      }
      const missing = await host.call("projects.remove", {
        path: join(dataDir, "e2e-project-missing"),
      });
      record(
        "E2E-PROJECT-delete-removes-project-and-owned-sessions-unknown-path",
        blankError?.code === 1002 &&
          blankError?.data?.errorCode === "INVALID_PARAMS" &&
          missing.removed === false &&
          missing.sessionsRemoved === 0,
        `blank=${blankError?.code}/${blankError?.data?.errorCode ?? "none"} missing=${missing.removed}/${missing.sessionsRemoved}`,
      );
    }

    // live model test (optional if key present)
    if (API_KEY) {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with exactly the word: pong",
            },
          ],
          max_tokens: 16,
          stream: false,
        }),
      });
      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content || "";
      record(
        "E2E-008-live-model",
        res.ok && content.toLowerCase().includes("pong"),
        content.slice(0, 80),
      );

      // streaming
      const streamRes = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "Say hi in one word" }],
          max_tokens: 16,
          stream: true,
        }),
      });
      const text = await streamRes.text();
      record(
        "E2E-009-stream",
        streamRes.ok && text.includes("data:"),
        `bytes=${text.length}`,
      );
    } else {
      skip("E2E-008-live-model", "PI_DESKTOP_TEST_API_KEY not set");
      skip("E2E-009-stream", "PI_DESKTOP_TEST_API_KEY not set");
    }

    // E2E-SESSION-revision-round-trip — a regenerate branch that is still live
    // is a reference on disk, not a second copy of a transcript suffix the
    // session already holds. The reference resolves to the branch as it stands,
    // including messages appended after the reference was written; the branch is
    // stored in full only once it leaves the transcript; and both variants
    // restore through `session.activateRevision`.
    {
      const bound = await host.call("session.create", {
        title: "E2E revision round trip",
        mode: "agent",
      });
      const sessionId = bound.session.id;
      const revisionsPath = join(dataDir, "sessions", `${sessionId}.revisions.jsonl`);
      const readRevisions = () =>
        existsSync(revisionsPath)
          ? readFileSync(revisionsPath, "utf8")
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
          : [];
      const append = (message) =>
        host.call("session.appendMessage", { sessionId, message });
      const user = (id, text, rootId, count, active) => ({
        id,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        status: "complete",
        revisionRootId: rootId,
        revisionCount: count,
        activeRevision: active,
      });
      const assistant = (id, text) => ({
        id,
        role: "assistant",
        content: text,
        createdAt: new Date().toISOString(),
        status: "complete",
      });
      const ids = (messages) => messages.map((message) => message.id);

      // One live branch, archived twice: the second archive must refresh the
      // reference, not mint a variant.
      const first = randomUUID();
      const firstAnswer = randomUUID();
      const laterAnswer = randomUUID();
      await append(user(first, "first prompt", first, 1, 1));
      await append(assistant(firstAnswer, "first answer"));
      const archived = await host.call("session.saveActiveRevision", { sessionId });
      await append(assistant(laterAnswer, "a later answer on the same branch"));
      const refreshed = await host.call("session.saveActiveRevision", { sessionId });

      const references = readRevisions().filter((line) => line.type === "revision_live");
      const listed = await host.call("session.listRevisions", {
        sessionId,
        rootUserId: first,
      });
      const restored = await host.call("session.activateRevision", {
        sessionId,
        rootUserId: first,
        revisionIndex: 1,
        prefix: [],
      });

      // A regenerate of that prompt discards the second turn, which takes the
      // branch out of the transcript: it has to be stored in full first.
      const second = randomUUID();
      const secondAnswer = randomUUID();
      await append(user(second, "second prompt", first, 2, 2));
      await append(assistant(secondAnswer, "second answer"));
      await host.call("session.saveActiveRevision", { sessionId });
      const truncated = await host.call("session.truncateFrom", {
        sessionId,
        fromMessageId: second,
      });
      const storedForSecond = readRevisions().filter(
        (line) => line.type === "revision" && line.revisionIndex === 2,
      );
      const backToFirst = await host.call("session.activateRevision", {
        sessionId,
        rootUserId: first,
        revisionIndex: 1,
        prefix: [],
      });
      const backToSecond = await host.call("session.activateRevision", {
        sessionId,
        rootUserId: first,
        revisionIndex: 2,
        prefix: [],
      });

      const checks = {
        "archives the live branch as revision 1": archived.saved?.activeRevision === 1,
        "a second archive refreshes instead of minting": refreshed.saved?.archived === false,
        "still one variant after the refresh": refreshed.saved?.revisionCount === 1,
        "the live branch was written as a reference": references.length >= 2,
        "the reference carries no payload": references.every(
          (line) => !("messages" in line) && !("turns" in line),
        ),
        "the reference does not grow with the branch": references.every(
          (line) => JSON.stringify(line).length < 200,
        ),
        "one variant is listed": listed.revisions.length === 1,
        "it counts the whole live branch": listed.revisions[0]?.messageCount === 3,
        "the reference resolves to the branch as it stands": ids(restored.messages).join() ===
          [first, firstAnswer, laterAnswer].join(),
        "the regenerate discarded the second turn": truncated.discardedCount === 2,
        "the branch that left is stored in full": storedForSecond.some(
          (line) => (line.messages ?? []).length === 2,
        ),
        "variant 2 restores its own messages":
          ids(backToSecond.messages).join() === [second, secondAnswer].join(),
        "variant 1 restores the grown branch":
          ids(backToFirst.messages).join() === [first, firstAnswer, laterAnswer].join(),
      };
      const failed = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      record(
        "E2E-SESSION-revision-round-trip",
        failed.length === 0,
        failed.length === 0
          ? `refs=${references.length} stored=${storedForSecond.length} v1=3 v2=2`
          : `failed: ${failed.join("; ")}`,
      );
    }

    // agent-runtime unit-ish import check
    try {
      await import(pathToFileURL(join(root, "packages/agent-runtime/dist/index.js")).href);
      record("E2E-runtime-module", true);
    } catch (e) {
      record("E2E-runtime-module", false, String(e));
    }
  } catch (e) {
    record("E2E-fatal", false, e?.message || String(e));
  } finally {
    await host.dispose();
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  const executed = results.length - skipped.length;
  console.log(
    "\nSummary:",
    executed - failed.length,
    "/",
    executed,
    "passed;",
    skipped.length,
    "skipped",
  );
  if (failed.length) {
    process.exitCode = 1;
  }
}

main();
