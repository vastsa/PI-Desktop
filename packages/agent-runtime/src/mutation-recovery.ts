import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_MUTATION_RECOVERY_FAILURES = 3;
export const BASH_PATCH_FAILURE_KEY = "__bash_patch_command__";
/**
 * Edit failures the line-anchored contract expects and already answers: each
 * one hands back the live tag, or the content of the lines it refused to write
 * blind (spec 18-line-anchored-edit-contract §9.3). One honest retry is the designed response, so each of
 * these codes gets a single free attempt per path before it counts toward the
 * recovery guard. Everything else — malformed ops, bad ranges, a no-op apply —
 * counts immediately, because a second one is the model guessing.
 */
export const RECOVERABLE_MUTATION_ERROR_CODES = new Set([
  "EDIT_TAG_MISMATCH",
  "EDIT_TAG_UNKNOWN",
  "EDIT_LINES_UNSEEN",
]);

export function mutationTerminationAdvice(
  kind: "edit" | "patch-command",
  errorCode?: string,
): string {
  if (kind === "patch-command") {
    return "Use Edit on the specific lines instead of repeating a shell patch command.";
  }
  if (errorCode === "EDIT_PARSE_FAILED") {
    return "Fix the Edit ops syntax and retry with a corrected payload; do not repeat the same ops. A PUT with body rows must end its header with `:`, for example `PUT 48.=48:`.";
  }
  if (errorCode === "EDIT_RANGE_INVALID") {
    return "Correct the Edit range or operation overlap before retrying; re-reading is not needed unless the file changed.";
  }
  if (errorCode === "EDIT_NO_CHANGE") {
    return "Send only changed body rows, or use CUT when the intended result is deletion.";
  }
  if (RECOVERABLE_MUTATION_ERROR_CODES.has(errorCode ?? "")) {
    return errorCode === "EDIT_LINES_UNSEEN"
      ? "Use the revealed lines for one unchanged retry when the reveal is complete; otherwise re-read the range and regenerate the Edit."
      : "Re-read the live file and regenerate the Edit with the fresh tag and narrower anchors.";
  }
  return "Re-read the live file, regenerate a narrower Edit, and avoid repeating the same payload.";
}
/** Bookkeeping identity only; Host still resolves and authorizes the original path. */
export async function mutationFailureKey(path: string, projectPath?: string): Promise<string> {
  const absolute = resolve(projectPath ?? process.cwd(), path);
  try {
    // The runtime and Host run on the same machine, including headless hosts.
    // Keep the filesystem's canonical spelling: lowercasing would merge distinct
    // files on POSIX and on case-sensitive Windows directories.
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EINVAL", "ELOOP"].includes(code ?? "")) throw error;
    // Missing or inaccessible targets have no usable canonical spelling. Keep
    // their lexical identity, and let the Host report the actual tool error.
    return absolute;
  }
}

/**
 * Shell operators that begin another command. Every check runs on a segment
 * after splitting on them: tokens behind a pipe, `&&`, `;`, or a newline
 * belong to a different process, so `git log | grep apply` is not a patch and
 * `kubectl apply` after `git pull` is not a git patch (#1985).
 */
const COMMAND_SEGMENTS = /(?:\|\||&&|[|;&])|\n/;

/**
 * Global git flags that consume the following token as their value; every
 * other flag stands alone. This keeps `git -C repo apply` a patch while
 * `git grep apply` (whose subcommand is `grep`) stays a search.
 */
const GIT_FLAGS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

/**
 * Whether one command segment invokes `git apply`: `git` at the command
 * position (optionally after a path prefix, an `env`/`command` wrapper, or
 * leading `VAR=value` assignments), only git's own global flags between it
 * and the subcommand, and `apply` as that subcommand.
 */
function segmentInvokesGitApply(segment: string): boolean {
  const tokens = segment
    .replace(/^\s*[({]+/, "")
    .replace(/[)}\s]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  while (
    tokens.length > 1 &&
    (/^(?:env|command)$/.test(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))
  ) {
    tokens.shift();
  }
  if (!/^(?:\S+\/)?git$/.test(tokens[0] ?? "")) return false;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    if (GIT_FLAGS_WITH_VALUE.has(tokens[index])) index += 1;
    index += 1;
  }
  return tokens[index] === "apply";
}

export function isPatchCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.split(COMMAND_SEGMENTS).some((segment) => {
    const head = segment.replace(/^\s+/, "");
    if (
      /^(?:env\s+|command\s+)?(?:\S+\/)?apply_patch(?:\s|$)/.test(head) ||
      /^(?:env\s+|command\s+)?(?:\S+\/)?patch(?:\s|$)/.test(head)
    ) {
      return true;
    }
    return segmentInvokesGitApply(head);
  });
}

export function mutationTerminationMessage(
  kind: "edit" | "patch-command",
  target: string,
  errorCode?: string,
): string {
  const recovery = mutationTerminationAdvice(kind, errorCode);
  const lastError = errorCode ? ` Last error: ${errorCode}.` : "";
  return kind === "edit"
    ? `Stopped after ${MAX_MUTATION_RECOVERY_FAILURES} failed Edit attempts on ${target}.${lastError} ${recovery}`
    : `Stopped after ${MAX_MUTATION_RECOVERY_FAILURES} failed patch commands.${lastError} ${recovery}`;
}
