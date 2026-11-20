/**
 * Builds the app's one GitHub connector from the running main process (ADR
 * github-connector).
 *
 * The connector itself is pure; this is where it meets the app: the host-core
 * secret store, the renderer event sink, the guarded external-open helper,
 * and the quit teardown. The REST client and the device flow use the process
 * `fetch`, which main replaces with the proxy-aware one at startup.
 */
import { ErrorCodes, GITHUB_OAUTH_CLIENT_ID } from "@pi-desktop/shared";
import { onConfirmedQuit } from "../bootstrap/confirmed-quit";
import type { Logger } from "../logger";
import {
  createGitHubConnector,
  setActiveGitHubConnector,
  type GitHubConnector,
} from "./connector";
import { createGitHubConnectorStore, type HostCall } from "./connector-store";
import { runGitHubDeviceFlow } from "./device-flow";
import { createGitHubApi } from "./github-api";

export type GitHubConnectorBootDependencies = {
  getHost: () => { call: HostCall } | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  safeOpenExternal: (url: unknown) => Promise<void>;
  logger: Pick<Logger, "app">;
};

/**
 * Construct the connector, publish it as the active one, and arrange for a
 * committed quit to end any login in progress. Call once per process.
 */
export function bootGitHubConnector({
  getHost,
  sendToRenderer,
  safeOpenExternal,
  logger,
}: GitHubConnectorBootDependencies): GitHubConnector {
  const hostCall: HostCall = async (method, params) => {
    const host = getHost();
    // A host that is down must read as a failure: "not connected" would hide
    // a credential that is still in the secret store.
    if (!host) {
      throw Object.assign(new Error("host unavailable"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    return host.call(method, params);
  };
  const connector = createGitHubConnector({
    store: createGitHubConnectorStore(hostCall),
    api: createGitHubApi(),
    runDeviceFlow: runGitHubDeviceFlow,
    emit: sendToRenderer,
    clientId: process.env.PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID?.trim() || GITHUB_OAUTH_CLIENT_ID,
    openExternal: (url) => safeOpenExternal(url),
    now: () => new Date(),
    log: (level, message, data) =>
      logger.app("provider", level, message, data ? { data } : undefined),
  });
  setActiveGitHubConnector(connector);
  onConfirmedQuit(() => {
    connector.dispose();
    setActiveGitHubConnector(null);
  });
  return connector;
}
