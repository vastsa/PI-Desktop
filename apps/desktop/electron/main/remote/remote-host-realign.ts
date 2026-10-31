/**
 * Version realignment for paired SSH hosts (spec `02-architecture/05-remote-agent-control.md`
 * §5.2, ADR 0327).
 *
 * A paired Host is pinned to the desktop release that installed it: the bundle
 * carries the desktop's version, is reused only when the release receipt and
 * every installed file still match, and answers the readiness probe with its
 * own version. When the desktop moves ahead — or when the installed bundle
 * predates a capability the desktop now requires, which is a *same*-version
 * mismatch — the Host is refused with `HOST_VERSION_MISMATCH`. Until now that
 * left the user with an "upgrade the remote Host" toast and no way to act on
 * it short of removing and re-adding the host, losing the pairing.
 *
 * This module owns the missing step: re-run the same verified SSH bootstrap
 * with the stored SSH descriptor and the encrypted login password, so the
 * remote machine ends up on the desktop's release and is re-paired in place.
 * The trust anchor is unchanged — the artifact is still fetched on the remote
 * side from the desktop's release tag and verified against the published
 * SHA-256 before it is installed.
 *
 * Automatic attempts are throttled per host and desktop release. The result is
 * persisted as non-secret registry metadata, so an unsuccessful Host is not
 * restarted again on every app launch; failures cool down before retry. A user
 * action that explicitly asks for a reconnect bypasses the throttle.
 */
import type { RemoteHostBootstrapRequest, RemoteHostSshMetadata } from "@pi-desktop/shared";
import { sshMetadataOf } from "./remote-host-metadata.js";
import type { RemoteHostRecord } from "./remote-host-registry.js";
import type { SshBootstrapOutcome } from "./ssh-bootstrap.js";

/**
 * How long a failed automatic attempt suppresses the next one. The desktop
 * release is part of the throttle key, so shipping a new version retries
 * immediately; this window only covers transient failures at the same release.
 */
export const REALIGN_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * `attempt` is the only decision that may start remote work. The others are
 * reported so the caller can log *why* nothing happened without inventing a
 * user-visible failure for a state the user cannot act on either.
 */
export type RealignDecision =
  | "attempt"
  | "no-ssh-descriptor"
  | "no-credentials"
  | "aligned"
  | "cooldown";

