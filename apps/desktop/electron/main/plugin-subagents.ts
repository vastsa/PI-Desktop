import {
  MAX_PLUGIN_SUBAGENT_IDS,
  MAX_PLUGIN_SUBAGENT_TASK_CHARS,
} from "@pi-desktop/shared";
import type { PluginToolInvocation } from "./plugin-tool-invocations";

/**
 * Plugin-started subagents (`agent.subagent`, issue #2508; spec
 * 07-plugins/03 §agent.subagent).
 *
 * A plugin starts, waits for, and stops delegations from inside its own Agent
 * tool invocation. The delegation itself runs in the agent runtime through the
 * same path a model-issued `Task` call takes; this broker only validates the
 * plugin's input, takes session/turn/toolCallId from the live invocation, and
 * owns which plugin started which delegation id.
 */

export const PLUGIN_SUBAGENT_WAIT_DEFAULT_SECONDS = 60;
export const PLUGIN_SUBAGENT_WAIT_MIN_SECONDS = 1;
export const PLUGIN_SUBAGENT_WAIT_MAX_SECONDS = 90;
const MAX_AGENT_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_MODEL_KEY_CHARS = 256;
/** Ownership records kept per plugin; the oldest are forgotten first. */
const MAX_OWNED_PER_PLUGIN = 256;

export type PluginSubagentResult = {
  delegationId: string;
  agent: string;
  status: string;
  modelId: string;
  report: string;
  turns: number;
  toolCalls: number;
  usage?: unknown;
  modelFailures?: unknown;
  error?: unknown;
};

/** Sidecar transport for the three calls (services/plugin-services.ts). */
export type PluginSubagentServices = {
  start: (input: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    agent: string;
    task: string;
    description?: string;
    model?: string;
  }) => Promise<{ delegationId: string; agent: string; modelId: string }>;
  wait: (input: {
    sessionId: string;
    delegationIds: string[];
    mode: "all" | "any";
    timeoutMs: number;
    toolCallId?: string;
  }) => Promise<{ results: PluginSubagentResult[]; running: string[]; unknown: string[] }>;
  stop: (input: {
    sessionId: string;
    delegationIds: string[];
  }) => Promise<{ stopped?: string[]; pending?: string[] }>;
};

type Owner = { pluginId: string; sessionId: string; received: boolean };

type Audit = (entry: Record<string, unknown>) => void;

function pluginError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCodeOf(error: unknown): string {
  const candidate = error as
    | { code?: unknown; errorCode?: unknown; data?: { errorCode?: unknown } }
    | null
    | undefined;
  const code = candidate?.data?.errorCode ?? candidate?.errorCode ?? candidate?.code;
  return typeof code === "string" ? code : "PLUGIN_API_FAILED";
}

