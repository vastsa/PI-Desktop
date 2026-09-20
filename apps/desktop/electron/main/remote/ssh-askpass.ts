/**
 * OpenSSH's askpass seam: how a login password reaches the `ssh` client
 * without ever becoming a command-line argument.
 *
 * The transport deliberately spawns the system `ssh` (see `ssh-transport.ts`),
 * which reads a password from the terminal — and there is no terminal behind
 * that spawn. OpenSSH's own answer is `SSH_ASKPASS`: when it needs a secret it
 * runs the program named by that variable and reads the first line of its
 * stdout. This module builds that program.
 *
 * Two properties matter, and both are structural rather than conventional:
 *
 * - The secret is not an argument and not an environment variable. It lives in
 *   a `0600` file inside a `0700` directory, and the helper reads it by path, so
 *   a process listing (`ps`) never shows it and neither does a crash dump of
 *   the argv.
 * - The material is created lazily, only when an `ssh` child is about to
 *   authenticate, and deleted again as soon as that child is done with it —
 *   for a forward, that is the moment the port is up. Nothing keeps the file
 *   alive past its use.
 *
 * `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+) is what makes this work without a
 * terminal; `DISPLAY` is set as well because older builds only consult the
 * helper when there is no tty *and* a display to blame.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCodes } from "@pi-desktop/shared";

/** Environment variable naming the file the helper reads the secret from. */
export const ASKPASS_SECRET_ENV = "PI_SSH_ASKPASS_SECRET";

/**
 * The helper. `$1` is OpenSSH's prompt text and is deliberately ignored: the
 * same secret answers "user@host's password:" and a key passphrase prompt, and
 * an encrypted key whose passphrase is not this password simply falls through
 * to password authentication. The trailing `echo` terminates the line OpenSSH
 * reads, so a secret without a trailing newline is still returned whole.
 */
export const ASKPASS_HELPER_SCRIPT = `#!/bin/sh
# Written by the desktop app; do not edit. Reads the secret from a 0600 file
# so it never appears in the process list.
cat "\${${ASKPASS_SECRET_ENV}}"
echo
`;

/**
 * A cap, so a paste of something enormous fails as a validation error instead
 * of as a mysterious authentication failure.
 */
const MAX_PASSWORD_LENGTH = 4096;

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}) });
}

/** Validate a supplied login password; returns it unchanged. */
export function assertSshPassword(value: unknown, field = "password"): string {
  if (typeof value !== "string") {
    throw fail(`${field} must be a string`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (value.length === 0) {
    throw fail(`${field} must not be empty`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw fail(`${field} must be at most ${MAX_PASSWORD_LENGTH} characters`, ErrorCodes.INVALID_ARGUMENT, {
      field,
    });
  }
  if (/[\r\n]/.test(value)) {
    // Not a style rule: `ssh` reads the askpass answer up to the first line
    // break, so anything after one would be silently dropped.
    throw fail(`${field} must not contain a line break`, ErrorCodes.INVALID_ARGUMENT, { field });
  }
  return value;
}

/** On-disk credential material handed to one `ssh` child at a time. */
export type SshAskpassMaterial = {
  /** Variables to merge over `process.env` for the `ssh` spawn. */
  env: NodeJS.ProcessEnv;
  /** Delete the secret and the helper. Idempotent. */
  dispose(): Promise<void>;
};

export type SshAskpassOptions = {
  /** Parent directory for the throwaway folder; defaults to the OS temp dir. */
  dir?: string;
  /** Injected for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
};

/**
 * Write the secret and the helper to a throwaway directory.
 *
 * Windows is refused rather than half-supported: its OpenSSH build cannot
 * execute a shell-script askpass helper, and shipping a helper executable is a
 * project of its own. The caller surfaces this as a bootstrap failure naming
 * the remedy (use a key or the agent), which is better than an authentication
 * error the user cannot act on.
 */
export async function createSshAskpass(
  secret: unknown,
  options: SshAskpassOptions = {},
): Promise<SshAskpassMaterial> {
  const password = assertSshPassword(secret);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw fail(
      "password authentication is not supported by OpenSSH on Windows; use an SSH key or agent",
      ErrorCodes.HOST_BOOTSTRAP_FAILED,
      { platform },
    );
  }

  // `mkdtemp` already creates the directory `0700`; the explicit chmod
  // documents that the secret's confidentiality rests on this mode rather than
  // on the inherited umask.
  const dir = await mkdtemp(join(options.dir ?? tmpdir(), "pi-ssh-askpass-"));
  await chmod(dir, 0o700);
  const secretPath = join(dir, "secret");
  const helperPath = join(dir, "askpass.sh");
  try {
    await writeFile(secretPath, password, { mode: 0o600 });
    await writeFile(helperPath, ASKPASS_HELPER_SCRIPT, { mode: 0o700 });
  } catch (error) {
    // A half-written credential is still a credential; do not leave it behind.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    env: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY ?? ":0",
      [ASKPASS_SECRET_ENV]: secretPath,
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
