/** Verified release transfer through the existing authenticated OpenSSH transport. */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ErrorCodes } from "@pi-desktop/shared";
import { shellQuote } from "./pi-host-bootstrap-script.js";
import { checksumMatches, normalizeChecksum } from "./pi-host-release.js";
import type { SshTransport } from "./ssh-transport.js";

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export type UploadedSshArtifact = { path: string; cleanup(): Promise<void> };
export type SshArtifactTransferInput = {
  url: string; expectedSha256: string; signal?: AbortSignal;
  fetchArtifact?: typeof fetch;
};
function failure(): Error {
  return Object.assign(new Error("The pi-host artifact could not be transferred or verified"), {
    errorCode: ErrorCodes.HOST_BOOTSTRAP_FAILED,
  });
}
/** The path must identify only a directory minted by our remote mktemp command. */
function uploadDirectory(value: string): string {
  const path = value.trim();
  if (!/^\/[^\r\n\0]*\/\.pi-desktop\/pi-host\/\.upload\.[a-zA-Z0-9]{6,}$/.test(path)) throw failure();
  return path;
}
export async function uploadSshArtifact(
  transport: SshTransport, input: SshArtifactTransferInput,
): Promise<UploadedSshArtifact> {
  if (!transport.execWithFile || !normalizeChecksum(input.expectedSha256)) throw failure();
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password) throw failure();
  input.signal?.throwIfAborted();
  const localDir = await mkdtemp(join(tmpdir(), "pi-host-artifact-"));
  let remoteDir: string | undefined;
  const cleanup = async () => {
    if (!remoteDir) return;
    // Never trust remote output to choose a deletion target outside this prefix.
    const directory = shellQuote(remoteDir);
    await transport.exec(`path=${directory}; case "$path" in "$HOME"/.pi-desktop/pi-host/.upload.*) rm -rf -- "$path" ;; *) exit 1 ;; esac`, { timeoutMs: 30_000 });
    remoteDir = undefined;
  };
  try {
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)])
      : AbortSignal.timeout(600_000);
    const response = await (input.fetchArtifact ?? fetch)(input.url, { signal, redirect: "follow" });
    if (!response.ok || !response.body) throw failure();
    const hash = createHash("sha256");
    let bytes = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ARTIFACT_BYTES) { callback(failure()); return; }
        hash.update(chunk); callback(null, chunk);
      },
    });
    const reader = response.body.getReader();
    const chunks = (async function* () {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    })();
    const localPath = join(localDir, "artifact.tar.gz");
    await pipeline(Readable.from(chunks), verify,
      createWriteStream(localPath, { flags: "wx", mode: 0o600 }), { signal });
    if (!checksumMatches(hash.digest("hex"), input.expectedSha256)) throw failure();
    input.signal?.throwIfAborted();
    const created = await transport.exec('umask 077; mkdir -p "$HOME/.pi-desktop/pi-host" && mktemp -d "$HOME/.pi-desktop/pi-host/.upload.XXXXXX"');
    remoteDir = uploadDirectory(created.stdout);
    input.signal?.throwIfAborted();
    const path = `${remoteDir}/artifact.tar.gz`;
    await transport.execWithFile(`umask 077; cat > ${shellQuote(path)}`, localPath,
      { timeoutMs: 600_000, maxOutputBytes: 16_384 });
    input.signal?.throwIfAborted();
    return { path, cleanup };
  } catch (error) {
    try { await cleanup(); } catch { /* Preserve the original transfer error; remote temp remains private. */ }
    if (input.signal?.aborted) input.signal.throwIfAborted();
    // Fetch/stream/SSH diagnostics are not safe renderer or log payloads.
    throw failure();
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
}
