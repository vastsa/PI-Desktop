/** Remote-first install with one verified SSH-upload fallback, never tool replay. */
import { buildBootstrapScript, parseBootstrapOutput, type PiHostBootstrapScriptInput } from "./pi-host-bootstrap-script.js";
import { uploadSshArtifact } from "./ssh-artifact-transfer.js";
import type { SshExecResult, SshTransport } from "./ssh-transport.js";

export async function installPiHost(
  transport: SshTransport,
  input: PiHostBootstrapScriptInput,
  options: {
    timeoutMs: number; signal?: AbortSignal;
    uploadArtifact?: typeof uploadSshArtifact;
    onUpload?: () => void;
    log?: (level: "warn", message: string) => void;
  },
): Promise<SshExecResult> {
  const run = async (artifactPath?: string) => {
    options.signal?.throwIfAborted();
    const result = await transport.execWithInput("sh -s", buildBootstrapScript({ ...input, artifactPath }),
      { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024 });
    options.signal?.throwIfAborted();
    return result;
  };
  let initial: SshExecResult;
  try {
    initial = await run();
    if (parseBootstrapOutput(initial.stdout).failure !== "download-failed") return initial;
  } catch (error) {
    options.signal?.throwIfAborted();
    const step = parseBootstrapOutput(String((error as { stdout?: unknown })?.stdout ?? "")).failure;
    if (step !== "download-failed" || (!transport.execWithFile && !options.uploadArtifact)) throw error;
    initial = { stdout: String((error as { stdout?: unknown }).stdout ?? ""), stderr: "", code: 1 };
  }
  if (!transport.execWithFile && !options.uploadArtifact) return initial;
  options.signal?.throwIfAborted();
  options.onUpload?.();
  const artifact = await (options.uploadArtifact ?? uploadSshArtifact)(transport,
    { url: input.artifactUrl, expectedSha256: input.expectedSha256, signal: options.signal });
  try { return await run(artifact.path); }
  finally {
    try { await artifact.cleanup(); }
    catch { options.log?.("warn", "SSH artifact temporary directory cleanup failed"); }
  }
}
