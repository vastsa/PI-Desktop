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
 * Split a command into segments at shell operators (`||`, `&&`, `|`, `;`, `&`,
 * newline). Quote-aware: an operator inside a quoted span never splits, so
 * `printf "%s" "hello; patch notes"` stays one segment and its quoted `patch`
 * stays inert text. Heredoc bodies and comments are excluded too: the data
 * lines after `<<tag` and everything behind an unquoted `#` are payload, not
 * command positions, so `cat <<'EOF'\npatch notes\nEOF` and
 * `printf x # ; patch notes` cannot invent a patch (#2016 review round two).
 * Every check runs on a segment after splitting: tokens behind a pipe, `&&`,
 * `;`, or a newline belong to a different process, so `git log | grep apply`
 * is not a patch and `kubectl apply` after `git pull` is not a git patch
 * (#1985).
 *
 * This is best-effort segmentation for the recovery guard, not a shell
 * parser: quotes, backslash escapes, comments and heredocs are modeled,
 * shell grammar like command substitution is not — an unmodeled construct
 * must never invent a patch invocation, so in doubt the text is treated as
 * inert. The failure mode stays asymmetric: a missed patch only skips
 * recovery, and widening this into real shell parsing is never worth the
 * false positives.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  /** When set, whole lines are heredoc payload until a line holding the tag. */
  let heredocTag: string | null = null;
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (heredocTag !== null) {
      // The body and its closing tag line are data; the closing line is not a
      // command either. An unmatched tag consumes the rest — a real shell
      // would read the same lines as stdin.
      const lineEnd = command.indexOf("\n", index);
      const line = lineEnd === -1 ? command.slice(index) : command.slice(index, lineEnd);
      if (line.trim() === heredocTag) heredocTag = null;
      index = lineEnd === -1 ? command.length : lineEnd + 1;
      continue;
    }
    if (quote) {
      current += char;
      // Inside double quotes a backslash escapes the next character; inside
      // single quotes everything is literal until the closing quote.
      if (quote === '"' && char === "\\" && index + 1 < command.length) {
        current += command[++index]!;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      current += char;
      if (index + 1 < command.length) current += command[++index]!;
      index += 1;
      continue;
    }
    if (char === "#" && (current === "" || /\s$/.test(current))) {
      // A word-boundary `#` comments out the rest of the line; the newline
      // itself stays a segment boundary.
      const lineEnd = command.indexOf("\n", index);
      index = lineEnd === -1 ? command.length : lineEnd;
      continue;
    }
    if (char === "<" && command[index + 1] === "<") {
      if (command[index + 2] === "<") {
        // Here-string: the word after it is an argument, not a body.
        current += "<<<";
        index += 3;
        continue;
      }
      const tag = parseHeredocTag(command, index + 2);
      if (tag !== null) {
        heredocTag = tag.text;
        index = tag.end;
        continue;
      }
    }
    if (char === "|" || char === ";" || char === "&" || char === "\n") {
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  segments.push(current);
  return segments;
}

/** Read the tag after `<<` (or `<<-`). Null when there is no tag word. */
function parseHeredocTag(command: string, start: number): { text: string; end: number } | null {
  let index = start;
  if (command[index] === "-") index += 1;
  let text = "";
  let quote: '"' | "'" | null = null;
  while (index < command.length) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        index += 1;
        continue;
      }
      text += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (/\s/.test(char) || ";|&<>".includes(char)) break;
    text += char;
    index += 1;
  }
  return text ? { text, end: index } : null;
}

/**
 * Shell-style tokens for one segment, quotes resolved the way the shell
 * resolves them for the child process: a quoted span (single or double) is
 * one argument regardless of the whitespace and operators it contains, and
 * the quote characters themselves are not part of the argument. An unquoted
 * backslash escapes the next character; inside double quotes only `\"` and
 * `\\` are escapes. An empty quoted argument still yields a token — `git -C
 * "" apply` passes an empty `-C` value, so token existence is kept separate
 * from token text. Same best-effort contract as the splitter above.
 */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let token = "";
  /** Whether anything entered the current token, quotes included. */
  let started = false;
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (started) tokens.push(token);
    token = "";
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (quote === "'") {
      // A closing single quote ends the span; the quote itself is not part of
      // the argument the shell hands over.
      if (char === "'") quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (
        char === "\\" &&
        index + 1 < segment.length &&
        (segment[index + 1] === '"' || segment[index + 1] === "\\")
      ) {
        token += segment[++index]!;
        started = true;
        continue;
      }
      if (char === '"') quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 < segment.length) token += segment[++index]!;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      endToken();
      continue;
    }
    token += char;
    started = true;
  }
  endToken();
  return tokens;
}

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
 * and the subcommand, and `apply` as that subcommand. Tokens come from the
 * quote-aware tokenizer, so an option value with spaces or quotes
 * (`-C "/tmp/my project"`, `-c core.sshCommand="ssh -i /tmp/key"`) is
 * consumed whole instead of leaving its tail to masquerade as the
 * subcommand (#2016 review).
 */
function segmentInvokesGitApply(segment: string): boolean {
  const prepared = segment.replace(/^\s*[({]+/, "").replace(/[)}\s]+$/, "");
  const candidates = tokenizeSegment(prepared);
  while (
    candidates.length > 1 &&
    (/^(?:env|command)$/.test(candidates[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(candidates[0]!))
  ) {
    candidates.shift();
  }
  if (!/^(?:\S+\/)?git$/.test(candidates[0] ?? "")) return false;
  let index = 1;
  while (index < candidates.length && candidates[index]!.startsWith("-")) {
    if (GIT_FLAGS_WITH_VALUE.has(candidates[index]!)) index += 1;
    index += 1;
  }
  return candidates[index] === "apply";
}

/**
 * Whether one command segment's own command word is `apply_patch` or `patch`
 * (with the same optional `env`/`command` wrapper and path prefix the old
 * head regex allowed). Token-based so a quoted command word counts and a
 * quoted operator cannot smuggle one in.
 */
function segmentInvokesPatcher(tokens: readonly string[]): boolean {
  let index = 0;
  if (index < tokens.length && /^(?:env|command)$/.test(tokens[index]!)) index += 1;
  const head = tokens[index] ?? "";
  return (
    head === "apply_patch" ||
    head === "patch" ||
    head.endsWith("/apply_patch") ||
    head.endsWith("/patch")
  );
}

export function isPatchCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return splitCommandSegments(command).some((segment) => {
    const prepared = segment.replace(/^\s*[({]+/, "").replace(/[)}\s]+$/, "");
    const tokens = tokenizeSegment(prepared);
    return segmentInvokesPatcher(tokens) || segmentInvokesGitApply(prepared);
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
