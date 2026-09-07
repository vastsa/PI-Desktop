/**
 * Plan UI acceptance probe (scripts/e2e-plan-ui.mjs). Installed only when
 * PI_DESKTOP_PLAN_UI_PROBE=1, it exposes a Main-only global the harness calls
 * over the inspector to seed sessions, submit plans, and settle turns through
 * the live host and sidecar instead of a fixture backend.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSidecar } from "./agent-sidecar";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";

type PlanUiProbeRequest = {
  operation?: unknown;
  workspace?: unknown;
  sessionId?: unknown;
  turnId?: unknown;
  status?: unknown;
  revision?: unknown;
  title?: unknown;
  markdown?: unknown;
  question?: unknown;
};

const PLAN_UI_PROBE_GLOBAL = "__PI_DESKTOP_PLAN_UI_PROBE";

export type PlanUiProbeDeps = {
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  logger: Logger;
};

export function createPlanUiProbe(deps: PlanUiProbeDeps) {

  function planUiProbeHostChildPid(instance: HostProcess | null): number | null {
    const child = (
      instance as unknown as { child?: { pid?: unknown } } | null
    )?.child;
    return typeof child?.pid === "number" && Number.isInteger(child.pid)
      ? child.pid
      : null;
  }

  function planUiProbeIdentity(instance: HostProcess | null = deps.getHost()) {
    return {
      electronMainPid: process.pid,
      hostChildPid: planUiProbeHostChildPid(instance),
    };
  }

  function planUiProbeSidecarChildPid(
    instance: AgentSidecar | null = deps.getSidecar(),
  ): number | null {
    const child = (
      instance as unknown as { child?: { pid?: unknown } } | null
    )?.child;
    return typeof child?.pid === "number" && Number.isInteger(child.pid)
      ? child.pid
      : null;
  }

  function planUiProbeErrorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const secret = process.env.PI_DESKTOP_TEST_API_KEY;
    if (!secret) return message;
    return message.split(secret).join("[REDACTED]");
  }

  function planUiProbeString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} must be a non-empty string`);
    }
    return value;
  }

  function planUiProbeWorkspace(value: unknown): string {
    const workspace = planUiProbeString(value, "workspace").trim();
    const resolved = resolve(workspace);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`workspace directory not found: ${resolved}`);
    }
    return resolved;
  }

  async function planUiProbeLiveSetup(
    activeHost: HostProcess,
    workspace: string,
  ): Promise<Record<string, unknown>> {
    const apiKey = process.env.PI_DESKTOP_TEST_API_KEY;
    const baseUrl = process.env.PI_DESKTOP_TEST_BASE_URL;
    const modelId = process.env.PI_DESKTOP_TEST_MODEL;
    const missing = [
      !apiKey?.trim() ? "PI_DESKTOP_TEST_API_KEY" : null,
      !baseUrl?.trim() ? "PI_DESKTOP_TEST_BASE_URL" : null,
      !modelId?.trim() ? "PI_DESKTOP_TEST_MODEL" : null,
    ].filter((name): name is string => Boolean(name));
    if (missing.length > 0) {
      throw new Error(`live Plan UI setup is missing ${missing.join(", ")}`);
    }

    const providerResponse = await activeHost.call<{
      provider?: { id?: string; defaultModelId?: string } | null;
    }>("providers.create", {
      name: "Plan UI live provider",
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl,
      authKind: "api_key_and_base_url",
      defaultModelId: modelId,
      secretValue: apiKey,
      apiStyle: "chat_completions",
    });
    const providerId = providerResponse.provider?.id;
    if (!providerId) throw new Error("live provider creation returned no provider ID");

    const sessionResponse = await activeHost.call<{
      session?: {
        id?: string;
        title?: string;
        mode?: string;
        providerId?: string | null;
        modelId?: string | null;
        projectPath?: string | null;
      } | null;
    }>("session.create", {
      title: "Plan UI live Agent",
      mode: "agent",
      providerId,
      modelId,
      projectPath: workspace,
    });
    const session = sessionResponse.session;
    if (!session?.id) throw new Error("live session creation returned no session ID");
    if (session.mode !== "agent") throw new Error("live session is not Agent mode");
    if (session.providerId !== providerId || session.modelId !== modelId) {
      throw new Error("live session provider/model identity mismatch");
    }
    if (!session.projectPath) throw new Error("live session is not project-bound");
    return {
      ok: true,
      operation: "liveSetup",
      providerId,
      modelId,
      sessionId: session.id,
      title: session.title,
      mode: session.mode,
      projectPath: session.projectPath,
    };
  }

  async function runPlanUiProbe(request: unknown): Promise<Record<string, unknown>> {
    try {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("probe request must be an object");
      }
      const input = request as PlanUiProbeRequest;
      const operation = input.operation;
      if (operation === "identity") {
        return { ...planUiProbeIdentity(), ok: true, operation };
      }
      if (operation === "runtimeIdentity") {
        const sidecar = deps.getSidecar();
        if (!sidecar) throw new Error("agent sidecar unavailable");
        const sessionId = planUiProbeString(input.sessionId, "sessionId").trim();
        const runtime = await sidecar.call<{
          runtimeId?: string;
          sessionId?: string;
          mode?: string;
          modelId?: string;
          status?: Record<string, unknown>;
        }>("agent.testRuntimeIdentity", { sessionId });
        if (!runtime.runtimeId) throw new Error("sidecar returned no runtime ID");
        return {
          ...planUiProbeIdentity(),
          sidecarChildPid: planUiProbeSidecarChildPid(),
          ok: true,
          operation,
          runtimeId: runtime.runtimeId,
          sessionId: runtime.sessionId,
          mode: runtime.mode,
          modelId: runtime.modelId,
          status: runtime.status,
        };
      }
      if (
        operation !== "seed" &&
        operation !== "submit" &&
        operation !== "settle" &&
        operation !== "liveSetup"
      ) {
        throw new Error("probe operation must be identity, runtimeIdentity, seed, submit, settle, or liveSetup");
      }

      const activeHost = deps.getHost();
      if (!activeHost) throw new Error("host unavailable");
      if (operation === "settle") {
        const sessionId = planUiProbeString(input.sessionId, "sessionId").trim();
        const turnId = planUiProbeString(input.turnId, "turnId").trim();
        const status = input.status;
        if (status !== "aborted" && status !== "completed") {
          throw new Error("settle status must be aborted or completed");
        }
        const response = await activeHost.call("session.endTurn", {
          turnId,
          status,
          createNotification: false,
        });
        if (deps.getHost() !== activeHost) throw new Error("host changed during Plan UI probe");
        return {
          ...planUiProbeIdentity(activeHost),
          ok: true,
          operation,
          sessionId,
          turnId,
          status,
          response,
        };
      }
      const workspace = planUiProbeWorkspace(input.workspace);
      const workspaceResponse = await activeHost.call<{
        workspace?: { path?: string } | null;
      }>("workspace.set", { path: workspace });
      if (!workspaceResponse?.workspace?.path) {
        throw new Error("workspace.set returned no workspace");
      }

      if (operation === "liveSetup") {
        const response = await planUiProbeLiveSetup(activeHost, workspace);
        if (deps.getHost() !== activeHost) throw new Error("host changed during Plan UI probe");
        return {
          ...planUiProbeIdentity(activeHost),
          ...response,
        };
      }

      if (operation === "seed") {
        const response = await activeHost.call<{
          session?: {
            id?: string;
            title?: string;
            mode?: string;
            providerId?: string | null;
            projectPath?: string | null;
          } | null;
        }>("session.create", {
          title: "Plan UI acceptance",
          mode: "plan",
          projectPath: workspace,
        });
        const session = response?.session;
        if (!session?.id) throw new Error("session.create returned no session");
        if (session.mode !== "plan") throw new Error("seed session is not Plan");
        if (session.providerId) {
          throw new Error("seed session unexpectedly requires a provider");
        }
        if (!session.projectPath) {
          throw new Error("seed session is not project-bound");
        }
        if (deps.getHost() !== activeHost) throw new Error("host changed during Plan UI probe");
        return {
          ...planUiProbeIdentity(activeHost),
          ok: true,
          operation,
          sessionId: session.id,
          title: session.title,
          mode: session.mode,
          projectPath: session.projectPath,
        };
      }

      const sessionId = planUiProbeString(input.sessionId, "sessionId").trim();
      const revision = input.revision;
      if (revision !== "first" && revision !== "second") {
        throw new Error("revision must be first or second");
      }
      const title = planUiProbeString(input.title, "title");
      const markdown = planUiProbeString(input.markdown, "markdown");
      const question = planUiProbeString(input.question, "question");
      const turnResponse = await activeHost.call<{ turnId?: string }>(
        "session.beginTurn",
        { sessionId },
      );
      const turnId = turnResponse?.turnId;
      if (!turnId) throw new Error("session.beginTurn returned no turn");
      const toolCallId = `plan-ui-probe-${revision}`;
      const response = await activeHost.call<{
        status?: string;
        proposal?: Record<string, any> | null;
      }>("plans.submit", {
        sessionId,
        turnId,
        toolCallId,
        title,
        markdown,
        question,
      });
      const proposal = response?.proposal;
      if (response?.status !== "pending") {
        throw new Error(`plans.submit was not pending: ${String(response?.status)}`);
      }
      if (!proposal?.id) throw new Error("plans.submit returned no proposal");
      if (proposal.sessionId !== sessionId) {
        throw new Error("proposal session identity mismatch");
      }
      if (proposal.turnId !== turnId) {
        throw new Error("proposal turn identity mismatch");
      }
      if (proposal.toolCallId !== toolCallId) {
        throw new Error("proposal tool identity mismatch");
      }
      if (proposal.markdown !== markdown) {
        throw new Error("proposal Markdown is not byte-identical");
      }
      if (proposal.title !== title.trim()) {
        throw new Error("proposal title mismatch");
      }
      if (proposal.question !== question.trim()) {
        throw new Error("proposal question mismatch");
      }
      if (!proposal.expiresAt || !proposal.artifact?.relativePath) {
        throw new Error("proposal is missing expiry or artifact metadata");
      }
      if (
        typeof proposal.artifact.sha256 !== "string" ||
        !Number.isSafeInteger(proposal.artifact.sizeBytes) ||
        proposal.artifact.sizeBytes < 0
      ) {
        throw new Error("proposal artifact metadata is invalid");
      }
      if (deps.getHost() !== activeHost) throw new Error("host changed during Plan UI probe");
      return {
        ...planUiProbeIdentity(activeHost),
        ok: true,
        operation,
        sessionId,
        revision,
        turnId,
        toolCallId,
        status: response.status,
        proposal,
      };
    } catch (error) {
      return {
        ...planUiProbeIdentity(),
        ok: false,
        error: planUiProbeErrorText(error),
      };
    }
  }

  function installPlanUiProbe() {
    if (process.env.PI_DESKTOP_PLAN_UI_PROBE !== "1") return;
    (globalThis as any)[PLAN_UI_PROBE_GLOBAL] = runPlanUiProbe;
    deps.logger.app("diagnostics", "info", "Plan UI test probe enabled", {
      data: planUiProbeIdentity(),
    });
  }

  return { install: installPlanUiProbe, run: runPlanUiProbe };
}
