import { createHash } from "node:crypto";
import type { AgentSubagentControlRequest, AgentSubagentControlResponse, UiMessage } from "@pi-desktop/shared";
import type { SubagentRun } from "./subagent.js";
import type { SubagentMessageModel } from "./subagent-model-binding.js";

export type UserSubagentOperation = { operationId: string; requestHash: string };
export type UserSubagentTarget = {
  delegationId: string; ownerCallId: string; agent: string;
  running: boolean; stopping?: boolean; cancelled?: boolean; run?: SubagentRun; completion?: Promise<void>;
};
export type UserSubagentControllerPort = {
  transcript(): readonly UiMessage[];
  begin(turnId: string): () => void;
  latest(delegationId: string): UserSubagentTarget;
  selectModel(target: UserSubagentTarget, model: string): Promise<SubagentMessageModel>;
  start(params: { agent: string; task: string; model?: string; resume?: string }, operation: UserSubagentOperation): Promise<string>;
  persist(message: UiMessage): Promise<void>;
  idle(): void;
};
export function subagentControlError(message: string): Error {
  return Object.assign(new Error(message), { errorCode: "SUBAGENT_CONTROL_REJECTED" });
}

/** User-command ordering and replay protection, never provider or agent ownership. */
export class UserSubagentController {
  private tail: Promise<unknown> = Promise.resolve();
  private operations = new Map<string, { hash: string; result: Promise<AgentSubagentControlResponse> }>();
  private active = 0;
  get pending(): number { return this.active; }
  constructor(private readonly port: UserSubagentControllerPort) {}

  /** Parent recovery shares user-command admission order without becoming a user command. */
  ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result;
    return result;
  }

  control(request: AgentSubagentControlRequest, turnId: string): Promise<AgentSubagentControlResponse> {
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const prior = this.operations.get(request.operationId);
    if (prior) {
      if (prior.hash !== requestHash) return Promise.reject(subagentControlError("Operation id was already used for a different command"));
      return prior.result;
    }
    this.active += 1;
    const result = this.tail.catch(() => undefined).then(async () => {
      const durable = this.port.transcript().find(message => message.subagentControl?.operationId === request.operationId);
      if (durable?.subagentControl) {
        if (durable.subagentControl.requestHash !== requestHash) throw subagentControlError("Operation id was already used for a different command");
        return { accepted: true as const, operationId: request.operationId, delegationId: durable.subagentControl.delegationId, messageId: durable.id, delivery: "recorded" as const };
      }
      const validate = this.port.begin(turnId);
      const operation = { operationId: request.operationId, requestHash };
      if (request.action === "start") {
        const delegationId = await this.port.start({ agent: request.agent, task: request.task, ...(request.model ? { model: request.model } : {}) }, operation);
        return { accepted: true as const, operationId: request.operationId, delegationId, messageId: `user-subagent-${request.operationId}`, delivery: "started" as const };
      }
      let target = this.port.latest(request.delegationId);
      const initialTarget = target;
      const currentTarget = () => {
        const current = this.port.latest(request.delegationId);
        if (current.stopping || current.cancelled !== initialTarget.cancelled || current.delegationId !== initialTarget.delegationId) {
          throw subagentControlError("The subagent changed or was stopped before the message was accepted");
        }
        return current;
      };
      if (target.stopping) throw subagentControlError("Wait for the subagent to confirm its stop before continuing");
      const model = target.running && request.model ? await this.port.selectModel(target, request.model) : undefined;
      validate();
      target = currentTarget();
      if (target.running && target.run) {
        const message: UiMessage = {
          id: `user-subagent-${request.operationId}`, role: "user", content: request.content,
          createdAt: new Date().toISOString(), status: "complete", steering: true,
          parentToolCallId: target.ownerCallId, agentName: target.agent,
          subagentControl: { ...operation, action: "message", delegationId: target.delegationId, agent: target.agent,
            ...(model ? { modelId: model.provider.modelId, modelKey: request.model, thinkingLevel: model.thinkingLevel } : {}) },
        };
        if (await target.run.sendUserMessage(request.content, async () => {
          validate(); currentTarget();
          await this.port.persist(message);
          validate(); currentTarget();
        }, model)) {
          validate(); currentTarget();
          return { accepted: true as const, operationId: request.operationId, delegationId: target.delegationId, messageId: message.id, delivery: "queued" as const };
        }
        validate();
        await target.completion;
        validate();
        target = currentTarget();
      }
      const delegationId = await this.port.start({ agent: target.agent, task: request.content, resume: target.delegationId,
        ...(request.model ? { model: request.model } : {}) }, operation);
      return { accepted: true as const, operationId: request.operationId, delegationId, messageId: `user-subagent-${request.operationId}`, delivery: "started" as const };
    }).catch((error: unknown) => {
      this.operations.delete(request.operationId);
      throw error;
    }).finally(() => {
      this.active -= 1;
      this.port.idle();
      if (this.operations.size > 512) this.operations.delete(this.operations.keys().next().value ?? "");
    });
    this.operations.set(request.operationId, { hash: requestHash, result });
    this.tail = result;
    return result;
  }
}
