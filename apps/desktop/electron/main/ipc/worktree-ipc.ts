/**
 * Isolated-session worktree channels (ADR 0329).
 *
 * A thin pass-through to host-core's `worktree.*` methods: host-core owns every
 * git command and every worktree path. The renderer names a session or a
 * project and never receives a worktree path; "Reveal" resolves the path here
 * and hands it straight to the OS file manager.
 */
import { ErrorCodes, IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "./types";

export type WorktreeIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  openPath: (path: string) => Promise<string>;
  stripWinLongPrefix: (path: string) => string;
};

function requiredText(input: unknown, field: string): string {
  const value =
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw Object.assign(new Error(`${field} required`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  return text;
}

export function registerWorktreeIpc({
  registrar,
  getHost,
  logger,
  openPath,
  stripWinLongPrefix,
}: WorktreeIpcDependencies): void {
  const host = (): HostProcess => {
    const current = getHost();
    if (!current) throw new Error("host unavailable");
    return current;
  };

  registrar.handle(IPC.invoke.worktreeProbe, async (input: unknown) =>
    host().call("worktree.probe", { projectPath: requiredText(input, "projectPath") }),
  );

  registrar.handle(IPC.invoke.worktreePreview, async (input: unknown) => {
    const result = await host().call<{ preview: unknown }>("worktree.preview", {
      sessionId: requiredText(input, "sessionId"),
    });
    return result.preview;
  });

  registrar.handle(IPC.invoke.worktreeMerge, async (input: unknown) => {
    const sessionId = requiredText(input, "sessionId");
    const result = await host().call<{ outcome: unknown }>("worktree.merge", {
      sessionId,
      previewToken: requiredText(input, "previewToken"),
    });
    logger.app("session", "info", "isolated session merged into project", { sessionId });
    return result.outcome;
  });

  registrar.handle(IPC.invoke.worktreeBehind, async (input: unknown) => {
    const result = await host().call<{ commits: number }>("worktree.behind", {
      sessionId: requiredText(input, "sessionId"),
    });
    return result.commits;
  });

  registrar.handle(IPC.invoke.worktreeBehindAll, async () =>
    host().call("worktree.behindAll", {}),
  );

  registrar.handle(IPC.invoke.worktreeSync, async (input: unknown) => {
    const sessionId = requiredText(input, "sessionId");
    const result = await host().call<{ outcome: unknown }>("worktree.sync", { sessionId });
    logger.app("session", "info", "isolated session synced from project", { sessionId });
    return result.outcome;
  });

  registrar.handle(IPC.invoke.worktreePendingWork, async (input: unknown) => {
    const result = await host().call<{ pending: unknown }>("worktree.pendingWork", {
      sessionId: requiredText(input, "sessionId"),
    });
    return result.pending;
  });

  registrar.handle(IPC.invoke.worktreeSetupLog, async (input: unknown) =>
    host().call("worktree.setupLog", { sessionId: requiredText(input, "sessionId") }),
  );

  registrar.handle(IPC.invoke.worktreeReveal, async (input: unknown) => {
    const result = await host().call<{ path: string }>("worktree.location", {
      sessionId: requiredText(input, "sessionId"),
    });
    const openError = await openPath(stripWinLongPrefix(result.path));
    if (openError) throw new Error(openError);
    return { ok: true };
  });

  registrar.handle(IPC.invoke.worktreeSetupCommandGet, async (input: unknown) =>
    host().call("worktree.setupCommand.get", {
      projectPath: requiredText(input, "projectPath"),
    }),
  );

  registrar.handle(IPC.invoke.worktreeSetupCommandSet, async (input: unknown) => {
    const command =
      input && typeof input === "object"
        ? (input as Record<string, unknown>).command
        : undefined;
    if (command !== undefined && command !== null && typeof command !== "string") {
      throw Object.assign(new Error("command must be a string"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return host().call("worktree.setupCommand.set", {
      projectPath: requiredText(input, "projectPath"),
      command: typeof command === "string" ? command : null,
    });
  });
}