function asRecord(value: unknown, api: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw pluginError("INVALID_ARGUMENT", `${api} input must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  input: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw pluginError("INVALID_ARGUMENT", `${key} must be a${required ? " non-empty" : ""} string`);
  }
  if (value.length > max) {
    throw pluginError("INVALID_ARGUMENT", `${key} exceeds ${max} characters`);
  }
  return value;
}

function delegationIdsOf(input: Record<string, unknown>): string[] | undefined {
  const ids = input.delegationIds;
  if (ids === undefined) return undefined;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_PLUGIN_SUBAGENT_IDS ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw pluginError(
      "INVALID_ARGUMENT",
      `delegationIds must list 1..${MAX_PLUGIN_SUBAGENT_IDS} delegation ids`,
    );
  }
  return [...new Set(ids as string[])];
}

export class PluginSubagentBroker {
  /** delegationId → the plugin and session that started it. */
  private readonly owners = new Map<string, Owner>();
  private readonly deps: {
    services: () => PluginSubagentServices | undefined;
    audit: () => Audit | undefined;
  };

  constructor(deps: {
    services: () => PluginSubagentServices | undefined;
    audit: () => Audit | undefined;
  }) {
    this.deps = deps;
  }

  async start(
    pluginId: string,
    invocation: PluginToolInvocation | undefined,
    raw: unknown,
  ): Promise<{ delegationId: string; agent: string; modelId: string }> {
    const api = "agent.startSubagent";
    let taskChars = 0;
    try {
      const { sessionId, turnId, toolCallId } = this.liveInvocation(invocation, true);
      const input = asRecord(raw, api);
      const agent = boundedString(input, "agent", MAX_AGENT_NAME_CHARS, true)!.trim();
      const task = boundedString(input, "task", MAX_PLUGIN_SUBAGENT_TASK_CHARS, true)!;
      taskChars = task.length;
      const description = boundedString(input, "description", MAX_DESCRIPTION_CHARS, false);
      const model = boundedString(input, "model", MAX_MODEL_KEY_CHARS, false);
      const services = this.requireServices(api);
      const started = await services.start({
        sessionId,
        turnId: turnId!,
        toolCallId: toolCallId!,
        agent,
        task,
        ...(description !== undefined ? { description } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      this.own(started.delegationId, { pluginId, sessionId, received: false });
      this.audit({
        pluginId,
        api,
        ok: true,
        sessionId,
        agent: started.agent,
        delegationId: started.delegationId,
        taskChars,
      });
      return {
        delegationId: started.delegationId,
        agent: started.agent,
        modelId: started.modelId,
      };
    } catch (error) {
      this.audit({ pluginId, api, ok: false, errorCode: errorCodeOf(error), taskChars });
      throw error;
    }
  }

  async wait(
    pluginId: string,
    invocation: PluginToolInvocation | undefined,
    raw: unknown,
  ): Promise<{ results: PluginSubagentResult[]; running: string[] }> {
    const api = "agent.waitSubagents";
    try {
      const { sessionId, toolCallId } = this.liveInvocation(invocation, false);
      const input = asRecord(raw, api);
      const explicit = delegationIdsOf(input);
      const mode = input.mode === undefined ? "all" : input.mode;
      if (mode !== "all" && mode !== "any") {
        throw pluginError("INVALID_ARGUMENT", 'mode must be "all" or "any"');
      }
      const timeoutSeconds =
        input.timeoutSeconds === undefined
          ? PLUGIN_SUBAGENT_WAIT_DEFAULT_SECONDS
          : input.timeoutSeconds;
      if (
        typeof timeoutSeconds !== "number" ||
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds < PLUGIN_SUBAGENT_WAIT_MIN_SECONDS ||
        timeoutSeconds > PLUGIN_SUBAGENT_WAIT_MAX_SECONDS
      ) {
        throw pluginError(
          "INVALID_ARGUMENT",
          `timeoutSeconds must be ${PLUGIN_SUBAGENT_WAIT_MIN_SECONDS}..${PLUGIN_SUBAGENT_WAIT_MAX_SECONDS}`,
        );
      }
      if (explicit) this.assertOwned(pluginId, sessionId, explicit);
      const services = this.requireServices(api);
      let targets = explicit ?? this.pendingIds(pluginId, sessionId);
      let response = { results: [] as PluginSubagentResult[], running: [] as string[], unknown: [] as string[] };
      // One retry: an implicit target set drops ids the runtime no longer
      // knows (session runtime disposed or restarted) and waits on the rest.
      for (let attempt = 0; attempt < 2 && targets.length > 0; attempt += 1) {
        response = await services.wait({
          sessionId,
          delegationIds: targets,
          mode,
          timeoutMs: Math.round(timeoutSeconds * 1000),
          ...(toolCallId ? { toolCallId } : {}),
        });
        if (response.unknown.length === 0) break;
        for (const id of response.unknown) this.owners.delete(id);
        if (explicit) {
          throw pluginError(
            "NOT_FOUND",
            `unknown delegation ids: ${response.unknown.join(", ")}`,
          );
        }
        const gone = new Set(response.unknown);
        targets = targets.filter((id) => !gone.has(id));
        response = { results: [], running: [], unknown: [] };
      }
      for (const result of response.results) {
        const owner = this.owners.get(result.delegationId);
        if (owner) owner.received = true;
      }
      this.audit({
        pluginId,
        api,
        ok: true,
        sessionId,
        requested: targets.length,
        settled: response.results.length,
        running: response.running.length,
        mode,
        timeoutSeconds,
      });
      return { results: response.results, running: response.running };
    } catch (error) {
      this.audit({ pluginId, api, ok: false, errorCode: errorCodeOf(error) });
      throw error;
    }
  }

  async stop(
    pluginId: string,
    invocation: PluginToolInvocation | undefined,
    raw: unknown,
  ): Promise<{ stopped: string[] }> {
    const api = "agent.stopSubagents";
    try {
      const { sessionId } = this.liveInvocation(invocation, false);
      const input = asRecord(raw, api);
      const explicit = delegationIdsOf(input);
      if (explicit) this.assertOwned(pluginId, sessionId, explicit);
      // Never forward an empty list: the runtime reads it as "every running
      // delegation", which includes the model's own Task runs.
      const targets = explicit ?? this.pendingIds(pluginId, sessionId);
      let stopped: string[] = [];
      if (targets.length > 0) {
        const response = await this.requireServices(api).stop({ sessionId, delegationIds: targets });
        const wanted = new Set(targets);
        stopped = (response.stopped ?? []).filter((id) => wanted.has(id));
      }
      this.audit({
        pluginId,
        api,
        ok: true,
        sessionId,
        requested: targets.length,
        stopped: stopped.length,
      });
      return { stopped };
    } catch (error) {
      this.audit({ pluginId, api, ok: false, errorCode: errorCodeOf(error) });
      throw error;
    }
  }

  /** Plugin unload or reload: the plugin can no longer reach its delegations. */
  forgetPlugin(pluginId: string): void {
    for (const [id, owner] of this.owners) {
      if (owner.pluginId === pluginId) this.owners.delete(id);
    }
  }

  private liveInvocation(
    invocation: PluginToolInvocation | undefined,
    needsTurn: boolean,
  ): { sessionId: string; turnId?: string; toolCallId?: string } {
    const sessionId = invocation?.sessionId.trim() ?? "";
    const turnId = invocation?.turnId?.trim() || undefined;
    const toolCallId = invocation?.toolCallId?.trim() || undefined;
    if (!sessionId || (needsTurn && (!turnId || !toolCallId))) {
      throw pluginError("INVALID_ARGUMENT", "subagents are only available during tool execution");
    }
    return { sessionId, turnId, toolCallId };
  }

  private requireServices(api: string): PluginSubagentServices {
    const services = this.deps.services();
    if (!services) throw pluginError("UNSUPPORTED", `host api not available: ${api}`);
    return services;
  }

  private assertOwned(pluginId: string, sessionId: string, ids: string[]): void {
    for (const id of ids) {
      const owner = this.owners.get(id);
      if (!owner || owner.pluginId !== pluginId || owner.sessionId !== sessionId) {
        throw pluginError(
          "PERMISSION_DENIED",
          `delegation ${id} was not started by this plugin in this session`,
        );
      }
    }
  }

  /** Delegations this plugin started in the session and has not received. */
  private pendingIds(pluginId: string, sessionId: string): string[] {
    const ids: string[] = [];
    for (const [id, owner] of this.owners) {
      if (owner.pluginId !== pluginId || owner.sessionId !== sessionId || owner.received) continue;
      ids.push(id);
      if (ids.length === MAX_PLUGIN_SUBAGENT_IDS) break;
    }
    return ids;
  }

  private own(delegationId: string, owner: Owner): void {
    this.owners.set(delegationId, owner);
    let count = 0;
    for (const entry of this.owners.values()) if (entry.pluginId === owner.pluginId) count += 1;
    if (count <= MAX_OWNED_PER_PLUGIN) return;
    for (const [id, entry] of this.owners) {
      if (entry.pluginId !== owner.pluginId) continue;
      this.owners.delete(id);
      count -= 1;
      if (count <= MAX_OWNED_PER_PLUGIN) return;
    }
  }

  private audit(entry: Record<string, unknown>): void {
    this.deps.audit()?.({ ...entry, ts: Date.now() });
  }
}
