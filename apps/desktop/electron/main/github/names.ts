/**
 * Owner, repository, and branch name rules for the GitHub connector (ADR
 * github-connector).
 *
 * A name is checked before it becomes a URL path segment, a query value, or
 * a request body field. The rules accept every name GitHub can hand back from
 * a listing, so a repository or branch the user picked is never refused by
 * the next call, and refuse what could address a different resource.
 *
 * The host git capability validates the same three values with the same
 * rules before they reach git. They are kept in this one module so they can
 * be replaced by the shared package's validators once both features have
 * landed.
 */

/** GitHub logins, including Enterprise Managed User logins (`handle_shortcode`). */
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const BRANCH_MAX_LENGTH = 244;
/** ASCII control characters, DEL, the space, and git's forbidden punctuation. */
const BRANCH_FORBIDDEN_CHARACTER = /[\u0000- \u007f~^:?*[\\]/;
const BRANCH_FORBIDDEN_SEQUENCES = ["..", "//", "@{", "/."];

/** 1 to 39 of `[A-Za-z0-9_-]`, not starting or ending with a hyphen. */
export function isGitHubOwner(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OWNER_PATTERN.test(value) &&
    !value.startsWith("-") &&
    !value.endsWith("-")
  );
}

/** 1 to 100 of `[A-Za-z0-9._-]`, not `.` or `..`, and not ending in `.git`. */
export function isGitHubRepositoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REPOSITORY_PATTERN.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".git")
  );
}

/**
 * git's reference-name rules (`git check-ref-format`), for one branch name of
 * 1 to 244 characters. Anything the rules do not name is accepted, including
 * `#`, `=`, `&`, and non-ASCII text.
 */
export function isGitBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > BRANCH_MAX_LENGTH) return false;
  if (value === "@") return false;
  if (BRANCH_FORBIDDEN_CHARACTER.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/")) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  return !BRANCH_FORBIDDEN_SEQUENCES.some((sequence) => value.includes(sequence));
}
