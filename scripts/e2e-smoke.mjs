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
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";

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
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
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
    const plugin = await host.call("plugins.loadDev", { path: hello });
    record(
      "E2E-022-plugin-load",
      plugin.plugin?.id === "demo.hello" && plugin.plugin?.enabled === true,
    );

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
      let execNote = null;
      for (let i = 0; i < 100 && !execNote; i++) {
        execNote = host.notifications.find(
          (n) => n.method === "plugins.execute" && n.params?.toolName === toolName,
        );
        if (!execNote) await new Promise((r) => setTimeout(r, 50));
      }
      if (execNote) {
        await host.call("plugins.resolveExecution", {
          executionId: execNote.params.executionId,
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
