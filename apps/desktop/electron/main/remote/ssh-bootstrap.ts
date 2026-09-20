/**
 * SSH bootstrap: install and pair a `pi-host` on a machine the user already
 * reaches over SSH (spec `02-architecture/05-remote-agent-control.md` §5.2,
 * security `05-security/02-remote-control-security.md` §3.4).
 *
 * The five steps mirror the spec exactly:
 *
 * 1. probe the remote with `uname` so the artifact is chosen for *its*
 *    platform, not the desktop's;
 * 2. resolve the bundle at the desktop's version and read the SHA-256 the
 *    release publishes — the desktop holds the trust anchor and never uploads
 *    executable bytes;
 * 3. upload the bootstrap script through the SSH channel and run it, which
 *    installs under the remote user's home and starts the host on loopback
 *    with a single-use pairing token;
 * 4. forward a loopback port on this machine to the host's loopback port;
 * 5. spend the pairing token over that forward for a durable device token.
 *
 * Everything that touches the outside world is injected, so the whole flow is
 * exercised in tests against a fake transport and a fake pairing exchange.
 */
import {
  ErrorCodes,
  type RemoteHostBootstrapRequest,
  type RemoteHostSshMetadata,
} from "@pi-desktop/shared";
import {
  buildBootstrapScript,
  parseBootstrapOutput,
  redactBootstrapOutput,
} from "./pi-host-bootstrap-script.js";
import {
  isPublishedTarget,
  parseChecksumFile,
  piHostArtifactName,
  piHostArtifactUrls,
  piHostBundleDir,
  resolveTarget,
  targetKey,
  versionsMatch,
} from "./pi-host-release.js";
import {
  assertSshArgument,
  createSystemSshTransport,
  reserveLocalPort,
  type SshForward,
  type SshTarget,
  type SshExecResult,
  type SshTransport,
} from "./ssh-transport.js";
import { assertSshPassword } from "./ssh-askpass.js";
import { racpUrlForLocalPort } from "./ssh-tunnel.js";

/** Progress the Settings surface can render while a bootstrap runs. */
export type SshBootstrapStep =
  | "probe"
  | "resolve-release"
  | "download-checksum"
  | "install"
  | "forward"
  | "pair";

export type SshBootstrapDeps = {
  /** Release version the desktop runs; the bundle must exist for this tag. */
  version: string;
  /** Build the SSH transport for one target. Defaults to the system `ssh`. */
  buildTransport?: (target: SshTarget) => SshTransport;
  /** Read the published `.sha256` text. Defaults to an HTTPS GET. */
  fetchChecksum?: (url: string) => Promise<string>;
  /** Reserve the loopback port the forward binds. */
  reservePort?: () => Promise<number>;
  /**
   * Exchange the single-use pairing token for a durable device token over the
   * forwarded port. The boot layer injects this because it owns the RACP
   * client factory.
   */
  exchangePairing: (input: {
    url: string;
    pairingToken: string;
    label: string;
  }) => Promise<string>;
  /** Called once per completed step, in order. */
  onProgress?: (step: SshBootstrapStep) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** How long the script waits for the ready and pairing lines. */
  readyTimeoutSec?: number;
  /** Budget for the whole remote script, download included. */
  installTimeoutMs?: number;
};

export type SshBootstrapOutcome = {
  hostKey: string;
  label: string;
  /** Live forward; the caller adopts it and owns closing it. */
  forward: SshForward;
  /** The loopback RACP endpoint the pairing exchange used. */
  url: string;
  deviceToken: string;
  ssh: RemoteHostSshMetadata;
  /**
   * The login password the forward was opened with, when the user chose
   * password auth. The caller persists it encrypted; it is never placed in
   * `ssh` (which is echoed back to the renderer) and never logged.
   */
  sshSecret?: string;
  /** Steps that completed, in order. */
  steps: SshBootstrapStep[];
};

export type SshBootstrap = {
  bootstrap(request: RemoteHostBootstrapRequest): Promise<SshBootstrapOutcome>;
};

const DEFAULT_READY_TIMEOUT_SEC = 120;
/**
 * Budget for the whole remote script. It must exceed the script's own worst
 * case — its `curl --max-time` plus the ready-timeout poll — or a slow
 * download would be killed from here and reported as a generic timeout.
 */
const DEFAULT_INSTALL_TIMEOUT_MS = 900_000;

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}), data });
}

const REMOTE_STEP_MESSAGES: Record<string, string> = {
  "missing-node": "the remote machine has no Node.js; pi-host needs Node.js 22 or newer",
  "node-too-old": "the remote Node.js is too old; pi-host needs Node.js 22 or newer",
  "download-failed": "the remote machine could not download the pi-host bundle from GitHub",
  "checksum-mismatch": "the downloaded pi-host bundle did not match the published SHA-256",
  "missing-tar": "the remote machine has no tar",
  "install-failed": "the remote pi-host install.sh failed",
  "ready-timeout": "the remote pi-host started but did not become ready in time",
  "host-exited": "the remote pi-host process exited before it became ready",
  "host-start-failed": "the remote pi-host process failed to start",
};

