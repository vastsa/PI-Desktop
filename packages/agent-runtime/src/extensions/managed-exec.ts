import { spawn } from "node:child_process";
import type { ExtensionExecOptions, ExtensionExecResult } from "./runner.js";

/** Own the process group created through pi.exec; direct Node spawns are unowned. */
export function managedExec(command: string, args: string[], cwd: string,
  owner: AbortSignal, options?: ExtensionExecOptions): Promise<ExtensionExecResult> {
  const signal = options?.signal ? AbortSignal.any([owner, options.signal]) : owner;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
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
      if (error) reject(error);
      else resolve({ stdout, stderr, code: code ?? (killed ? 143 : 0), killed });
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, Math.max(0, maxBuffer - stdout.length));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, Math.max(0, maxBuffer - stderr.length));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
  });
}
