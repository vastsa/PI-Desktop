/**
 * The SSH seam of the remote-host bootstrap (spec `05-remote-agent-control.md`
 * §5.2 step 1: "The desktop opens SSH with the user's existing configuration
 * and keys").
 *
 * Shelling out to the system `ssh` rather than linking an SSH client is the
 * deliberate choice here:
 *
 * - The user's `~/.ssh/config`, agent, `known_hosts`, and jump hosts apply
 *   exactly as they do in their terminal, so a machine that is reachable from
 *   the shell is reachable from the app with no second credential store.
 * - With no password in hand the desktop holds no SSH secret at all, and
 *   `BatchMode=yes` keeps that honest: a host that needs an interactive
 *   password or passphrase fails immediately with a typed error instead of
 *   hanging behind an invisible prompt.
 *
 * A password can be supplied instead of relying on a key. That is the one case
 * where the app carries an SSH secret: it reaches the child through OpenSSH's
 * askpass helper rather than the command line (`ssh-askpass.ts`), and the
 * caller decides whether it is persisted encrypted for the next launch.
 *
 * The module is a port so the bootstrap orchestrator can be tested against a
 * fake; `createSystemSshTransport` is the only implementation that spawns.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, connect } from "node:net";
import { ErrorCodes } from "@pi-desktop/shared";
import { redactBootstrapOutput } from "./pi-host-bootstrap-script.js";
import { createSshAskpass, type SshAskpassMaterial } from "./ssh-askpass.js";

/** Where to reach a machine over SSH. */
export type SshTarget = {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  /**
   * Login password, when the user chose password auth over a key. Never placed
   * in the argv (`ssh-askpass.ts`). Leaving it undefined keeps the key/agent
   * path byte-for-byte as it was, `BatchMode=yes` included.
   */
  password?: string;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

/** A live local→remote port forward; `close` is idempotent. */
export type SshForward = {
  /** The loopback port on this machine that reaches `remotePort`. */
  localPort: number;
  close(): Promise<void>;
};

export interface SshTransport {
  /** Run `command` through the remote user's shell. */
  exec(command: string, options?: { timeoutMs?: number }): Promise<SshExecResult>;
  /** Run `command` with `input` written to its stdin (used to upload the script). */
  execWithInput(
    command: string,
    input: string,
    options?: { timeoutMs?: number },
  ): Promise<SshExecResult>;
  /** Forward a loopback port on this machine to a loopback port on the remote. */
  forward(options: {
    localPort: number;
    remoteHost: string;
    remotePort: number;
    timeoutMs?: number;
  }): Promise<SshForward>;
  /** Kill anything still running. Safe to call twice. */
  dispose(): void;
}

export type SystemSshTransportOptions = {
  /**
   * `ssh` executable to spawn. Defaults to `ssh` on PATH; tests point it at a
   * fixture script.
   */
  binary?: string;
  /** Extra `-o` options appended after the ones this module always sets. */
  extraOptions?: string[];
  log?: (level: "info" | "warn", message: string, data?: unknown) => void;
};

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  // `data` is duplicated so IPC wrap can forward it as `details` while existing
  // callers still read `error.stderr` / `error.code` as own properties.
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}), data });
}

/** Last non-empty line of ssh stderr; that is what the Settings toast shows. */
function lastSshDiagnostic(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

/**
 * Reject a value that would be read as an `ssh` option rather than as a
 * destination. `host` is passed as its own argv entry, so a leading `-` is the
 * only way it can influence the command line (`-oProxyCommand=…`).
 */
export function assertSshArgument(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw fail(`${field} must not be empty`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (trimmed.startsWith("-")) {
    throw fail(`${field} must not start with '-'`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  return trimmed;
}

/** The argv `ssh` receives, minus the final command. */
export function sshCommonArgs(target: SshTarget): string[] {
  const password = target.password !== undefined;
  const args = [
    // Fail instead of prompting when there is no secret to answer with: there
    // is no terminal behind this spawn. With one, the prompt is routed to the
    // askpass helper instead, which is the only reason BatchMode is relaxed.
    "-o",
    password ? "BatchMode=no" : "BatchMode=yes",
    // Trust-on-first-use, as `ssh` itself offers interactively.
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    // A forward that cannot be set up must not leave a half-open session.
    "-o",
    "ExitOnForwardFailure=yes",
  ];
  if (password) {
    // The helper answers every prompt with the same secret, so a retry could
    // only repeat a wrong password — and repeated failures are what trip a
    // server's own lockout. One prompt, one answer. Default identities are
    // skipped: an encrypted `~/.ssh/id_rsa` would consume that single prompt
    // as a key passphrase and never try the login password. Password mode in
    // Settings replaces a key; users with both pick key mode.
    args.push("-o", "NumberOfPasswordPrompts=1", "-o", "PubkeyAuthentication=no");
  }
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  const user = target.user?.trim();
  args.push(user ? `${user}@${target.host}` : target.host);
  return args;
}

/** A loopback port nothing is listening on, for `-L` to claim. */
export function reserveLocalPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolvePort(port);
        else rejectPort(fail("could not reserve a loopback port", ErrorCodes.REMOTE_FORWARD_FAILED));
      });
    });
  });
}