function remoteStepMessage(step: string): string {
  return REMOTE_STEP_MESSAGES[step] ?? `the remote bootstrap failed at '${step}'`;
}

/**
 * Stable routing key for a bootstrapped host. It lands inside
 * `remote:<hostKey>:<hostSessionId>`, so a colon would break the id — an IPv6
 * literal is folded to dashes rather than rejected, because the user typed it
 * in good faith and the key is only a routing label.
 */
export function synthesizeSshHostKey(ssh: SshTarget, label: string): string {
  const host = ssh.host.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = host ? `ssh-${host}` : "ssh-host";
  return slug ? `${base}-${slug}` : base;
}

/** Translate the renderer request into the descriptor that gets persisted. */
export function sshMetadataFromTarget(target: SshTarget): Omit<RemoteHostSshMetadata, "remotePort" | "version"> {
  return {
    host: target.host,
    ...(target.port !== undefined ? { port: target.port } : {}),
    ...(target.user ? { user: target.user } : {}),
    ...(target.identityFile ? { identityFile: target.identityFile } : {}),
    // Only recorded when it is not the default: a key-authenticated descriptor
    // keeps exactly the shape it had before password auth existed, so no
    // existing `remote-hosts.json` entry changes on its next write. A later
    // launch reads the field to know a secret is needed, so it can say so
    // plainly instead of failing as a bare authentication error.
    ...(target.password !== undefined ? { auth: "password" as const } : {}),
  };
}

async function defaultFetchChecksum(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw fail(`published checksum could not be downloaded (HTTP ${response.status})`, ErrorCodes.HOST_BOOTSTRAP_FAILED, {
      url,
      status: response.status,
    });
  }
  return await response.text();
}

function validateTarget(request: RemoteHostBootstrapRequest): SshTarget {
  const host = assertSshArgument(String(request?.host ?? ""), "host");
  const target: SshTarget = { host };
  if (request?.port !== undefined && request.port !== null) {
    const port = Number(request.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw fail("port must be an integer between 1 and 65535", ErrorCodes.INVALID_ARGUMENT, {
        field: "port",
      });
    }
    target.port = port;
  }
  if (request?.user) target.user = assertSshArgument(String(request.user), "user");
  if (request?.identityFile) {
    target.identityFile = assertSshArgument(String(request.identityFile), "identityFile");
  }
  // The one secret in the request. It is validated here rather than trusted
  // because it cannot survive a line break through the askpass helper, and a
  // value that cannot work should be refused before a remote script runs.
  if (request?.password !== undefined && request.password !== null) {
    target.password = assertSshPassword(request.password);
  }
  return target;
}

/**
 * The port `pi-host` binds on the remote machine. Absent or `0` means "pick a
 * free one and report it", which is what the bootstrap normally wants; a
 * pinned port is range-checked here so it cannot reach the script as an
 * argument like `--port -5`.
 */
function resolveRemotePort(request: RemoteHostBootstrapRequest): number {
  const raw = request?.remotePort;
  if (raw === undefined || raw === null) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw fail(
      "remotePort must be an integer between 0 and 65535",
      ErrorCodes.INVALID_ARGUMENT,
      { field: "remotePort" },
    );
  }
  return port;
}

