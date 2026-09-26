/**
 * Release coordinates for the `pi-host` bundle the desktop installs on a
 * remote machine (spec `02-architecture/05-remote-agent-control.md` §5.2 step 2,
 * D375).
 *
 * The desktop never uploads executable bytes: it resolves the artifact for the
 * remote platform at *its own* version, keeps the SHA-256 the release publishes
 * as the trust anchor, and hands both to the bootstrap script that runs on the
 * remote machine. Everything here is pure so the URL, target, and checksum
 * rules stay testable without a network or an SSH connection.
 */
import { GITHUB_REPO } from "@pi-desktop/shared";

/** Platforms the bootstrap can classify from `uname -s`. */
export type PiHostPlatform = "linux" | "darwin";
/** Architectures the bootstrap can classify from `uname -m`. */
export type PiHostArch = "x64" | "arm64";

export type PiHostTarget = {
  platform: PiHostPlatform;
  arch: PiHostArch;
};

/**
 * Release-matrix parity. `release.yml`'s `pi-host-bundle` job publishes Linux
 * x64 only today; the desktop matrix ships no other Linux platform. A target
 * outside this list is refused with a typed failure instead of a 404 halfway
 * through a download.
 */
const PUBLISHED_TARGETS: readonly string[] = ["linux-x64"];

export function targetKey(target: PiHostTarget): string {
  return `${target.platform}-${target.arch}`;
}

export function isPublishedTarget(target: PiHostTarget): boolean {
  return PUBLISHED_TARGETS.includes(targetKey(target));
}

/** `uname -s` → a platform the release matrix can serve, or `null`. */
export function platformFromUname(systemName: string): PiHostPlatform | null {
  const value = systemName.trim().toLowerCase();
  if (value === "linux") return "linux";
  if (value === "darwin") return "darwin";
  return null;
}

/** `uname -m` → an architecture the release matrix can serve, or `null`. */
export function archFromUname(machine: string): PiHostArch | null {
  const value = machine.trim().toLowerCase();
  if (value === "x86_64" || value === "amd64") return "x64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  return null;
}

/**
 * `uname -s` and `uname -m` are the only remote facts needed before a
 * download; they are collected in one exec so a host that answers at all
 * answers both.
 */
export function parseUnameOutput(stdout: string): { systemName: string; machine: string } {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { systemName: lines[0] ?? "", machine: lines[1] ?? "" };
}

export function resolveTarget(stdout: string): PiHostTarget | null {
  const { systemName, machine } = parseUnameOutput(stdout);
  const platform = platformFromUname(systemName);
  const arch = archFromUname(machine);
  if (!platform || !arch) return null;
  return { platform, arch };
}

/** Directory name the tarball unpacks to, `bundle.mjs`'s `pi-host-<version>-<platform>-<arch>`. */
export function piHostBundleDir(version: string, target: PiHostTarget): string {
  return `pi-host-${version}-${targetKey(target)}`;
}

export function piHostArtifactName(version: string, target: PiHostTarget): string {
  return `${piHostBundleDir(version, target)}.tar.gz`;
}

/**
 * Release asset URLs. `release.yml` uploads both files to the `v<version>` tag,
 * so the desktop and the bootstrap script derive them without an API call.
 */
export function piHostArtifactUrls(
  version: string,
  target: PiHostTarget,
): { tarball: string; checksum: string } {
  const name = piHostArtifactName(version, target);
  const base = `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;
  return { tarball: `${base}/${name}`, checksum: `${base}/${name}.sha256` };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lower-case a digest, or `null` when it is not 64 hex characters. */
export function normalizeChecksum(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return SHA256_HEX.test(trimmed) ? trimmed : null;
}

/**
 * Read the digest out of a `sha256sum` file. `release.yml` writes
 * `<digest>  <name>`; the file name is checked so a checksum for a different
 * artifact can never be mistaken for this one.
 */
export function parseChecksumFile(text: string, artifactName: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [rawChecksum, ...rest] = trimmed.split(/\s+/);
    const normalized = normalizeChecksum(rawChecksum ?? "");
    if (!normalized) continue;
    // `sha256sum` writes the bare name; some tools prefix `*` or a path.
    const named = rest.join(" ").replace(/^\*/, "").split("/").pop() ?? "";
    if (named && named !== artifactName) continue;
    return normalized;
  }
  return null;
}

/** Constant-work comparison of two normalized digests. */
export function checksumMatches(actual: string, expected: string): boolean {
  const left = normalizeChecksum(actual);
  const right = normalizeChecksum(expected);
  if (!left || !right) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * A bootstrapped host must run the same release as the desktop: the bundle is
 * downloaded at the desktop's version and the RACP capability set is pinned to
 * it (D375). A leading `v` is tolerated on either side because the tag carries
 * one and `APP_VERSION` does not.
 */
export function versionsMatch(remote: string, local: string): boolean {
  const strip = (value: string) => value.trim().replace(/^v/, "");
  const a = strip(remote);
  const b = strip(local);
  return a.length > 0 && a === b;
}
