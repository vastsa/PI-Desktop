import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// Deliberately do not inherit credentials, proxies, NODE_OPTIONS, or user config.
export async function isolatedEnv(dir) {
  const home = join(dir, "home");
  const data = join(dir, "data");
  const temp = join(dir, "tmp");
  await Promise.all([home, data, temp].map((path) => mkdir(path, { recursive: true })));
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: data, APPDATA: data, LOCALAPPDATA: data,
    PI_DESKTOP_DATA_DIR: data, PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_SCRATCH_DIR: dir, TMPDIR: temp, TMP: temp, TEMP: temp,
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0",
    NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
    LANG: "en_US.UTF-8", TZ: "UTC",
  };
}

export class OfflineSidecar {
  constructor(child, dir, host, timeoutMs) {
    this.child = child;
    this.dir = dir;
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.events = [];
    this.hostCalls = [];
    this.messages = new Map();
    this.pending = new Map();
    this.stderr = "";
    this.sequence = 0;
    this.closed = false;
    this.stopping = false;
    child.on("error", (error) => this.fail(error));
    this.exit = new Promise((resolve) => child.once("close", (code, signal) => {
      this.closed = true;
      if (!this.stopping) this.fail(new Error(`sidecar exited: ${code ?? signal}`));
      resolve();
    }));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (/unhandled promise rejection|TypeError:|ReferenceError:/.test(this.stderr)) {
        this.fail(new Error(`sidecar stderr: ${this.stderr.slice(-5000)}`));
      }
    });
    child.stdin.on("error", (error) => { if (!this.stopping) this.fail(error); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      void this.receive(line).catch((error) => this.fail(error));
    });
  }

  static async start(bundle, dir, host, timeoutMs) {
    const env = await isolatedEnv(dir);
    const child = spawn(process.execPath, [bundle], {
      cwd: dir, env, stdio: ["pipe", "pipe", "pipe"],
    });
    const sidecar = new OfflineSidecar(child, dir, host, timeoutMs);
    try {
      assert.equal((await sidecar.call("sidecar.health")).ok, true);
      return sidecar;
    } catch (error) {
      await sidecar.stop();
      throw error;
    }
  }

  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  check() { if (this.failure) throw this.failure; }

  send(frame) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  }

  async receive(line) {
    const frame = JSON.parse(line);
    if (frame.method === "host.proxy") {
      const { method, params } = frame.params;
      this.hostCalls.push({ method, params });
      try {
        const result = await this.host(method, params);
        this.send({ id: frame.id, result: result ?? null });
      } catch (error) {
        // Best-effort production RPCs may swallow an error; fail this harness too.
        this.send({ id: frame.id, error: { code: -32601, message: error.message } });
        throw error;
      }
      return;
    }
    if (frame.id !== undefined) {
      const pending = this.pending.get(String(frame.id));
      assert.ok(pending, `unexpected RPC response: ${frame.id}`);
      this.pending.delete(String(frame.id));
      if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)));
      else pending.resolve(frame.result);
      return;
    }
    assert.equal(frame.method, "agent.event", "unexpected sidecar notification");
    const envelope = frame.params;
    this.events.push(envelope);
    const event = envelope.event;
    if (event.type === "message_end") {
      const message = event.message;
      this.messages.set(message.id, message);
      if (message.error) this.fail(new Error(`message error: ${JSON.stringify(message.error)}`));
    }
    if (event.type === "error") this.fail(new Error(`agent error: ${JSON.stringify(event.error)}`));
    if (event.type === "status" && event.status.activity?.phase === "retrying") {
      this.fail(new Error(`unexpected retry: ${JSON.stringify(event.status.activity.error)}`));
    }
  }

  async call(method, params = {}) {
    this.check();
    const id = `offline-${++this.sequence}`;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.fail(new Error(`RPC timeout: ${method}`));
        }, this.timeoutMs);
        this.pending.set(id, { resolve, reject });
        this.send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  async waitFor(predicate, label) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      this.check();
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error(`Timeout: ${label}; events=${this.events.slice(-8).map(({ event }) => event.type).join(",")}`);
  }

  async prompt(params, content) {
    const start = this.events.length;
    const turnId = `${params.sessionId}-turn-${Date.now()}-${++this.sequence}`;
    const userMessageId = `${turnId}-user`;
    // Electron/host normally persist the user row before agent.prompt. The
    // sidecar emits assistant/tool rows, not a duplicate user message_end.
    this.messages.set(userMessageId, {
      id: userMessageId, role: "user", content, status: "complete", createdAt: new Date().toISOString(),
    });
    const result = await this.call("agent.prompt", { ...params, turnId, userMessageId, content });
    assert.equal(result.accepted, true);
    await this.waitFor(() => this.events.slice(start).some((envelope) =>
      envelope.turnId === turnId && envelope.event.type === "agent_end"), `agent_end ${turnId}`);
    await this.waitFor(async () => {
      const { status } = await this.call("agent.getStatus", { sessionId: params.sessionId });
      return status.isRunning === false;
    }, `idle ${turnId}`);
    this.check();
    return this.events.slice(start);
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.closed) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      try { await this.exit; } finally { clearTimeout(timer); }
    }
    this.lines.close();
    this.fail(new Error("sidecar closed"));
    await Promise.all([
      writeFile(join(this.dir, "events.json"), JSON.stringify(this.events, null, 2)),
      writeFile(join(this.dir, "host-rpc.json"), JSON.stringify(this.hostCalls, null, 2)),
      writeFile(join(this.dir, "stderr.log"), this.stderr),
    ]);
  }
}

export function fixtureHost({ history = [], instructions = false } = {}) {
  return async (method, params) => {
    switch (method) {
      case "session.get": return { session: { id: params.id, messages: history } };
      case "project.instructions.resolve": return {
        entries: instructions ? [{
          source: "nested/AGENTS.md",
          content: "OFFLINE_NESTED_RULE: explain the search and local fixture together.",
        }] : [],
      };
      case "tools.execute":
        assert.equal(params.toolName, "Read", "Task must execute inside the real runtime, never fake host");
        assert.equal(params.args.path, "nested/fixture.txt");
        return { ok: true, content: "OFFLINE_READ_RESULT: synthetic local file contents" };
      default: throw new Error(`Unsupported fake-host RPC: ${method}`);
    }
  };
}
