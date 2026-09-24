/**
 * Renderer IPC for the R2b pairing UX (ADR 0286 §Registry) and the SSH
 * bootstrap (spec `02-architecture/05-remote-agent-control.md` §5.2).
 *
 * Four channels sit between the renderer's Settings page and the remote-hosts
 * boot hook: `list` reports the currently paired hosts with their live status,
 * `pair` exchanges a pasted `ppt1.` pairing token for a durable device token,
 * `bootstrap` installs and pairs a host on a machine the user reaches over
 * SSH, and `remove` closes and forgets one host.
 *
 * The renderer never sees a device token: the pairing exchange, the encrypted
 * write to `<dataDir>/remote-hosts.json`, and every subsequent live connection
 * live inside Electron main. `list` is safe to expose to any renderer surface.
 * The bootstrap channel never sees an SSH secret either — it passes a host,
 * and the system `ssh` client supplies the credentials from the user's own
 * configuration and agent.
 */
import {
  ErrorCodes,
  IPC,
  type RemoteHostBootstrapRequest,
  type RemoteHostBootstrapResult,
  type RemoteHostPairRequest,
  type RemoteHostPairResult,
  type RemoteHostRemoveRequest,
  type RemoteHostSummary,
  type RemoteProjectBrowseRequest,
  type RemoteProjectBrowseResult,
  type RemoteProjectListRequest,
  type RemoteProjectListResult,
  type RemoteProjectRegisterRequest,
  type RemoteProjectRegisterResult,
  type RemoteSessionCreateRequest,
  type RemoteSessionCreateResult,
} from "@pi-desktop/shared";
import { app } from "electron";
import {
  getActiveRemoteHostsBoot,
  type RemoteHostsBoot,
} from "../bootstrap/remote-hosts";
import { normalizeRemoteError } from "../remote/backend-router";
import { exchangePairingToken } from "../remote/racp-remote-host-client";
import type { IpcRegistrar } from "./types";

export type RegisterRemoteHostIpcOptions = {
  registrar: IpcRegistrar;
  /**
   * Optional overrides for tests. Production reads the boot singleton set by
   * `bootstrap/startup.ts` (so no new field flows through `index.ts`) and
   * derives `clientInfo` from Electron's app name/version.
   */
  getRemoteHostsBoot?: () => RemoteHostsBoot | null;
  clientInfo?: { name: string; version: string };
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function requireBoot(boot: RemoteHostsBoot | null): RemoteHostsBoot {
  if (!boot) {
    throw Object.assign(new Error("remote hosts are not ready yet"), {
      errorCode: ErrorCodes.AGENT_UNAVAILABLE,
    });
  }
  return boot;
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message: string, field?: string): Error {
  return Object.assign(new Error(message), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
    ...(field ? { field } : {}),
  });
}

/** Longest host path accepted for browse and register. */
const MAX_REMOTE_PATH = 4096;
const MAX_REMOTE_ID = 256;
const MAX_SESSION_TITLE = 200;

/** A routing key of a paired host; the `:` would break remote session ids. */
function requireHostKey(value: unknown): string {
  const hostKey = trim(value);
  if (!hostKey || hostKey.length > MAX_REMOTE_ID || hostKey.includes(":")) {
    throw invalid("a valid hostKey is required", "hostKey");
  }
  return hostKey;
}

function optionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const path = trim(value);
  if (path.length > MAX_REMOTE_PATH || path.includes("\0")) throw invalid("path is invalid", "path");
  return path || undefined;
}

/** Run a host request, surfacing the host's error code instead of INTERNAL. */
async function remote<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw normalizeRemoteError(error);
  }
}

/**
 * Derive a routing key from a URL and a label when the renderer did not
 * supply one. The URL's hostname keeps the key readable in logs; the label's
 * ASCII-safe slug disambiguates two hosts on the same machine (e.g., a WSL
 * and a native install of `pi-host` on `localhost`).
 */
