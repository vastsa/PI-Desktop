/**
 * In-memory chain registry for resumable delegations (ADR 0279).
 *
 * The registry is rebuilt from the session transcript at launch, then updated
 * as `task` calls settle. It never appears in a tool parameter: the parent
 * only ever passes a `delegationId`, and the reverse map finds the chain.
 */

import {
  MAX_RESUMABLE_CHAINS_PER_AGENT,
  MAX_RESUMABLE_READ_LINES,
} from "@pi-desktop/shared";
import {
  formatResumableList,
  isChainWithinReadBudget,
  type DelegationChain,
  type ResumableChain,
} from "./delegation-history.js";

const RESUMABLE_STATUSES = new Set(["completed", "failed", "timed_out"]);

export type ChainLookupError =
  | { kind: "unknown" }
  | { kind: "running"; delegationId: string }
  | { kind: "not-resumable"; status: string }
  | { kind: "agent-mismatch"; expected: string; actual: string }
  | { kind: "over-budget" };

export class DelegationChainRegistry {
  private readonly chains = new Map<string, DelegationChain>();
  /** Every live `delegationId` on a chain, pointing at that chain's session id. */
  private readonly byDelegationId = new Map<string, string>();

  hydrate(chains: DelegationChain[]): void {
    this.chains.clear();
    this.byDelegationId.clear();
    for (const chain of chains) this.install(chain);
    this.evictOverflow();
  }

  lookup(delegationId: string): DelegationChain | undefined {
    const sessionId = this.byDelegationId.get(delegationId);
    if (!sessionId) return undefined;
    return this.chains.get(sessionId);
  }

  resolveResume(options: {
    resume: string;
    agentName: string;
    runningDelegationIds: ReadonlySet<string>;
  }): { ok: true; chain: DelegationChain } | { ok: false; error: ChainLookupError } {
    const chain = this.lookup(options.resume);
    if (!chain) return { ok: false, error: { kind: "unknown" } };
    if (chain.agentName !== options.agentName) {
      return {
        ok: false,
        error: {
          kind: "agent-mismatch",
          expected: chain.agentName,
          actual: options.agentName,
        },
      };
    }
    const latest = chain.latestDelegationId;
    if (latest && options.runningDelegationIds.has(latest)) {
      return { ok: false, error: { kind: "running", delegationId: latest } };
    }
    // An unknown status only happens for a chain rebuilt from the transcript
    // at launch, where live records are gone: its last run is settled by
    // definition. A settled chain carries its own status, which survives
    // `pruneFinishedDelegations` deleting the runtime's records.
    if (chain.latestStatus && !RESUMABLE_STATUSES.has(chain.latestStatus)) {
      return {
        ok: false,
        error: { kind: "not-resumable", status: chain.latestStatus },
      };
    }
    if (!isChainWithinReadBudget(chain)) {
      return { ok: false, error: { kind: "over-budget" } };
    }
    return { ok: true, chain };
  }

  start(options: {
    delegateSessionId: string;
    delegationId: string;
    toolCallId: string;
    agentName: string;
    originalTask: string;
    objective: string;
    latestModelId?: string;
    /** `providerId/modelId` key that resolved, so a resume can re-resolve it. */
    latestModelKey?: string;
    resumedFrom?: DelegationChain;
  }): DelegationChain {
    const existing = options.resumedFrom
      ? this.chains.get(options.resumedFrom.delegateSessionId)
      : undefined;
    const chain: DelegationChain = existing
      ? {
          ...existing,
          toolCallIds: [...existing.toolCallIds, options.toolCallId],
          delegationIds: [...existing.delegationIds, options.delegationId],
          latestDelegationId: options.delegationId,
          latestObjective: options.objective || existing.latestObjective,
          latestModelId: options.latestModelId ?? existing.latestModelId,
          latestModelKey: options.latestModelKey ?? existing.latestModelKey,
          latestStatus: "running",
          lastActivityAt: Date.now(),
        }
      : {
          delegateSessionId: options.delegateSessionId,
          toolCallIds: [options.toolCallId],
          delegationIds: [options.delegationId],
          agentName: options.agentName,
          readFiles: [],
          readLineCount: 0,
          originalTask: options.originalTask,
          latestDelegationId: options.delegationId,
          latestObjective: options.objective,
          latestModelId: options.latestModelId,
          latestModelKey: options.latestModelKey,
          latestStatus: "running",
          lastActivityAt: Date.now(),
        };
    this.install(chain);
    return chain;
  }

