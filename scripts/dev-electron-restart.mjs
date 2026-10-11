import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

const RESTART_FILE_ENV = "PI_DESKTOP_DEV_RESTART_FILE";
const INSPECTOR_ENV_KEYS = [
  "REMOTE_DEBUGGING_PORT",
  "V8_INSPECTOR_PORT",
  "V8_INSPECTOR_BRK_PORT",
];
const SUPERVISOR_SIGNALS = ["SIGINT", "SIGTERM"];

export async function runDevelopmentProcess(executable, args, options = {}) {
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const restartDir = mkdtempSync(join(tmpdir(), "pi-desktop-dev-restart-"));
  const restartFile = join(restartDir, "request.json");

  let shuttingDown = false;
  let forwardedSignal;
  let currentChild;
  let childArgs = args;

  const onSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    forwardedSignal = signal;
    stopOwnedProcessTree(currentChild, signal);
    // This group has been signaled; do not kill a now-reaped group id again.
    currentChild = null;
  };

  const signalHandlers = new Map(
    SUPERVISOR_SIGNALS.map((signal) => [signal, () => onSignal(signal)]),
  );
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }

  let childEnv = {
    ...env,
    [RESTART_FILE_ENV]: restartFile,
  };

  try {
    while (!shuttingDown) {
      currentChild = spawn(executable, childArgs, {
        cwd,
        env: childEnv,
        stdio: "inherit",
        // Own a process group so a signal can stop electron-vite and Electron.
        detached: process.platform !== "win32",
      });
      let result;
      try {
        result = await waitForChild(currentChild);
      } finally {
        // Retire the group once, even if cleanup fails; keep the failure visible.
        try {
          stopOwnedProcessTree(currentChild, forwardedSignal ?? "SIGTERM");
        } finally {
          currentChild = null;
        }
      }

      if (shuttingDown) break;

      // A pending restart file must not override a failed or signaled exit.
      if (result.signal || result.code !== 0) {
        return exitStatus(result);
      }

      const request = consumeRestartRequest(restartFile);
      if (!request) return exitStatus(result);
      childEnv = envForRestart(childEnv, request);
      // electron-vite's CLI overwrites ELECTRON_CLI_ARGS from its -- tail.
      childArgs = options.restartArgs
        ? [...options.restartArgs, "--", ...request.slice(1)]
        : args;
    }

    return signalExitCode(forwardedSignal);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    try {
      stopOwnedProcessTree(currentChild, forwardedSignal ?? "SIGTERM");
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });
}

function stopOwnedProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    // taskkill returns 128 when the process already exited.
    if (result.status !== 0 && result.status !== 128) {
      throw new Error(`Unable to stop development process tree: ${result.stderr.trim()}`);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    // Darwin can report EPERM for a reaped/empty process group. Only accept
    // that after checking there are no live members; real denials still throw.
    if (
      process.platform === "darwin" &&
      error?.code === "EPERM" &&
      !hasLiveProcessGroup(child.pid)
    ) return;
    throw error;
  }
}

function hasLiveProcessGroup(groupId) {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect development process group: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return group === String(groupId) && state && !state.startsWith("Z");
  });
}

function consumeRestartRequest(restartFile) {
  let raw;
  try {
    raw = readFileSync(restartFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    unlinkSync(restartFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const parsed = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "Development restart request must be a JSON array of strings with at least one entry",
    );
  }
  return parsed;
}

function envForRestart(env, request) {
  const next = {
    ...env,
    ELECTRON_ENTRY: request[0],
    ELECTRON_CLI_ARGS: JSON.stringify(request.slice(1)),
  };
  // Native relaunch would keep a dead renderer origin and duplicate inspect
  // flags that electron-vite appends from these env vars.
  delete next.ELECTRON_RENDERER_URL;
  for (const key of INSPECTOR_ENV_KEYS) delete next[key];
  return next;
}

function exitStatus(result) {
  if (result.signal) return signalExitCode(result.signal);
  return result.code ?? 1;
}

function signalExitCode(signal) {
  if (!signal) return 1;
  const number = osConstants.signals[signal];
  if (typeof number !== "number") return 1;
  return 128 + number;
}