export function createSshBootstrap(deps: SshBootstrapDeps): SshBootstrap {
  const log = deps.log ?? (() => undefined);
  const buildTransport =
    deps.buildTransport ??
    ((target: SshTarget) =>
      createSystemSshTransport(target, {
        log: (level, message, data) => log(level, message, data),
      }));
  const fetchChecksum = deps.fetchChecksum ?? defaultFetchChecksum;
  const reservePort = deps.reservePort ?? reserveLocalPort;
  const readyTimeoutSec = deps.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC;
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  return {
    async bootstrap(request) {
      const label = String(request?.label ?? "").trim() || "remote host";
      const target = validateTarget(request);
      const hostKey = (request?.hostKey ?? "").trim() || synthesizeSshHostKey(target, label);
      if (hostKey.includes(":")) {
        throw fail("hostKey must not contain ':'", ErrorCodes.INVALID_ARGUMENT, { field: "hostKey" });
      }

      const steps: SshBootstrapStep[] = [];
      const mark = (step: SshBootstrapStep): void => {
        steps.push(step);
        deps.onProgress?.(step);
      };

      const transport = buildTransport(target);
      let completed = false;
      try {
        // 1. Ask the remote machine what it is.
        mark("probe");
        const probe = await transport.exec("uname -s && uname -m");
        const remoteTarget = resolveTarget(probe.stdout);
        if (!remoteTarget) {
          throw fail(
            "the remote platform could not be identified",
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            { uname: probe.stdout.trim().slice(0, 200) },
          );
        }
        if (!isPublishedTarget(remoteTarget)) {
          throw fail(
            `no pi-host bundle is published for ${targetKey(remoteTarget)}`,
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            { target: targetKey(remoteTarget) },
          );
        }

        // 2. Resolve the artifact and the digest the release published for it.
        mark("resolve-release");
        const urls = piHostArtifactUrls(deps.version, remoteTarget);
        const artifactName = piHostArtifactName(deps.version, remoteTarget);
        mark("download-checksum");
        const expectedSha256 = parseChecksumFile(await fetchChecksum(urls.checksum), artifactName);
        if (!expectedSha256) {
          throw fail(
            `no usable SHA-256 published for ${artifactName}`,
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            { url: urls.checksum },
          );
        }

        // 3. Upload and run the script. It downloads the bundle itself, so no
        //    executable bytes travel over this channel.
        mark("install");
        const script = buildBootstrapScript({
          version: deps.version,
          artifactUrl: urls.tarball,
          artifactName,
          bundleDir: piHostBundleDir(deps.version, remoteTarget),
          expectedSha256,
          port: resolveRemotePort(request),
          pairingLifetimeMs: 600_000,
          readyTimeoutSec,
        });
        let result: SshExecResult;
        try {
          result = await transport.execWithInput("sh -s", script, {
            timeoutMs: installTimeoutMs,
          });
        } catch (error) {
          // The script names the step it failed at on stdout even when it
          // exits non-zero, and the transport carries that stdout on the
          // error. Surfacing it is the difference between "exit code 1" and
          // "checksum-mismatch" in the user's toast.
          const reported = parseBootstrapOutput(
            String((error as { stdout?: unknown }).stdout ?? ""),
          );
          if (!reported.failure) throw error;
          throw fail(remoteStepMessage(reported.failure), ErrorCodes.HOST_BOOTSTRAP_FAILED, {
            step: reported.failure,
            stderr: String((error as { stderr?: unknown }).stderr ?? "").slice(-2000),
          });
        }
        const parsed = parseBootstrapOutput(result.stdout);
        if (parsed.failure) {
          throw fail(remoteStepMessage(parsed.failure), ErrorCodes.HOST_BOOTSTRAP_FAILED, {
            step: parsed.failure,
            stderr: result.stderr.slice(-2000),
          });
        }
        if (!parsed.ready || !parsed.pairing) {
          throw fail(
            "the remote bootstrap produced no ready/pairing output",
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            {
              stdout: redactBootstrapOutput(result.stdout).slice(-2000),
              stderr: result.stderr.slice(-2000),
            },
          );
        }
        if (!versionsMatch(parsed.ready.version, deps.version)) {
          throw fail(
            `the remote host runs ${parsed.ready.version}; this desktop runs ${deps.version}`,
            ErrorCodes.HOST_VERSION_MISMATCH,
            { remote: parsed.ready.version, local: deps.version },
          );
        }

        // 4. Forward a loopback port to the host's loopback port.
        mark("forward");
        const localPort = await reservePort();
        const forward = await transport.forward({
          localPort,
          remoteHost: "127.0.0.1",
          remotePort: parsed.ready.port,
        });
        const url = racpUrlForLocalPort(localPort);

        // 5. Spend the pairing token over the forward.
        mark("pair");
        let deviceToken: string;
        try {
          deviceToken = await deps.exchangePairing({
            url,
            pairingToken: parsed.pairing.token,
            label,
          });
        } catch (error) {
          await forward.close().catch(() => undefined);
          throw error;
        }

        const ssh: RemoteHostSshMetadata = {
          ...sshMetadataFromTarget(target),
          remotePort: parsed.ready.port,
          version: parsed.ready.version,
        };
        completed = true;
        log("info", "ssh bootstrap completed", {
          hostKey,
          url,
          version: ssh.version,
          auth: ssh.auth,
        });
        return {
          hostKey,
          label,
          forward,
          url,
          deviceToken,
          ssh,
          // Handed to the caller to encrypt, never logged and never returned
          // to the renderer.
          ...(target.password !== undefined ? { sshSecret: target.password } : {}),
          steps,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log("error", "ssh bootstrap failed", {
          host: target.host,
          message: err.message,
          errorCode: (error as { errorCode?: string }).errorCode,
          step: (error as { step?: string }).step,
          stderr: String((error as { stderr?: string }).stderr ?? "").slice(-500),
        });
        throw error;
      } finally {
        // On success the caller adopts the forward, which is a child of this
        // transport — disposing here would tear down the tunnel it just got.
        if (!completed) transport.dispose();
      }
    },
  };
}
