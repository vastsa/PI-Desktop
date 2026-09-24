/**
 * Renderer-facing shape of one paired remote `pi-host`. The device token that
 * authenticates the connection stays inside Electron main — the renderer only
 * sees the routing key, label, URL, and last-known live-connection state so
 * the Settings row can render a status pill without a second round trip.
 *
 * Companion of `RemoteHostRecord` inside main (which additionally carries
 * `deviceToken`). See ADR 0286 §Registry and R2b pairing UX.
 */

import type { SessionSummary } from "./sessions.js";

/**
 * How the desktop reaches a paired host.
 *
 * - `direct`: a URL the user supplied, including a forward they opened
 *   themselves with `ssh -L` (`RemoteHostPairRequest`).
 * - `ssh`: a host the desktop bootstrapped itself and keeps a port forward
 *   open for (spec §5.2). The stored URL is derived from that forward, so the
 *   SSH descriptor is the durable half of the record.
 */
export type RemoteHostTransport = "direct" | "ssh";

/**
 * How the desktop authenticates the SSH session itself.
 *
 * - `key`: the user's agent, `~/.ssh/config`, and identity files — the only
 *   mode that existed before password auth, and still the default.
 * - `password`: the desktop supplies a login password through OpenSSH's
 *   askpass helper. The secret is never an `ssh` argument and never appears in
 *   a renderer payload; it is stored encrypted (see `RemoteHostSshMetadata`).
 */
export type RemoteHostSshAuth = "key" | "password";

/**
 * The SSH descriptor a bootstrapped host reconnects through. Persisted in the
 * host record so the forward can be re-established on the next launch without
 * another bootstrap.
 *
 * The password for an `auth: "password"` descriptor is deliberately *not* part
 * of this shape: this type is persisted in plaintext metadata and is echoed
 * back to the renderer inside `RemoteHostBootstrapResult`. The secret lives in
 * a separate encrypted record field instead.
 */
export type RemoteHostSshMetadata = {
  /** Host name or address as `ssh` receives it (no `user@` prefix). */
  host: string;
  /** `ssh -p` value; absent means the SSH default. */
  port?: number;
  /** `ssh` login user; absent means the local user name. */
  user?: string;
  /** `ssh -i` value; absent means the agent and `~/.ssh/config` decide. */
  identityFile?: string;
  /** Absent means `key`, so descriptors written before password auth read back unchanged. */
  auth?: RemoteHostSshAuth;
  /** `pi-host`'s loopback port on the remote machine. */
  remotePort: number;
  /** Release version the bootstrap installed, checked against `APP_VERSION`. */
  version: string;
};

export type RemoteHostSummary = {
  hostKey: string;
  label: string;
  url: string;
  connected: boolean;
  /** Absent on records written before the SSH bootstrap existed → `direct`. */
  transport?: RemoteHostTransport;
};

/**
 * Input for `remoteHostPair`. The pairing token is single-use and expiring
 * (spec §3.4); the desktop uses it once on the upgrade to call
 * `connection/pair`, exchanges it for a durable device token, and stores that
 * token encrypted with the OS keychain via `safeStorage`.
 */
export type RemoteHostPairRequest = {
  /** `ws://` or `wss://` URL of the paired host's RACP endpoint. */
  url: string;
  /** `ppt1.` pairing token the host issued in its bootstrap output. */
  pairingToken: string;
  /** Human label; the host records it against the minted device. */
  label: string;
  /**
   * Optional stable routing key. Absent means the desktop mints one from the
   * URL host + label; a caller may supply its own to keep the id predictable.
   */
  hostKey?: string;
};

export type RemoteHostPairResult = {
  host: RemoteHostSummary;
};

export type RemoteHostRemoveRequest = {
  hostKey: string;
};

/**
 * Input for `remoteHostBootstrap`: install and pair a `pi-host` on a machine
 * the user can already reach over SSH (spec §5.2). The desktop uses the user's
 * own SSH configuration and keys, so no credential ever crosses this IPC
 * channel.
 */
export type RemoteHostBootstrapRequest = {
  /** Human label for the host list, and the device label the host records. */
  label: string;
  /** SSH host name or address, without a `user@` prefix. */
  host: string;
  /** `ssh -p` value; absent means the SSH default. */
  port?: number;
  /** SSH login user; absent means the local user name. */
  user?: string;
  /** `ssh -i` value; absent means the agent and `~/.ssh/config` decide. */
  identityFile?: string;
  /**
   * Loopback port `pi-host` should bind on the remote machine. `0` or absent
   * lets the host pick a free port and report it back.
   */
  remotePort?: number;
  /** Optional stable routing key; absent means the desktop mints one. */
  hostKey?: string;
  /**
   * SSH login password, when the user chose password auth instead of a key.
   * Absent keeps the key/agent path byte-for-byte unchanged. It is passed to
   * the `ssh` client through an askpass helper, never as an argument, and is
   * persisted encrypted with the OS keychain so the next launch can reconnect.
   * A newline cannot be expressed — OpenSSH reads the helper's answer up to the
   * first line break — so such a value is rejected with `INVALID_ARGUMENT`.
   */
  password?: string;
};

export type RemoteHostBootstrapResult = {
  host: RemoteHostSummary;
  /** The descriptor the desktop reconnects through on later launches. */
  ssh: RemoteHostSshMetadata;
  /** Ordered bootstrap steps that completed, for a Settings progress line. */
  steps: string[];
};

/**
 * A project the paired host has registered. Only the label crosses RACP — the
 * host never echoes its absolute path back through `project/list`.
 */
export type RemoteProjectSummary = {
  id: string;
  label: string;
  archived: boolean;
};

export type RemoteProjectListRequest = {
  hostKey: string;
};

export type RemoteProjectListResult = {
  projects: RemoteProjectSummary[];
};

/**
 * Input for `remoteProjectBrowse`. The host bounds the listing to its own
 * browse root and answers only with directories; absent `path` means that root.
 */
export type RemoteProjectBrowseRequest = {
  hostKey: string;
  path?: string;
};

export type RemoteProjectBrowseEntry = {
  name: string;
  /** Absolute path on the host; pass it back as `path` to descend. */
  path: string;
};

export type RemoteProjectBrowseResult = {
  path: string;
  /** Absent at the browse root. */
  parent?: string;
  entries: RemoteProjectBrowseEntry[];
};

export type RemoteProjectRegisterRequest = {
  hostKey: string;
  /** Absolute directory on the host, usually picked through `remoteProjectBrowse`. */
  path: string;
};

export type RemoteProjectRegisterResult = {
  project: RemoteProjectSummary;
};

/**
 * Input for `remoteSessionCreate`. The session runs on the host's default
 * model; the desktop does not pick a provider for a remote session.
 */
export type RemoteSessionCreateRequest = {
  hostKey: string;
  projectId: string;
  title?: string;
};

export type RemoteSessionCreateResult = {
  session: SessionSummary;
};
