/**
 * Composition of the mode definition catalog and the mode run coordinator
 * (ADR mode-definitions). Kept out of `index.ts` so the entry stays wiring.
 */
import { IPC, type ModeCatalog } from "@pi-desktop/shared";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import type { HostProcess } from "../host-process";
import { createModeCatalogService, type ModeCatalogService } from "./mode-catalog";
import { createModeRunCoordinator, type ModeRunCoordinator } from "./mode-runs";

export type ModeServices = { catalog: ModeCatalogService; runs: ModeRunCoordinator };

export function createModeServices(deps: {
  getHost: () => HostProcess | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  logger: { app: (...args: any[]) => void };
  isQuitting: () => boolean;
}): ModeServices {
  const catalog = createModeCatalogService({
    logger: deps.logger,
    onChanged: (next: ModeCatalog) => deps.sendToRenderer(IPC.event.modesCatalogChanged, next),
  });
  const runs = createModeRunCoordinator({
    getHost: deps.getHost,
    catalog,
    startContinuation: async (sessionId, origin, content) => {
      const bridge = deps.getAgentHostBridge();
      if (!bridge) throw Object.assign(new Error("agent host unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
      return bridge.startModeContinuation(sessionId, origin, content);
    },
    abortTurn: async (sessionId) => {
      const bridge = deps.getAgentHostBridge();
      const turnId = bridge?.observeWorkTarget(sessionId);
      if (!bridge || !turnId) return;
      await bridge.agentHost.interruptTurn(DESKTOP_PRINCIPAL, turnId);
    },
    logger: deps.logger,
    isQuitting: deps.isQuitting,
  });
  return { catalog, runs };
}
