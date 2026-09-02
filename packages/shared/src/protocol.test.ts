import { describe, expect, it } from "vitest";
import {
  IPC,
  IPC_WHITELIST,
  PROPOSAL_KINDS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  modeForProposalKind,
  normalizeGlobalPermissionMode,
  normalizeMode,
  normalizeProposalKind,
  proposalKindForMode,
  isCommandShellCatalog,
  isCommandShellOption,
  isGlobalPermissionMode,
  isToolsOutputParams,
  rpcTimeoutMs,
  type PlanExecution,
  type PlanArtifact,
  type PlanResolveRequest,
  type ScheduledTask,
  type CommandShellCatalog,
  type ToolsOutputParams,
} from "./index.js";

describe("Plan protocol contracts", () => {
  it("uses protocol v10/schema v12 and exposes the plan, schedule, and shell channels", () => {
    expect(PROTOCOL_VERSION).toBe(10);
    expect(SCHEMA_VERSION).toBe(12);
    expect(IPC_WHITELIST.has(IPC.invoke.plansPending)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.plansResolve)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.event.plansChanged)).toBe(true);
    expect(IPC.invoke.commandShellList).toBe("pi-desktop/commandShell/list");
    expect(IPC_WHITELIST.has(IPC.invoke.commandShellList)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledList)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledCreate)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledUpdate)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledDelete)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledRun)).toBe(true);
    expect(IPC.invoke.providersRefreshModelCatalog).toBe(
      "pi-desktop/providers/refreshModelCatalog",
    );
    expect(IPC_WHITELIST.has(IPC.invoke.providersRefreshModelCatalog)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.windowSetWorkPanelChatWidth)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.event.windowWorkPanelResize)).toBe(true);
  });

  it("exposes the vendor-account OAuth channels through the preload whitelist", () => {
    expect(IPC.invoke.providersOauthStart).toBe(
      "pi-desktop/providers/oauth/start",
    );
    for (const channel of [
      IPC.invoke.providersOauthVendors,
      IPC.invoke.providersOauthStart,
      IPC.invoke.providersOauthRespond,
      IPC.invoke.providersOauthCancel,
      IPC.invoke.providersOauthDelete,
      IPC.event.providersOauth,
    ]) {
      expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
  });

  it("maps legacy Chat values to Plan while keeping Agent as fallback", () => {
    expect(normalizeMode("chat")).toBe("plan");
    expect(normalizeMode("plan")).toBe("plan");
    expect(normalizeMode("goal")).toBe("goal");
    expect(normalizeMode("agent")).toBe("agent");
    expect(normalizeMode(undefined)).toBe("agent");
  });

  it("pairs each contract mode with its proposal kind and back (D198)", () => {
    expect(PROPOSAL_KINDS).toEqual(["plan", "goal"]);
    expect(proposalKindForMode("plan")).toBe("plan");
    expect(proposalKindForMode("goal")).toBe("goal");
    // Agent negotiates no contract, so it has no kind.
    expect(proposalKindForMode("agent")).toBeNull();
    expect(modeForProposalKind("goal")).toBe("goal");
    expect(modeForProposalKind("plan")).toBe("plan");
    // Rows written before the discriminator existed are Plan by definition.
    expect(normalizeProposalKind(undefined)).toBe("plan");
    expect(normalizeProposalKind("nonsense")).toBe("plan");
    expect(normalizeProposalKind("goal")).toBe("goal");
  });

  it("keeps scheduled mode as a normalized wire projection", () => {
    const task: ScheduledTask = {
      id: "task-1",
      title: "Plan task",
      prompt: "inspect",
      cadence: "manual",
      mode: normalizeMode("chat"),
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(task.mode).toBe("plan");
  });

  it("keeps approval actions and target permission modes typed", () => {
    const request: PlanResolveRequest = {
      proposalId: "proposal-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "exit-call-1",
      action: "approve",
      targetPermissionMode: "accept-edits",
    };
    expect(request).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "exit-call-1",
      action: "approve",
      targetPermissionMode: "accept-edits",
    });
  });

  it("uses durable approval statuses separately from resolution actions", () => {
    const statuses = [
      "pending",
      "approved",
      "rejected",
      "expired",
      "interrupted",
    ] as const;
    expect(statuses).toContain("pending");
  });

  it("normalizes the plan approval permission fallback to ask", () => {
    expect(normalizeGlobalPermissionMode(undefined)).toBe("ask");
    expect(normalizeGlobalPermissionMode("invalid")).toBe("ask");
    expect(normalizeGlobalPermissionMode("ask")).toBe("ask");
    expect(normalizeGlobalPermissionMode("accept-edits")).toBe("accept-edits");
    expect(isGlobalPermissionMode("ask")).toBe(true);
    expect(isGlobalPermissionMode("invalid")).toBe(false);
  });

  it("keeps the artifact and queued execution wire shapes explicit", () => {
    const artifact: PlanArtifact = {
      relativePath: ".pi/plan/plan.md",
      sha256: "sha256",
      sizeBytes: 6,
    };
    const execution: PlanExecution = {
      id: "execution-1",
      proposalId: "proposal-1",
      sessionId: "session-1",
      kind: "plan",
      plan: "# Plan",
      title: "Plan",
      question: "Approve?",
      artifact,
      targetPermissionMode: "auto",
      state: "queued",
    };
    expect(execution.artifact).toEqual(artifact);
    expect(execution.state).toBe("queued");
  });

  it("keeps command shell catalogs path-free and output identities explicit", () => {
    const catalog: CommandShellCatalog = {
      configuredId: "windows-powershell",
      effective: {
        id: "windows-powershell",
        label: "Windows PowerShell",
        dialect: "powershell",
        available: true,
        isDefault: true,
      },
      fallback: false,
      choices: [],
    };
    const output: ToolsOutputParams = {
      sessionId: "session-1",
      toolCallId: "tool-1",
      commandShellId: "windows-powershell",
      stream: "stdout",
      chunk: "ok",
    };
    expect(catalog.effective).not.toHaveProperty("path");
    expect(output).toMatchObject({
      sessionId: "session-1",
      toolCallId: "tool-1",
      commandShellId: "windows-powershell",
    });
    expect(isCommandShellOption(catalog.effective)).toBe(true);
    expect(isCommandShellCatalog(catalog)).toBe(true);
    expect(isToolsOutputParams(output)).toBe(true);
    expect(
      isCommandShellOption({ ...catalog.effective, dialect: "cmd" }),
    ).toBe(false);
    expect(
      isToolsOutputParams({ ...output, commandShellId: "not-a-shell" }),
    ).toBe(false);
  });

  it("derives transport deadlines from command execution semantics", () => {
    expect(rpcTimeoutMs("tools.execute", { toolName: "Bash" })).toBe(190_000);
    expect(
      rpcTimeoutMs("tools.execute", { toolName: "Bash", timeoutMs: 5_000 }),
    ).toBe(135_000);
    expect(
      rpcTimeoutMs("tools.execute", { toolName: "Bash", timeoutMs: 60_000 }),
    ).toBe(190_000);
    expect(
      rpcTimeoutMs("tools.execute", { toolName: "Bash", timeoutMs: 0 }),
    ).toBe(190_000);
    expect(
      rpcTimeoutMs("tools.execute", {
        toolName: "Bash",
        timeoutMs: 2_147_483_647,
      }),
    ).toBe(2_147_483_647);
    expect(rpcTimeoutMs("tools.execute", { toolName: "Read" })).toBe(130_000);
    expect(rpcTimeoutMs("tools.execute", { toolName: "BrowserPreview" })).toBe(
      130_000,
    );
    expect(rpcTimeoutMs("tools.abort", { sessionId: "s", toolCallId: "t" })).toBe(
      130_000,
    );
  });
});
