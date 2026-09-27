import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AI_PLATFORM_BASE_URL, PLATFORM_MEDIA_TIMEOUT_MS } from "@pi-desktop/shared";

/** Host-only dependency seam, never accepted in the tool arguments. */
export type PythonLauncher = { command: string; args?: string[] };
export type MediaCliRequest = { script: "image" | "video"; args: string[]; prompt?: string };
export type MediaProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  interrupted?: "CANCELLED" | "TIMEOUT" | "OUTPUT_LIMIT";
};

export function platformMediaEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Deliberately omit other providers' secrets, Python startup overrides and
  // proxy credentials. Native OS trust remains enabled; TLS is never disabled.
  const allowed = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, AI_AGG_API_KEY: apiKey, AI_AGG_BASE_URL: AI_PLATFORM_BASE_URL, AI_AGG_DESKTOP: "1", AI_AGG_TIMEOUT: "600" };
}

function execute(options: {
  launcher: PythonLauncher;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<MediaProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", interrupted: "CANCELLED" });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.launcher.command, [...(options.launcher.args ?? []), ...options.args], {
        cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let interrupted: MediaProcessResult["interrupted"];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // taskkill also terminates an optional ffprobe child. No shell parsing.
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true, shell: false, stdio: "ignore", env: platformMediaEnvironment(""),
        });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
      }
    };
    const stop = (reason: NonNullable<MediaProcessResult["interrupted"]>) => {
      if (interrupted) return;
      interrupted = reason;
      kill(false);
      escalation = setTimeout(() => kill(true), 1500);
    };
    const abort = () => stop("CANCELLED");
    const timer = setTimeout(() => stop("TIMEOUT"), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal.removeEventListener("abort", abort);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) stop("OUTPUT_LIMIT");
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // CLI batch progress is stderr, not JSON. Keep a bounded diagnostic tail.
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        stderr = `Media subprocess input failed (${error.code ?? "unknown"}).`;
        stop("OUTPUT_LIMIT");
      }
    });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (exitCode) => { cleanup(); resolve({ exitCode, stdout, stderr, interrupted }); });
    child.stdin.end(options.stdin ?? "");
  });
}

export async function runPlatformMediaCli(options: {
  script: string;
  request: MediaCliRequest;
  cwd: string;
  apiKey: string;
  signal: AbortSignal;
  timeoutMs?: number;
  python?: PythonLauncher;
}): Promise<MediaProcessResult> {
  const launchers = options.python ? [options.python] : process.platform === "win32"
    ? [{ command: "py", args: ["-3"] }, { command: "python" }, { command: "python3" }]
    : [{ command: "python3" }, { command: "python" }];
  const env = platformMediaEnvironment(options.apiKey);
  for (const launcher of launchers) {
    let probe: MediaProcessResult;
    try {
      probe = await execute({
        launcher, cwd: options.cwd, env: platformMediaEnvironment(""), signal: options.signal,
        args: ["-B", "-s", "-E", "-c", "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)"],
        timeoutMs: 5000,
      });
    } catch (error) {
      if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    if (probe.interrupted === "CANCELLED") return probe;
    if (probe.exitCode !== 0) continue;
    // Never try another interpreter after execution begins: the POST could
    // already be accepted even when a subprocess reports an error.
    return execute({
      launcher, cwd: options.cwd, env, signal: options.signal,
      args: ["-B", "-s", "-E", options.script], stdin: JSON.stringify(options.request),
      timeoutMs: options.timeoutMs ?? PLATFORM_MEDIA_TIMEOUT_MS,
    });
  }
  throw Object.assign(new Error("Python 3.9 or newer is required. Install Python 3 from https://www.python.org/downloads/ (on Windows enable Add Python to PATH), then restart PI-Desktop. No pip packages are needed."), { errorCode: "PYTHON_REQUIRED" });
}
