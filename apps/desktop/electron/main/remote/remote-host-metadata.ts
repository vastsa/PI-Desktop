import type { RemoteHostSshMetadata, RemoteHostTransport } from "@pi-desktop/shared";
import type { RemoteHostRecord } from "./remote-host-registry.js";
import { assertSshArgument } from "./ssh-transport.js";

function safeSshField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return assertSshArgument(value, "ssh field"); } catch { return null; }
}
function safeSshPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

/** Registry metadata is untrusted, and must never become unchecked SSH argv. */
export function sshMetadataOf(record: RemoteHostRecord): RemoteHostSshMetadata | null {
  if (record.metadata?.transport !== "ssh") return null;
  const ssh = record.metadata.ssh;
  if (typeof ssh !== "object" || ssh === null) return null;
  const candidate = ssh as Partial<RemoteHostSshMetadata>;
  const host = safeSshField(candidate.host);
  if (host === null) return null;
  const user = candidate.user === undefined ? null : safeSshField(candidate.user);
  if (user === null && candidate.user !== undefined) return null;
  const identityFile = candidate.identityFile === undefined ? null : safeSshField(candidate.identityFile);
  if (identityFile === null && candidate.identityFile !== undefined) return null;
  const port = candidate.port === undefined ? null : safeSshPort(candidate.port);
  if (port === null && candidate.port !== undefined) return null;
  const remotePort = safeSshPort(candidate.remotePort);
  if (remotePort === null) return null;
  return {
    host, remotePort,
    ...(port !== null ? { port } : {}),
    ...(user !== null ? { user } : {}),
    ...(identityFile !== null ? { identityFile } : {}),
    ...(candidate.auth === "password" ? { auth: "password" as const } : {}),
    version: typeof candidate.version === "string" ? candidate.version : "",
  };
}

export function sshHostRecord(input: {
  hostKey: string; label: string; url: string; deviceToken: string;
  ssh: RemoteHostSshMetadata; sshSecret?: string;
}): RemoteHostRecord {
  return {
    hostKey: input.hostKey, label: input.label, url: input.url, deviceToken: input.deviceToken,
    ...(input.sshSecret ? { sshSecret: input.sshSecret } : {}),
    metadata: { transport: "ssh", ssh: input.ssh },
  };
}

export function transportOf(record: RemoteHostRecord): RemoteHostTransport {
  return sshMetadataOf(record) ? "ssh" : "direct";
}
