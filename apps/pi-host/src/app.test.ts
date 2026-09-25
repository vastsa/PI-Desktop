import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({ boundServer: undefined as unknown }));

vi.mock("@pi-desktop/agent-host", () => ({
  AgentHost: class {
    readonly policy: unknown;
    constructor(options: { policy?: unknown }) {
      this.policy = options.policy;
    }
    async start(): Promise<void> {}
  },
}));

vi.mock("@pi-desktop/host-runtime", () => ({
  AgentSidecar: class {
    onExit(_listener: unknown): void {}
    setProjectInstructionResolver(_resolver: unknown): void {}
    setLocalTool(_name: string, _handler: unknown): void {}
    setTrustedExtensionBridge(_bridge: unknown): void {}
    setHost(_host: unknown): void {}
    clearProjectInstructionRoot(_sessionId: string): void {}
    async call(_method: string, _params?: unknown): Promise<unknown> {}
    async dispose(): Promise<void> {}
  },
  HostProcess: class {
    readonly generation = 1;
    onExit(_listener: unknown): void {}
    async handshake(): Promise<void> {}
    async call(_method: string, _params?: unknown): Promise<unknown> {}
    async dispose(): Promise<void> {}
  },
  PlanExecutionDispatcher: class {
    constructor(_options: unknown) {}
    async drainApprovedPlanExecutions(): Promise<void> {}
    dispose(): void {}
  },
  RemoteToolRelay: class {},
  RuntimeService: class {
    constructor(_options: unknown) {}
    onEvent(_listener: unknown): void {}
    onTurnEnded(_listener: unknown): void {}
    attachHost(_host: unknown): void {}
    attachSidecar(_sidecar: unknown): void {}
    async abort(_sessionId: string, _turnId: string): Promise<void> {}
    async dispose(): Promise<void> {}
  },
  RuntimeSupervisor: class {
    constructor(_options: unknown) {}
  },
  createHeadlessLaunchResolver: () => () => undefined,
  createHostQueueStore: () => ({}),
  createHostSessionPort: () => ({}),
  listPendingToolRequests: () => [],
}));

vi.mock("@pi-desktop/racp", () => ({
  DeviceTokenAuthenticator: class {
    constructor(_store: unknown) {}
  },
  RacpServer: class {
    readonly policy: unknown;
    constructor(options: { policy?: unknown }) {
      this.policy = options.policy;
    }
    close(): void {}
  },
  bindRacpWebSocket: async (options: { server: unknown }) => {
    startup.boundServer = options.server;
    return {
      address: { host: "127.0.0.1", port: 41_234 },
      async close(): Promise<void> {},
    };
  },
}));

vi.mock("./admin-socket.js", () => ({
  startAdminSocket: async () => ({ async close(): Promise<void> {} }),
}));

vi.mock("./terminal.js", () => ({ loadPty: () => undefined }));

import { startPiHost } from "./app.js";
import { resolveConfig } from "./config.js";
import type { HostLogger } from "./logger.js";

const dataDirs: string[] = [];
afterEach(async () => {
  for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  startup.boundServer = undefined;
});

function testLog(): HostLogger {
  return Object.assign(
    (_level: "info" | "warn" | "error", _message: string, _data?: Record<string, unknown>) => {},
    { child: (_channel: string) => (_text: string) => {} },
  );
}

describe("pi-host startup policy wiring", () => {
  it("passes the configured policy to the RACP server", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-host-policy-test-"));
    dataDirs.push(dataDir);
    const config = resolveConfig({
      "data-dir": dataDir,
      "host-core": "/unused/host-core",
      sidecar: "/unused/sidecar.js",
      "remote-max-permission-mode": "ask",
      "apply-ceiling-to-paired-devices": "true",
      "approval-lifetime-ms": "45000",
    }, {});
    const expectedPolicy = {
      remoteMaxPermissionMode: "ask",
      applyCeilingToPairedDevices: true,
      approvalLifetimeMs: 45_000,
    };

    const app = await startPiHost(config, { log: testLog() });
    try {
      expect(config.policy).toEqual(expectedPolicy);
      expect(app.agentHost.policy).toEqual(expectedPolicy);
      expect(app.server.policy).toEqual(expectedPolicy);
      expect(startup.boundServer).toBe(app.server);
    } finally {
      await app.stop();
    }
  });
});
