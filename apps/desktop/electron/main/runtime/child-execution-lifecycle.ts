import type { AgentSidecar } from "../agent-sidecar";
import type { PluginRuntime } from "../plugin-runtime";

/** Child tool resources must not share the durable parent's cleanup identity. */
export function wireChildExecutionLifecycle(sidecar: AgentSidecar, deps: {
  isCurrent: () => boolean;
  isTurnDispatchable: (sessionId: string, turnId: string) => boolean;
  plugins: Pick<PluginRuntime, "broadcastEvent">;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  sessionProjects: Map<string, string | null>;
}): void {
  sidecar.setToolExecutionPolicy({
    canStart: (owner) => deps.isCurrent() && deps.isTurnDispatchable(owner.sessionId, owner.turnId),
    onEnd: (event) => {
      const payload = { sessionId: event.sessionId, turnId: event.executionOwnerId,
        parentTurnId: event.turnId, executionOwnerId: event.executionOwnerId,
        scope: "subagent", reason: event.reason };
      const project = deps.sessionProjects.get(event.sessionId) ?? null;
      const recipients = (pluginId: string) => event.pluginIds.includes(pluginId) && deps.pluginActiveInProject(pluginId, project);
      deps.plugins.broadcastEvent("subagent:executionEnded", [payload], recipients);
      // Compatibility for plugins that already release resources by ctx.turnId.
      // This is not a durable session turn and never drives Host settlement.
      deps.plugins.broadcastEvent("session:turnEnded", [payload], recipients);
    },
  });
}