/**
 * Resolve once something accepts a TCP connection on `port`.
 *
 * The poll is abortable because it outlives the decision it informs: when the
 * ssh child dies first the caller has already failed the forward, and a
 * referenced retry timer would otherwise keep polling — and keep the event
 * loop alive — until the full timeout elapsed.
 */
function waitForLoopbackConnect(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveConnected, rejectConnected) => {
    let pending: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (pending) clearTimeout(pending);
      pending = null;
      if (error) rejectConnected(error);
      else resolveConnected();
    };
    signal?.addEventListener(
      "abort",
      () =>
        finish(
          fail(
            `port forward on 127.0.0.1:${port} was cancelled`,
            ErrorCodes.REMOTE_FORWARD_FAILED,
          ),
        ),
      { once: true },
    );
    const attempt = (): void => {
      if (settled) return;
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        finish();
      });
      socket.once("error", () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() >= deadline) {
          finish(
            fail(
              `port forward on 127.0.0.1:${port} never became reachable`,
              ErrorCodes.REMOTE_FORWARD_FAILED,
            ),
          );
          return;
        }
        pending = setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function runCommand(
  binary: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs: number;
    /** Full environment for the child; defaults to the app's own. */
    env?: NodeJS.ProcessEnv;
    /** Called with the spawned child so a transport can track and reap it. */
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  },
): Promise<SshExecResult> {
  return new Promise((resolveRun, rejectRun) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env });
    } catch (error) {
      rejectRun(
        fail(
          `${binary} could not be started: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCodes.HOST_BOOTSTRAP_FAILED,
        ),
      );
      return;
    }

    // A caller that owns a lifetime (dispose) tracks the child from here.
    options.onSpawn?.(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectRun(
        fail(`${binary} timed out after ${options.timeoutMs} ms`, ErrorCodes.HOST_BOOTSTRAP_FAILED, {
          stderr: stderr.slice(-2000),
        }),
      );
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here means the ssh client is not installed, which is a user
      // fix ("install OpenSSH"), not a remote-machine fault.
      rejectRun(
        fail(`${binary} could not be started: ${error.message}`, ErrorCodes.HOST_BOOTSTRAP_FAILED),
      );
    });
    child.once("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code: code ?? -1 });
    });

    // A child that exits early closes the pipe under us; swallowing the write
    // error keeps it from surfacing as an unhandled stream error.
    child.stdin.on("error", () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function createSystemSshTransport(
  target: SshTarget,
  options: SystemSshTransportOptions = {},
): SshTransport {
  const log = options.log ?? (() => undefined);
  const binary = options.binary ?? "ssh";
  const base = [...sshCommonArgs(target), ...(options.extraOptions ?? [])];
  const children = new Set<ChildProcessWithoutNullStreams>();

  // Askpass material is written on the first spawn and dropped once no child
  // can still be authenticating. The reference count is what makes a transport
  // that runs several commands (`exec`, `execWithInput`, then `forward`) work
  // without either deleting the secret under a live prompt or keeping it on
  // disk for the whole session.
  let material: Promise<SshAskpassMaterial> | null = null;
  let holders = 0;
  const acquireEnv = async (): Promise<NodeJS.ProcessEnv | undefined> => {
    if (target.password === undefined) return undefined;
    holders += 1;
    try {
      material ??= createSshAskpass(target.password);
      return { ...process.env, ...(await material).env };
    } catch (error) {
      holders -= 1;
      throw error;
    }
  };
  const releaseEnv = async (): Promise<void> => {
    if (target.password === undefined) return;
    holders -= 1;
    if (holders > 0 || !material) return;
    const current = material;
    material = null;
    await current.then((loaded) => loaded.dispose()).catch(() => undefined);
  };

  const spawnTracked = (
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): ChildProcessWithoutNullStreams => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env });
    children.add(child);
    child.once("close", () => children.delete(child));
    child.once("error", () => children.delete(child));
    return child;
  };

  const execOnce = async (
    command: string,
    input: string | undefined,
    timeoutMs: number,
  ): Promise<SshExecResult> => {
    // `sh -s` reads the script from stdin, so the script never has to survive
    // an argv round trip and never lands in a remote file we must clean up.
    const args = input === undefined ? [...base, command] : [...base, "sh -s"];
    const env = await acquireEnv();
    let result: SshExecResult;
    try {
      result = await runCommand(binary, args, {
        input,
        timeoutMs,
        env,
        onSpawn: (child) => {
          children.add(child);
          child.once("close", () => children.delete(child));
          child.once("error", () => children.delete(child));
        },
      });
    } finally {
      // The child has authenticated by now, or it never will.
      await releaseEnv();
    }
    if (result.code !== 0) {
      const stderr = redactBootstrapOutput(result.stderr).slice(-2000);
      const diagnostic = lastSshDiagnostic(stderr);
      throw fail(
        diagnostic
          ? `ssh command failed with exit code ${result.code}: ${diagnostic}`
          : `ssh command failed with exit code ${result.code}`,
        ErrorCodes.HOST_BOOTSTRAP_FAILED,
        {
          command,
          code: result.code,
          stderr,
          // The bootstrap script reports *where* it failed on stdout, so the
          // caller can turn a bare exit code into a named step.
          stdout: redactBootstrapOutput(result.stdout).slice(-4000),
        },
      );
    }
    return result;
  };

  return {
    exec: (command, execOptions) =>
      execOnce(command, undefined, execOptions?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
    execWithInput: (command, input, execOptions) =>
      execOnce(command, input, execOptions?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
    async forward({ localPort, remoteHost, remotePort, timeoutMs }) {
      const env = await acquireEnv();
      const args = [
        ...base,
        "-N",
        "-L",
        `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
      ];
      const child = spawnTracked(args, env);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // A forward that cannot bind must fail fast, and the ssh diagnostic on
      // stderr is the only thing that explains why. The gate is resolved from
      // the child's own exit and is registered before the race is awaited, so
      // a dead ssh rejects immediately instead of waiting out the probe.
      let exited = false;
      const earlyGate: { reject?: (error: Error) => void } = {};
      const early = new Promise<never>((_resolve, rejectEarly) => {
        earlyGate.reject = rejectEarly;
      });
      child.once("close", (code: number | null) => {
        exited = true;
        earlyGate.reject?.(
          fail(
            `ssh exited before the forward was ready (code ${code ?? -1}): ${
              stderr.trim().slice(-500) || "no diagnostic"
            }`,
            ErrorCodes.REMOTE_FORWARD_FAILED,
          ),
        );
      });
      child.once("error", (error: Error) => {
        exited = true;
        earlyGate.reject?.(
          fail(`${binary} could not be started: ${error.message}`, ErrorCodes.REMOTE_FORWARD_FAILED),
        );
      });

      // `ExitOnForwardFailure=yes` makes a doomed forward die, but a healthy
      // one prints nothing; the local port accepting connections is the only
      // readiness signal. It is not proof on its own — the reserved port was
      // released before ssh bound it, so an unrelated local listener could
      // answer the probe. A still-running ssh is what rules that out.
      const probeAbort = new AbortController();
      const probe = waitForLoopbackConnect(
        localPort,
        timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
        probeAbort.signal,
      ).then(() => {
        if (exited) {
          throw fail(
            `ssh exited before the forward on 127.0.0.1:${localPort} was ready`,
            ErrorCodes.REMOTE_FORWARD_FAILED,
          );
        }
      });

      try {
        await Promise.race([probe, early]);
      } catch (error) {
        // The probe has already lost; stop its poll instead of letting it run
        // to its own deadline with a referenced timer.
        probeAbort.abort();
        child.kill("SIGKILL");
        await releaseEnv();
        throw error instanceof Error && "errorCode" in error
          ? error
          : fail(
              `port forward failed: ${stderr.trim().slice(-500) || String(error)}`,
              ErrorCodes.REMOTE_FORWARD_FAILED,
            );
      }
      // The forward is up, so authentication is over: the askpass helper has
      // answered its last prompt and the secret file has no further use. The
      // `ssh` process stays for the life of the tunnel, but without it.
      await releaseEnv();
      let disposed = false;
      return {
        localPort,
        async close() {
          if (disposed) return;
          disposed = true;
          if (exited) return;
          child.kill("SIGTERM");
          await new Promise<void>((resolveClosed) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolveClosed();
            }, 5_000);
            timer.unref();
            child.once("close", () => {
              clearTimeout(timer);
              resolveClosed();
            });
          });
        },
      };
    },
    dispose() {
      for (const child of children) child.kill("SIGKILL");
      children.clear();
      // Killing the children means nothing can still be authenticating, so the
      // credential files go too rather than waiting out the session.
      holders = 0;
      const current = material;
      material = null;
      void current?.then((loaded) => loaded.dispose()).catch(() => undefined);
      log("info", "ssh transport disposed", { host: target.host });
    },
  };
}