export type RemoteHostRealignerOptions = {
  /** Desktop release the remote Host must match. */
  version: string;
  /** The verified SSH bootstrap, injected so tests never spawn `ssh`. */
  bootstrap: (
    request: RemoteHostBootstrapRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<SshBootstrapOutcome>;
  /** Persist the re-paired record before the caller reconnects with it. */
  upsert: (record: RemoteHostRecord) => Promise<void>;
  now?: () => number;
  log?: (level: "info" | "warn", message: string, data?: unknown) => void;
};

export type RemoteHostRealignResult = {
  /** The refreshed record: new loopback URL, device token, and SSH descriptor. */
  record: RemoteHostRecord;
  /** Live forward the bootstrap opened; the caller adopts or closes it. */
  outcome: SshBootstrapOutcome;
};

export type RemoteHostRealigner = {
  /** Pure decision; `force` is the user asking for an explicit reconnect. */
  decide(record: RemoteHostRecord, options?: { force?: boolean }): RealignDecision;
  /** `null` means nothing was attempted or the attempt failed; callers then
   * surface the original readiness failure unchanged. */
  realign(
    record: RemoteHostRecord,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<RemoteHostRealignResult | null>;
};

/** Rebuild the request the original pairing used, minus its single-use secret. */
function bootstrapRequestFor(
  record: RemoteHostRecord,
  ssh: RemoteHostSshMetadata,
  password: string | undefined,
): RemoteHostBootstrapRequest {
  return {
    // The pairing identity is reused on purpose: this is the same Host, being
    // brought up to the desktop's release, not a second machine.
    hostKey: record.hostKey,
    label: record.label,
    host: ssh.host,
    ...(ssh.port !== undefined ? { port: ssh.port } : {}),
    ...(ssh.user ? { user: ssh.user } : {}),
    ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
    ...(password ? { password } : {}),
    // A fresh loopback port: the replacement Host is a new process, and pinning
    // the previous port could collide with the predecessor it replaces.
    remotePort: 0,
  };
}

type RealignAttempt = { version: string; at: number; succeeded: boolean };
const REALIGNMENT_METADATA_KEY = "piHostRealignment";

/** Read a bounded, non-secret realignment receipt from the extensible record metadata. */
function persistedAttempt(record: RemoteHostRecord): RealignAttempt | undefined {
  const value = record.metadata?.[REALIGNMENT_METADATA_KEY];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== "string" || !candidate.version.trim()
      || typeof candidate.at !== "number" || !Number.isFinite(candidate.at)
      || typeof candidate.succeeded !== "boolean") return undefined;
  return { version: candidate.version, at: candidate.at, succeeded: candidate.succeeded };
}

function withPersistedAttempt(record: RemoteHostRecord, attempt: RealignAttempt): RemoteHostRecord {
  return {
    ...record,
    metadata: { ...(record.metadata ?? {}), [REALIGNMENT_METADATA_KEY]: attempt },
  };

}
export function createRemoteHostRealigner(
  options: RemoteHostRealignerOptions,
): RemoteHostRealigner {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const attempts = new Map<string, RealignAttempt>();

  const decide = (
    record: RemoteHostRecord,
    { force = false }: { force?: boolean } = {},
  ): RealignDecision => {
    const ssh = sshMetadataOf(record);
    if (!ssh) return "no-ssh-descriptor";
    // A password-authenticated descriptor whose secret is gone cannot be
    // replayed: `BatchMode=yes` would fail later with a worse message than the
    // version mismatch the user is already looking at.
    if (ssh.auth === "password" && !record.sshSecret) return "no-credentials";
    if (force) return "attempt";
    const attempt = attempts.get(record.hostKey) ?? persistedAttempt(record);
    if (!attempt || attempt.version !== options.version) return "attempt";
    if (attempt.succeeded) return "aligned";
    return now() - attempt.at < REALIGN_RETRY_AFTER_MS ? "cooldown" : "attempt";
  };

  return {
    decide,
    async realign(record, { force = false, signal } = {}) {
      if (decide(record, { force }) !== "attempt") return null;
      const ssh = sshMetadataOf(record);
      if (!ssh) return null;
      let outcome: SshBootstrapOutcome | undefined;
      try {
        outcome = await options.bootstrap(
          bootstrapRequestFor(record, ssh, record.sshSecret),
          { ...(signal ? { signal } : {}) },
        );
        const sshSecret = outcome.sshSecret ?? record.sshSecret;
        const success: RealignAttempt = { version: options.version, at: now(), succeeded: true };
        const next: RemoteHostRecord = {
          hostKey: record.hostKey,
          label: record.label,
          url: outcome.url,
          deviceToken: outcome.deviceToken,
          // The password the bootstrap just used stays the stored one. It is
          // only dropped when neither side has one, so a key-authenticated
          // record keeps exactly the shape it had before.
          ...(sshSecret ? { sshSecret } : {}),
          metadata: {
            ...(record.metadata ?? {}),
            transport: "ssh",
            ssh: outcome.ssh,
            [REALIGNMENT_METADATA_KEY]: success,
          },
        };
        await options.upsert(next);
        attempts.set(record.hostKey, success);
        log("info", "remote host realigned to the desktop release", {
          hostKey: record.hostKey,
          version: outcome.ssh.version,
        });
        return { record: next, outcome };
      } catch (error) {
        const failed: RealignAttempt = { version: options.version, at: now(), succeeded: false };
        if (!signal?.aborted) attempts.set(record.hostKey, failed);
        // The re-paired record never reached the caller, so this call still
        // owns the forward the bootstrap opened.
        if (outcome) {
          try {
            await outcome.forward.close();
          } catch (closeError) {
            log("warn", "realignment forward close failed", { error: String(closeError) });
          }
        }
        // Persist the failure throttle across app restarts. A cancelled
        // bootstrap during shutdown is not a failed upgrade attempt.
        if (!signal?.aborted) {
          try {
            await options.upsert(withPersistedAttempt(record, failed));
          } catch (persistError) {
            log("warn", "realignment throttle receipt could not be persisted", {
              hostKey: record.hostKey,
              error: String(persistError),
            });
          }
        }
        log("warn", "remote host realignment failed", {
          hostKey: record.hostKey,
          error: String(error),
        });
        return null;
      }
    },
  };
}