  noteReads(
    delegateSessionId: string,
    files: readonly string[],
    lineCount: number,
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    const merged = [...chain.readFiles];
    for (const file of files) {
      if (!merged.includes(file)) merged.push(file);
    }
    this.chains.set(delegateSessionId, {
      ...chain,
      readFiles: merged,
      readLineCount: chain.readLineCount + lineCount,
      lastActivityAt: Date.now(),
    });
  }

  /** Record the binding the running delegate switched to (fallback models). */
  retarget(
    delegateSessionId: string,
    binding: { modelKey?: string; modelId: string },
  ): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      ...(binding.modelKey ? { latestModelKey: binding.modelKey } : {}),
      latestModelId: binding.modelId,
      lastActivityAt: Date.now(),
    });
  }

  settle(delegateSessionId: string, status: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.set(delegateSessionId, {
      ...chain,
      latestStatus: status,
      lastActivityAt: Date.now(),
    });
    this.evictOverflow();
  }

  drop(delegateSessionId: string): void {
    const chain = this.chains.get(delegateSessionId);
    if (!chain) return;
    this.chains.delete(delegateSessionId);
    for (const id of chain.delegationIds) this.byDelegationId.delete(id);
  }

  resumableList(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): ResumableChain[] {
    const listed: ResumableChain[] = [];
    for (const chain of this.chains.values()) {
      const latest = chain.latestDelegationId;
      if (!latest) continue;
      if (options.runningDelegationIds.has(latest)) continue;
      if (chain.latestStatus && !RESUMABLE_STATUSES.has(chain.latestStatus)) {
        continue;
      }
      if (!isChainWithinReadBudget(chain, MAX_RESUMABLE_READ_LINES)) continue;
      listed.push({
        ...chain,
        latestDelegationId: latest,
        latestObjective: chain.latestObjective ?? "",
      });
    }
    return listed.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  promptBlock(options: {
    runningDelegationIds: ReadonlySet<string>;
  }): string {
    return formatResumableList(this.resumableList(options));
  }

  unknownResumeError(resume: string, list: readonly ResumableChain[]): string {
    const available = resumableSummary(list);
    return available
      ? `Unknown delegation "${resume}". Reusable: ${available}.`
      : `Unknown delegation "${resume}". No reusable subagent sessions in this conversation.`;
  }

  /**
   * A chain resolved but has nothing left to replay: its rows are gone from the
   * transcript (a truncated branch, or a delegation that died before writing
   * any). The caller drops the chain first, so the id in the error can never
   * also appear in its own "reusable" list (ADR 0279 §4).
   */
  noHistoryResumeError(resume: string, list: readonly ResumableChain[]): string {
    const available = resumableSummary(list);
    return available
      ? `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Reusable: ${available}.`
      : `Delegation "${resume}" has no recorded history in this conversation and cannot be continued. Start a new delegation.`;
  }

  private install(chain: DelegationChain): void {
    this.chains.set(chain.delegateSessionId, chain);
    for (const id of chain.delegationIds) {
      this.byDelegationId.set(id, chain.delegateSessionId);
    }
  }

  private evictOverflow(): void {
    const byAgent = new Map<string, DelegationChain[]>();
    for (const chain of this.chains.values()) {
      const group = byAgent.get(chain.agentName) ?? [];
      group.push(chain);
      byAgent.set(chain.agentName, group);
    }
    for (const group of byAgent.values()) {
      // A working chain is never evicted: dropping it would strand the delegate
      // still writing into it, and the bound counts reusable chains anyway. Any
      // overflow those chains caused is resolved the moment they settle,
      // because `settle` runs this again (ADR 0279 §7).
      const settled = group
        .filter((chain) => chain.latestStatus !== "running")
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
      for (const stale of settled.slice(MAX_RESUMABLE_CHAINS_PER_AGENT)) {
        this.drop(stale.delegateSessionId);
      }
    }
  }
}

/** `<agent> / <delegationId>` pairs for an error message's hint. */
function resumableSummary(list: readonly ResumableChain[]): string {
  return list
    .map((chain) => `${chain.agentName} / ${chain.latestDelegationId}`)
    .join(", ");
}
