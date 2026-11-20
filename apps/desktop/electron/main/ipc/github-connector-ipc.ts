/**
 * The GitHub connector's IPC surface (ADR github-connector).
 *
 * These channels are how the renderer reaches a service that holds the user's
 * GitHub token, so the handlers are written as a boundary rather than as
 * pass-throughs:
 *
 * - Only the main window may call them. They are registered with their sender
 *   and therefore stay out of the internal invoke map, which is what the local
 *   MCP control plane and the remote-host router dispatch through.
 * - Every input is shape-checked and rebuilt from its known fields before the
 *   service sees it; a caller cannot add a host, a URL, or a client id.
 * - Every result is rebuilt from the fields the shared contract names. The
 *   service has a `token()` accessor for main-process callers; no handler
 *   calls it, and nothing a method returns beyond its DTO crosses over.
 */
import type { IpcMainInvokeEvent } from "electron";
import {
  ErrorCodes,
  IPC,
  type GitHubBranchList,
  type GitHubConnectorStatus,
  type GitHubRepositoryList,
  type GitHubRepositoryListInput,
  type GitHubRepositorySummary,
} from "@pi-desktop/shared";
import type { GitHubConnector } from "../github/connector";
import type { IpcRegistrar } from "./types";

export type GitHubConnectorIpcDependencies = {
  registrar: IpcRegistrar;
  connector: Pick<
    GitHubConnector,
    | "status"
    | "startDeviceLogin"
    | "cancelLogin"
    | "setToken"
    | "disconnect"
    | "listRepositories"
    | "listBranches"
  >;
};

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toStatus(status: GitHubConnectorStatus): GitHubConnectorStatus {
  const result: GitHubConnectorStatus = {
    connected: status.connected === true,
    deviceLoginAvailable: status.deviceLoginAvailable === true,
  };
  if (status.account && typeof status.account.login === "string") {
    result.account = { login: status.account.login };
    if (typeof status.account.name === "string") result.account.name = status.account.name;
    if (typeof status.account.avatarUrl === "string") {
      result.account.avatarUrl = status.account.avatarUrl;
    }
  }
  if (Array.isArray(status.scopes)) {
    result.scopes = status.scopes.filter((scope) => typeof scope === "string");
  }
  if (status.tokenKind === "oauth" || status.tokenKind === "pat") {
    result.tokenKind = status.tokenKind;
  }
  if (status.needsReauthentication === true) result.needsReauthentication = true;
  return result;
}

function toRepository(repository: GitHubRepositorySummary): GitHubRepositorySummary {
  const result: GitHubRepositorySummary = {
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    private: repository.private === true,
    defaultBranch: repository.defaultBranch,
    archived: repository.archived === true,
  };
  if (typeof repository.pushedAt === "string") result.pushedAt = repository.pushedAt;
  if (typeof repository.description === "string") result.description = repository.description;
  return result;
}

function toRepositoryList(list: GitHubRepositoryList): GitHubRepositoryList {
  const result: GitHubRepositoryList = {
    repositories: list.repositories.map(toRepository),
    truncated: list.truncated === true,
  };
  if (list.ssoPartial === true) result.ssoPartial = true;
  return result;
}

function toBranchList(list: GitHubBranchList): GitHubBranchList {
  const result: GitHubBranchList = {
    branches: list.branches.map((branch) => ({
      name: branch.name,
      protected: branch.protected === true,
    })),
    defaultBranch: list.defaultBranch,
    truncated: list.truncated === true,
  };
  if (list.ssoPartial === true) result.ssoPartial = true;
  return result;
}

export function registerGitHubConnectorIpc({
  registrar,
  connector,
}: GitHubConnectorIpcDependencies): void {
  /** Register a channel that only the main window may invoke. */
  const handle = (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    registrar.handleWithEvent(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      registrar.assertMainWindowSender(event);
      return handler(...args);
    });
  };

  handle(IPC.invoke.githubConnectorStatus, async () => toStatus(await connector.status()));

  handle(IPC.invoke.githubConnectorLoginStart, async (input) => {
    const { allowWorkflowScope } = asRecord(input, "login input");
    if (typeof allowWorkflowScope !== "boolean") {
      throw invalidArgument("allowWorkflowScope must be a boolean");
    }
    const { loginId } = await connector.startDeviceLogin({ allowWorkflowScope });
    return { loginId };
  });

  handle(IPC.invoke.githubConnectorLoginCancel, async (loginId) => {
    if (typeof loginId !== "string" || loginId.length === 0) {
      throw invalidArgument("loginId must be a non-empty string");
    }
    return { ok: (await connector.cancelLogin(loginId)) === true };
  });

  handle(IPC.invoke.githubConnectorSetToken, async (input) => {
    const { token } = asRecord(input, "token input");
    // The message names the field, never its value.
    if (typeof token !== "string") throw invalidArgument("token must be a string");
    return toStatus(await connector.setToken(token));
  });

  handle(IPC.invoke.githubConnectorDisconnect, async () => toStatus(await connector.disconnect()));

  handle(IPC.invoke.githubRepositories, async (input) => {
    const filter: GitHubRepositoryListInput = {};
    if (input !== undefined && input !== null) {
      const { query, refresh } = asRecord(input, "repository filter");
      if (query !== undefined) {
        if (typeof query !== "string") throw invalidArgument("query must be a string");
        filter.query = query;
      }
      if (refresh !== undefined) {
        if (typeof refresh !== "boolean") throw invalidArgument("refresh must be a boolean");
        filter.refresh = refresh;
      }
    }
    return toRepositoryList(await connector.listRepositories(filter));
  });

  handle(IPC.invoke.githubBranches, async (input) => {
    const { owner, name } = asRecord(input, "repository");
    if (typeof owner !== "string" || typeof name !== "string") {
      throw invalidArgument("owner and name must be strings");
    }
    return toBranchList(await connector.listBranches({ owner, name }));
  });
}
