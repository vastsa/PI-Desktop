import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionExecOptions, ExtensionExecResult } from "./runner.js";

/** Default combined stdout + stderr byte cap for pi.exec. */
export const DEFAULT_EXTENSION_EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Own the process group created through pi.exec; direct Node spawns are unowned.
 *
 * Mirrors Pi 1.5 exec semantics: output is decoded across chunk boundaries,
 * `maxBuffer` caps stdout and stderr combined in bytes and terminates the
 * command on overflow with `truncated: true` and a nonzero code, and a command
 * that cannot be spawned resolves with code 1 and the spawn error in stderr.
 */
export function managedExec(command: string, args: string[], cwd: string,
  owner: AbortSignal, options?: ExtensionExecOptions): Promise<ExtensionExecResult> {
  const signal = options?.signal ? AbortSignal.any([owner, options.signal]) : owner;
  signal.throwIfAborted();
  const maxBuffer = options?.maxBuffer ?? DEFAULT_EXTENSION_EXEC_MAX_BUFFER;
  if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
    throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputBytes = 0;
    let truncated = false;
    let spawnError: Error | undefined;
    let killed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", kill);
      if (error) {
        reject(error);
        return;
      }
      // An incomplete UTF-8 suffix of truncated output was never accepted; do not flush it.
      if (!truncated) {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      if (spawnError && !stderr) stderr = spawnError.message;
      const exitCode = code ?? (killed ? 143 : spawnError ? 1 : 0);
      // A truncated result must never read as success.
      resolve({ stdout, stderr, code: truncated && exitCode === 0 ? 1 : exitCode, killed, truncated });
    };
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      killTimer = setTimeout(() => finish(new Error("Extension process cleanup timed out")), 5_000);
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true,
        });
        killer.once("error", (error) => { child.kill(); finish(error); });
        killer.once("exit", (code) => {
          if (code !== 0 && child.exitCode === null) {
            child.kill();
            finish(new Error(`Extension process-tree cleanup failed (${code})`));
          }
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) finish(error);
        }
      }
    };
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    if (options?.timeout) timeout = setTimeout(kill, options.timeout);
    const takeWithinCap = (data: Buffer): Buffer | undefined => {
      if (truncated) return undefined;
      const remaining = maxBuffer - outputBytes;
      if (data.length <= remaining) {
        outputBytes += data.length;
        return data;
      }
      truncated = true;
      child.stdout.destroy();
      child.stderr.destroy();
      kill();
      return remaining > 0 ? data.subarray(0, remaining) : undefined;
    };
    child.stdout.on("data", (data: Buffer) => {
      const chunk = takeWithinCap(data);
      if (chunk) stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (data: Buffer) => {
      const chunk = takeWithinCap(data);
      if (chunk) stderr += stderrDecoder.write(chunk);
    });
    child.once("error", (error) => {
      // A spawn failure (missing executable, bad cwd) is a failed command, not a host fault.
      if (!child.pid) {
        spawnError = error;
        finish(undefined, 1);
      } else finish(error);
    });
    child.once("close", (code) => finish(undefined, code));
  });
}
