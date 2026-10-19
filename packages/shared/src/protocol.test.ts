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
  AGENT_COMPACT_RPC_TIMEOUT_MS,
  COMMAND_RPC_BUFFER_MS,
  COMPACTION_SUMMARY_MAX_RETRIES,
  COMPACTION_SUMMARY_RETRY_BUDGET_MS,
  STREAM_IDLE_TIMEOUT_MS,
  TOOL_QUEUE_WAIT_MS,
  WORKTREE_DELEGATE_RPC_TIMEOUT_MS,
  rpcTimeoutMs,
  type PlanExecution,
  type PlanArtifact,
  type PlanResolveRequest,
  type ScheduledTask,
  type CommandShellCatalog,
  type ToolsOutputParams,
} from "./index.js";

describe("Plan protocol contracts", () => {
  it("uses protocol v11/schema v16 and exposes the plan, schedule, and shell channels", () => {
    expect(PROTOCOL_VERSION).toBe(11);
    expect(SCHEMA_VERSION).toBe(16);
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
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledExecute)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.scheduledListRuns)).toBe(true);
    expect(IPC.invoke.providersRefreshModelCatalog).toBe(
      "pi-desktop/providers/refreshModelCatalog",
    );
    expect(IPC_WHITELIST.has(IPC.invoke.providersRefreshModelCatalog)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.windowSetWorkPanelChatWidth)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.event.windowWorkPanelResize)).toBe(true);
    expect(IPC.invoke.lifecycleDialogReady).toBe("pi-desktop/window/lifecycleDialog/ready");
    expect(IPC.invoke.lifecycleDialogRespond).toBe("pi-desktop/window/lifecycleDialog/respond");
    expect(IPC.event.lifecycleDialogRequest).toBe("pi-desktop/window/event/lifecycleDialogRequest");
    expect(IPC.event.lifecycleDialogDismiss).toBe("pi-desktop/window/event/lifecycleDialogDismiss");
    for (const channel of [
      IPC.invoke.lifecycleDialogReady,
      IPC.invoke.lifecycleDialogRespond,
      IPC.event.lifecycleDialogRequest,
      IPC.event.lifecycleDialogDismiss,
    ]) {
      expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
    expect(IPC.invoke.appOpenFeedback).toBe("pi-desktop/app/openFeedback");
    expect(IPC_WHITELIST.has(IPC.invoke.appOpenFeedback)).toBe(true);
    expect(IPC.invoke.fsOpen).toBe("pi-desktop/fs/open");
    expect(IPC_WHITELIST.has(IPC.invoke.fsOpen)).toBe(true);
    expect(IPC.invoke.statsGetTokenUsageHistory).toBe(
      "pi-desktop/stats/getTokenUsageHistory",
    );
    expect(IPC_WHITELIST.has(IPC.invoke.statsGetTokenUsageHistory)).toBe(true);
    expect(IPC.invoke.fsReadImageDataUrl).toBe("pi-desktop/fs/readImageDataUrl");
    expect(IPC_WHITELIST.has(IPC.invoke.fsReadImageDataUrl)).toBe(true);
    expect(IPC.invoke.networkProxyTest).toBe("pi-desktop/network/testProxy");
    expect(IPC_WHITELIST.has(IPC.invoke.networkProxyTest)).toBe(true);
    expect(IPC.invoke.modelConfigImportScan).toBe("pi-desktop/modelConfig/importScan");
    expect(IPC.invoke.modelConfigImportRun).toBe("pi-desktop/modelConfig/importRun");
    expect(IPC_WHITELIST.has(IPC.invoke.modelConfigImportScan)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.modelConfigImportRun)).toBe(true);
    expect(IPC.invoke.projectClone).toBe("pi-desktop/project/clone");
    expect(IPC_WHITELIST.has(IPC.invoke.projectClone)).toBe(true);
    expect(IPC.invoke.speechTranscribe).toBe("pi-desktop/speech/transcribe");
    expect(IPC_WHITELIST.has(IPC.invoke.speechTranscribe)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.speechSynthesize)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.invoke.speechGetStatus)).toBe(true);
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
      permissionMode: "accept-edits",
      thinkingLevel: "high",
      providerId: "provider-1",
      modelId: "model-1",
      workspacePath: "C:/work/project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(task.mode).toBe("plan");
    expect(task).toMatchObject({
      permissionMode: "accept-edits",
      thinkingLevel: "high",
      providerId: "provider-1",
      modelId: "model-1",
      workspacePath: "C:/work/project",
    });
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

  it("leaves tool approval transport open until the user decides", () => {
    expect(rpcTimeoutMs("tools.execute", { toolName: "Bash" })).toBeUndefined();
    expect(
      rpcTimeoutMs("tools.execute", { toolName: "plugin_advisor_ask", timeoutMs: 5_000 }),
    ).toBeUndefined();
    expect(rpcTimeoutMs("tools.execute", { toolName: "Read" })).toBeUndefined();
    expect(rpcTimeoutMs("tools.execute", { toolName: "BrowserPreview" })).toBeUndefined();
    expect(rpcTimeoutMs("tools.abort", { sessionId: "s", toolCallId: "t" })).toBe(
      130_000,
    );
  });

  it("lets a subagent worktree merge outlast its permit waits (ADR 0329)", () => {
    for (const method of ["worktree.delegate.create", "worktree.delegate.settle"]) {
      expect(rpcTimeoutMs(method, {})).toBe(WORKTREE_DELEGATE_RPC_TIMEOUT_MS);
    }
    expect(WORKTREE_DELEGATE_RPC_TIMEOUT_MS).toBeGreaterThan(5_000 + TOOL_QUEUE_WAIT_MS + 3 * 120_000);
    expect(rpcTimeoutMs("worktree.merge", {})).toBe(130_000);
  });

  it("outlasts the whole model request a manual compaction spends (#795)", () => {
    // One summary prompt plus the sidecar's retry budget: every attempt that
    // stops producing events is cut by the stream watchdog, and each retry pays
    // its backoff wait. A flat 130s fired on a ~158s compaction, so Electron
    // reported a failure while the sidecar persisted the checkpoint anyway.
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(180_000);
    expect(COMPACTION_SUMMARY_MAX_RETRIES).toBe(3);
    expect(COMPACTION_SUMMARY_RETRY_BUDGET_MS).toBe(14_000);
    expect(AGENT_COMPACT_RPC_TIMEOUT_MS).toBe(
      (1 + COMPACTION_SUMMARY_MAX_RETRIES) * STREAM_IDLE_TIMEOUT_MS +
        COMPACTION_SUMMARY_RETRY_BUDGET_MS +
        COMMAND_RPC_BUFFER_MS,
    );
    expect(AGENT_COMPACT_RPC_TIMEOUT_MS).toBe(744_000);
    expect(rpcTimeoutMs("agent.compact", { sessionId: "s" })).toBe(
      AGENT_COMPACT_RPC_TIMEOUT_MS,
    );
    // The deadline is per-method on purpose: widening the global default would
    // hide a genuinely lost reply on every other call.
    expect(rpcTimeoutMs("agent.getStatus", { sessionId: "s" })).toBe(130_000);
  });

  it("leaves a whole cloud sync unbounded and observable after navigation", () => {
    // The Host owns sync execution; progress is supplementary, and navigating
    // away from Settings must not impose a transport deadline on that request.
    expect(IPC.event.configSyncProgress).toBe(
      "pi-desktop/configSync/event/progress",
    );
    expect(IPC_WHITELIST.has(IPC.event.configSyncProgress)).toBe(true);
    expect(rpcTimeoutMs("configSync.syncNow", {})).toBeUndefined();
    expect(rpcTimeoutMs("configSync.getState", {})).toBe(130_000);
  });
});
