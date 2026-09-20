/**
 * Durable SSH port forwards for bootstrapped remote hosts (spec §5.2 step 4).
 *
 * A paired host is reached at `ws://127.0.0.1:<forwarded port>`, and that port
 * only exists while an `ssh -N -L` session is alive. The manager owns those
 * sessions for the lifetime of the app: one per host key, re-used while the
 * host stays paired, closed when the host is removed or the app quits.
 *
 * The forward is opened lazily by {@link SshTunnelManager.open} on the next
 * launch, and adopted from the bootstrap on the pairing path
 * ({@link SshTunnelManager.adopt}) so pairing never pays for a forward it is
 * about to throw away.
 */
import { RACP_WS_PATH, type RemoteHostSshMetadata } from "@pi-desktop/shared";
import {
  createSystemSshTransport,
  reserveLocalPort,
  type SshForward,
  type SshTarget,
  type SshTransport,
} from "./ssh-transport.js";

/** The loopback RACP endpoint a forward on `port` exposes. */
export function racpUrlForLocalPort(port: number): string {
  return `ws://127.0.0.1:${port}${RACP_WS_PATH}`;
}

/**
 * Translate a persisted descriptor into `ssh` arguments.
 *
 * `sshSecret` is the login password read back from the encrypted record and is
 * deliberately not part of {@link RemoteHostSshMetadata}: the descriptor is
 * plaintext metadata that the renderer also receives, so the secret travels
 * beside it rather than inside it.
 */
export function sshTargetOf(ssh: RemoteHostSshMetadata, sshSecret?: string): SshTarget {
  return {
    host: ssh.host,
    ...(ssh.port !== undefined ? { port: ssh.port } : {}),
    ...(ssh.user ? { user: ssh.user } : {}),
    ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
    ...(sshSecret ? { password: sshSecret } : {}),
  };
}

export type SshTunnel = {
  /** `ws://127.0.0.1:<localPort>/v1/racp/ws` for this host right now. */
  url: string;
  localPort: number;
};

export type SshTunnelManagerOptions = {
  /**
   * Build the transport for one host. Defaults to the system `ssh` client,
   * which is what makes the user's own `~/.ssh/config` and agent apply; tests
   * substitute a fake so no process is spawned. The second argument is the
   * decrypted login password, absent for a key-authenticated host.
   */
  buildTransport?: (ssh: RemoteHostSshMetadata, sshSecret?: string) => SshTransport;
  /** Reserve the loopback port `-L` binds. Injectable for deterministic tests. */
  reservePort?: () => Promise<number>;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export interface SshTunnelManager {
  /**
   * Open the forward for `hostKey`, or return the live one. `sshSecret` is the
   * decrypted login password when the host authenticates with one.
   */
  open(hostKey: string, ssh: RemoteHostSshMetadata, sshSecret?: string): Promise<SshTunnel>;
  /** Take ownership of a forward the bootstrap already opened. */
  adopt(hostKey: string, ssh: RemoteHostSshMetadata, forward: SshForward): Promise<SshTunnel>;
  /** Close the forward for one host; a missing key is a no-op. */
  close(hostKey: string): Promise<void>;
  /** Close every forward. Idempotent; safe before any `open`. */
  dispose(): Promise<void>;
}

type TunnelEntry = {
  ssh: RemoteHostSshMetadata;
  transport: SshTransport;
  forward: SshForward;
  tunnel: SshTunnel;
};

export function createSshTunnelManager(options: SshTunnelManagerOptions = {}): SshTunnelManager {
  const log = options.log ?? (() => undefined);
  const buildTransport =
    options.buildTransport ??
    ((ssh: RemoteHostSshMetadata, sshSecret?: string) =>
      createSystemSshTransport(sshTargetOf(ssh, sshSecret), {
        log: (level, message, data) => log(level, message, data),
      }));
  const reservePort = options.reservePort ?? reserveLocalPort;
  const entries = new Map<string, TunnelEntry>();

  const closeEntry = async (entry: TunnelEntry): Promise<void> => {
    try {
      await entry.forward.close();
    } catch (error) {
      log("warn", "ssh forward close threw", { error: String(error) });
    }
    entry.transport.dispose();
  };

  const remember = (
    hostKey: string,
    ssh: RemoteHostSshMetadata,
    transport: SshTransport,
    forward: SshForward,
  ): SshTunnel => {
    const tunnel: SshTunnel = { url: racpUrlForLocalPort(forward.localPort), localPort: forward.localPort };
    entries.set(hostKey, { ssh, transport, forward, tunnel });
    return tunnel;
  };

  /** Drop one entry and reap its process; shared by `close` and `adopt`. */
  const closeForKey = async (hostKey: string): Promise<void> => {
    const entry = entries.get(hostKey);
    if (!entry) return;
    entries.delete(hostKey);
    await closeEntry(entry);
  };

  return {
    async open(hostKey, ssh, sshSecret) {
      const existing = entries.get(hostKey);
      if (existing) return existing.tunnel;

      const transport = buildTransport(ssh, sshSecret);
      // A dead ssh client must not take the app with it; `forward` reports the
      // failure through its own rejection.
      let forward: SshForward;
      try {
        forward = await transport.forward({
          localPort: await reservePort(),
          remoteHost: "127.0.0.1",
          remotePort: ssh.remotePort,
        });
      } catch (error) {
        transport.dispose();
        throw error;
      }
      log("info", "ssh forward open", { hostKey, localPort: forward.localPort, remotePort: ssh.remotePort });
      return remember(hostKey, ssh, transport, forward);
    },

    async adopt(hostKey, ssh, forward) {
      const existing = entries.get(hostKey);
      if (existing) await closeForKey(hostKey);
      // The adopted forward already owns a live ssh process; the entry keeps a
      // transport only so `close` can reap anything else it started.
      const transport: SshTransport = {
        exec: () => Promise.reject(new Error("adopted tunnel transports are write-only")),
        execWithInput: () => Promise.reject(new Error("adopted tunnel transports are write-only")),
        forward: () => Promise.reject(new Error("adopted tunnel transports are write-only")),
        dispose: () => undefined,
      };
      return remember(hostKey, ssh, transport, forward);
    },

    async close(hostKey) {
      await closeForKey(hostKey);
    },

    async dispose() {
      const all = [...entries.values()];
      entries.clear();
      await Promise.allSettled(all.map((entry) => closeEntry(entry)));
    },
  };
}
