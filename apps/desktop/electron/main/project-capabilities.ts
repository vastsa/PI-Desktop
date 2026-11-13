import {
  parseProjectCapabilities,
  type ProjectCapabilities,
  type ProjectGroupContext,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";

/** An unavailable host must not widen a saved project selection. */
export async function loadProjectContext(
  host: Pick<HostProcess, "call"> | null,
  projectPath: string | null | undefined,
): Promise<{ context?: ProjectGroupContext | null }> {
  if (!projectPath) return { context: null };
  if (!host) throw new Error("host unavailable");
  return host.call<{ context?: ProjectGroupContext | null }>("project.group.context", { path: projectPath });
}

/** Read on each launch/dispatch rather than caching an authorization snapshot. */
export async function loadProjectCapabilities(
  host: Pick<HostProcess, "call"> | null,
  projectPath: string | null | undefined,
): Promise<ProjectCapabilities | undefined> {
  const result = await loadProjectContext(host, projectPath);
  return parseProjectCapabilities(result.context?.capabilities);
}