function synthesizeHostKey(url: string, label: string): string {
  let hostname = "host";
  try {
    hostname = new URL(url).hostname || hostname;
  } catch {
    /* keep the fallback */
  }
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug ? `${hostname}-${slug}` : hostname;
}

export function registerRemoteHostIpc(options: RegisterRemoteHostIpcOptions): void {
  const { registrar } = options;
  const getRemoteHostsBoot = options.getRemoteHostsBoot ?? getActiveRemoteHostsBoot;
  const clientInfo =
    options.clientInfo ?? { name: app.getName(), version: app.getVersion() };
  const log = options.log ?? (() => undefined);

  registrar.handle(
    IPC.invoke.remoteHostList,
    async (): Promise<{ hosts: RemoteHostSummary[] }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      return { hosts: await boot.list() };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostPair,
    async (request: RemoteHostPairRequest): Promise<RemoteHostPairResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const url = trim(request?.url);
      const pairingToken = trim(request?.pairingToken);
      const label = trim(request?.label) || "desktop";
      if (!url || !pairingToken) {
        throw invalid("url and pairingToken are required");
      }
      const hostKey = trim(request?.hostKey) || synthesizeHostKey(url, label);
      if (hostKey.includes(":")) {
        throw invalid("hostKey must not contain ':'", "hostKey");
      }

      // Pair on a throwaway connection whose transport authenticates with the
      // single-use pairing token; call `connection/pair` for the device token,
      // then close it. The durable connection reopens under the device token
      // via `boot.addHost` below.
      const deviceToken = await exchangePairingToken({
        url,
        pairingToken,
        label,
        clientInfo,
        log: (level, message, data) => log(level, message, data),
      });

      const summary = await boot.addHost({ hostKey, label, url, deviceToken });
      return { host: summary };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostBootstrap,
    async (request: RemoteHostBootstrapRequest): Promise<RemoteHostBootstrapResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const host = trim(request?.host);
      if (!host) throw invalid("host is required", "host");
      const label = trim(request?.label) || host;
      // The descriptor's own validation (empty and leading-dash fields, port
      // range) lives with the bootstrap, which is the only place that knows
      // how the values reach the `ssh` command line.
      return await boot.bootstrapHost({ ...request, host, label });
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostRemove,
    async (request: RemoteHostRemoveRequest): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) {
        throw invalid("hostKey is required", "hostKey");
      }
      await boot.removeHost(hostKey);
      return { ok: true };
    },
  );

  registrar.handle(
    IPC.invoke.remoteProjectList,
    async (request: RemoteProjectListRequest): Promise<RemoteProjectListResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = requireHostKey(request?.hostKey);
      return { projects: await remote(() => boot.listProjects(hostKey)) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteProjectBrowse,
    async (request: RemoteProjectBrowseRequest): Promise<RemoteProjectBrowseResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = requireHostKey(request?.hostKey);
      const path = optionalPath(request?.path);
      // The host bounds the listing to its own browse root.
      return await remote(() => boot.browseProject(hostKey, path));
    },
  );

  registrar.handle(
    IPC.invoke.remoteProjectRegister,
    async (request: RemoteProjectRegisterRequest): Promise<RemoteProjectRegisterResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = requireHostKey(request?.hostKey);
      const path = optionalPath(request?.path);
      if (!path) throw invalid("path is required", "path");
      return { project: await remote(() => boot.registerProject(hostKey, path)) };
    },
  );

  registrar.handle(
    IPC.invoke.remoteSessionCreate,
    async (request: RemoteSessionCreateRequest): Promise<RemoteSessionCreateResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = requireHostKey(request?.hostKey);
      const projectId = trim(request?.projectId);
      if (!projectId || projectId.length > MAX_REMOTE_ID) {
        throw invalid("projectId is required", "projectId");
      }
      const title = trim(request?.title).slice(0, MAX_SESSION_TITLE) || undefined;
      return { session: await remote(() => boot.createSession(hostKey, projectId, title)) };
    },
  );
}
