/**
 * The GitHub REST client behind the connector (ADR github-connector).
 *
 * This is the only code that spends the user's GitHub token, so it is narrow
 * on purpose:
 *
 * - Every request goes to `https://api.github.com`. The host is a constant;
 *   no caller supplies a URL, and a redirect is never followed, so the
 *   `Authorization` header cannot travel to another address. GitHub redirects
 *   a renamed or transferred repository; that is reported as "not found".
 * - Owner, repository, and branch names are checked (`./names`) before they
 *   become a path segment or a query value, and are encoded where they land.
 * - Failures are typed. A revoked token, a rate limit, a refusal, and an
 *   outage are different codes, and a failed page fails the whole listing: an
 *   incomplete list is never returned as if it were the account's repositories.
 * - No message, field, or cause of a thrown error carries the token.
 *
 * The transport defaults to the process `fetch`, resolved per call: Electron
 * main replaces it with the proxy-aware one after startup.
 */
import {
  ErrorCodes,
  isGitHubTokenShape,
  type GitHubBranchList,
  type GitHubBranchSummary,
  type GitHubPullRequestInput,
  type GitHubPullRequestSummary,
  type GitHubRepositoryList,
  type GitHubRepositoryRef,
  type GitHubRepositorySummary,
} from "@pi-desktop/shared";
import { isGitBranchName, isGitHubOwner, isGitHubRepositoryName } from "./names";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_TIMEOUT_MS = 20_000;

const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "pi-desktop";
const PAGE_SIZE = 100;
/** Documented caps: 1000 repositories and 500 branches; `truncated` says so beyond them. */
const REPOSITORY_PAGE_LIMIT = 10;
const BRANCH_PAGE_LIMIT = 5;
/** Longest GitHub-authored text echoed in an error message. */
const MAX_DETAIL_LENGTH = 300;

export type GitHubViewer = {
  login: string;
  name?: string;
  avatarUrl?: string;
  scopes: string[];
};

export type GitHubApi = {
  viewer(token: string): Promise<GitHubViewer>;
  listRepositories(token: string): Promise<GitHubRepositoryList>;
  listBranches(token: string, repository: GitHubRepositoryRef): Promise<GitHubBranchList>;
  findPullRequest(
    token: string,
    repository: GitHubRepositoryRef,
    head: string,
  ): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(
    token: string,
    repository: GitHubRepositoryRef,
    input: GitHubPullRequestInput,
  ): Promise<GitHubPullRequestSummary>;
};

export type GitHubApiOptions = {
  /** Test seam; defaults to the process fetch at the time of each call. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam for the retry time derived from `retry-after`. */
  now?: () => number;
};

type GitHubApiErrorDetails = { retriable?: boolean; status?: number; resetAt?: string };

export class GitHubApiError extends Error {
  readonly errorCode: string;
  readonly retriable: boolean;
  readonly status?: number;
  /** ISO time a rate limit lifts, when GitHub stated one. */
  readonly resetAt?: string;
  /**
   * The same facts in the shape the IPC registrar forwards as `AppError`
   * (`retriable`, `details`). Never holds the token.
   */
  readonly data: { errorCode: string; retriable: boolean; status?: number; resetAt?: string };

  constructor(errorCode: string, message: string, details: GitHubApiErrorDetails = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.errorCode = errorCode;
    this.retriable = details.retriable === true;
    if (details.status !== undefined) this.status = details.status;
    if (details.resetAt !== undefined) this.resetAt = details.resetAt;
    this.data = { errorCode, retriable: this.retriable };
    if (details.status !== undefined) this.data.status = details.status;
    if (details.resetAt !== undefined) this.data.resetAt = details.resetAt;
  }
}

function invalid(what: string): GitHubApiError {
  return new GitHubApiError(ErrorCodes.INVALID_ARGUMENT, `That is not a valid GitHub ${what}.`);
}

/** `/repos/{owner}/{repo}` with both segments validated and encoded. */
function repositoryPath(repository: GitHubRepositoryRef): string {
  if (!repository || typeof repository !== "object") throw invalid("repository");
  if (!isGitHubOwner(repository.owner)) throw invalid("owner name");
  if (!isGitHubRepositoryName(repository.name)) throw invalid("repository name");
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function branchName(value: unknown): string {
  if (!isGitBranchName(value)) throw invalid("branch name");
  return value;
}

/** Text that never carries the credential it describes. */
function redact(value: string, token: string): string {
  if (!token) return value;
  return value.split(token).join("[redacted]");
}

function detail(value: unknown, token: string): string {
  if (typeof value !== "string") return "";
  return redact(value, token).replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_LENGTH);
}

/**
 * How a transport says "that was a redirect and I did not follow it". Node's
 * fetch returns the 3xx response. Electron's `net.fetch` — the process fetch
 * in main — rejects with "Redirect was cancelled" instead, and a browser-style
 * fetch returns an opaque response with status 0.
 */
function isRedirectResponse(response: Response): boolean {
  return (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect";
}

function isRefusedRedirect(error: unknown): boolean {
  return error instanceof Error && /\bredirect/i.test(error.message);
}

/**
 * A redirect that was not followed. GitHub answers a repository's old name
 * with a 301 after a rename or transfer; retrying that name never works, so
 * it is "not found". Nothing moves an account endpoint, so a redirect there
 * is something between the app and GitHub.
 */
function redirectFailure(path: string, status?: number): GitHubApiError {
  if (path.startsWith("/repos/")) {
    return new GitHubApiError(
      ErrorCodes.GITHUB_NOT_FOUND,
      "This repository was renamed or moved on GitHub. Pick it again from the list.",
      { status },
    );
  }
  return new GitHubApiError(
    ErrorCodes.GITHUB_NETWORK,
    "GitHub could not be reached: the request was redirected.",
    { retriable: true, status },
  );
}

/**
 * GitHub answers a listing with 200 and `X-GitHub-SSO: partial-results; …`
 * when it left out what an organization's SAML SSO does not let this token
 * see. Without this the short list would pass for the whole account.
 */
function isSsoPartial(response: Response): boolean {
  return /^\s*partial-results\b/i.test(response.headers.get("x-github-sso") ?? "");
}

function unreadable(status?: number): GitHubApiError {
  return new GitHubApiError(
    ErrorCodes.GITHUB_NETWORK,
    "GitHub returned an answer that could not be read.",
    { retriable: true, status },
  );
}

/** When a rate limit lifts, from `retry-after` first and the reset header second. */
function rateLimitReset(headers: Headers, now: () => number): string | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
      return new Date(now() + seconds * 1000).toISOString();
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  return undefined;
}

/** GitHub's own explanation of a failure: the first validation error, else the message. */
function githubMessage(body: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as { message?: unknown; errors?: unknown };
  if (Array.isArray(record.errors)) {
    for (const entry of record.errors) {
      const text =
        typeof entry === "string" ? entry : (entry as { message?: unknown } | null)?.message;
      const first = detail(text, token);
      if (first) return first;
    }
  }
  return detail(record.message, token);
}

async function failureFor(
  response: Response,
  token: string,
  now: () => number,
): Promise<GitHubApiError> {
  const status = response.status;
  const body = await response.text().catch(() => "");
  const message = githubMessage(body, token);
  const withDetail = (summary: string) => (message ? `${summary} ${message}` : summary);

  if (status === 401) {
    return new GitHubApiError(ErrorCodes.GITHUB_AUTH_FAILED, "GitHub rejected the saved token.", {
      status,
    });
  }
  // A secondary limit can arrive as a bare 403 with quota left and no
  // retry-after; GitHub's message is then the only thing that names it.
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after") !== null ||
        /secondary rate limit/i.test(message)));
  if (rateLimited) {
    return new GitHubApiError(
      ErrorCodes.GITHUB_RATE_LIMITED,
      "GitHub is rate limiting requests. Try again later.",
      { retriable: true, status, resetAt: rateLimitReset(response.headers, now) },
    );
  }
  if (status === 403) {
    return new GitHubApiError(
      ErrorCodes.GITHUB_FORBIDDEN,
      withDetail("GitHub refused the request."),
      { status },
    );
  }
  if (status === 404) {
    return new GitHubApiError(
      ErrorCodes.GITHUB_NOT_FOUND,
      "GitHub could not find that, or the connected account cannot see it.",
      { status },
    );
  }
  if (status >= 500) {
    return new GitHubApiError(ErrorCodes.GITHUB_NETWORK, `GitHub is unavailable (${status}).`, {
      retriable: true,
      status,
    });
  }
  return new GitHubApiError(
    ErrorCodes.GITHUB_VALIDATION_FAILED,
    withDetail(`GitHub rejected the request (${status}).`),
    { status },
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRepository(raw: unknown): GitHubRepositorySummary | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const owner = (item.owner as { login?: unknown } | null | undefined)?.login;
  if (typeof owner !== "string" || typeof item.name !== "string") return null;
  const summary: GitHubRepositorySummary = {
    owner,
    name: item.name,
    fullName: typeof item.full_name === "string" ? item.full_name : `${owner}/${item.name}`,
    private: item.private === true,
    defaultBranch: typeof item.default_branch === "string" ? item.default_branch : "",
    archived: item.archived === true,
  };
  const pushedAt = optionalString(item.pushed_at);
  if (pushedAt !== undefined) summary.pushedAt = pushedAt;
  const description = optionalString(item.description);
  if (description !== undefined) summary.description = description;
  return summary;
}

function toBranch(raw: unknown): GitHubBranchSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== "string") return null;
  return { name: item.name, protected: item.protected === true };
}

function toPullRequest(raw: unknown): GitHubPullRequestSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const head = (item.head as { ref?: unknown } | null | undefined)?.ref;
  const base = (item.base as { ref?: unknown } | null | undefined)?.ref;
  if (
    typeof item.number !== "number" ||
    typeof item.html_url !== "string" ||
    typeof head !== "string" ||
    typeof base !== "string"
  ) {
    return null;
  }
  return {
    number: item.number,
    url: item.html_url,
    title: typeof item.title === "string" ? item.title : "",
    draft: item.draft === true,
    state: optionalString(item.merged_at) ? "merged" : item.state === "open" ? "open" : "closed",
    head,
    base,
  };
}

function createdAt(raw: unknown): number {
  const value = (raw as { created_at?: unknown } | null)?.created_at;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

export function createGitHubApi(options: GitHubApiOptions = {}): GitHubApi {
  const timeoutMs = options.timeoutMs ?? GITHUB_API_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  /** One request to the fixed API host. Resolves the response and its parsed JSON body. */
  async function request(
    token: string,
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
  ): Promise<{ response: Response; json: unknown }> {
    // A stored record is shape-checked on read; this keeps any other caller
    // from putting a newline into the Authorization header.
    if (!isGitHubTokenShape(token)) {
      throw new GitHubApiError(ErrorCodes.GITHUB_INVALID_TOKEN, "The GitHub token is not valid.");
    }
    const url = new URL(`${GITHUB_API_BASE_URL}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    if (url.origin !== GITHUB_API_BASE_URL) throw invalid("request");

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const doFetch = options.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(url.toString(), init);
    } catch (error) {
      if (isRefusedRedirect(error)) throw redirectFailure(path);
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new GitHubApiError(
          ErrorCodes.GITHUB_NETWORK,
          `GitHub did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          { retriable: true },
        );
      }
      const reason = detail(error instanceof Error ? error.message : String(error), token);
      throw new GitHubApiError(
        ErrorCodes.GITHUB_NETWORK,
        reason ? `GitHub could not be reached: ${reason}` : "GitHub could not be reached.",
        { retriable: true },
      );
    }
    if (isRedirectResponse(response)) {
      throw redirectFailure(path, response.status > 0 ? response.status : undefined);
    }
    if (!response.ok) throw await failureFor(response, token, now);
    try {
      return { response, json: (await response.json()) as unknown };
    } catch {
      throw unreadable(response.status);
    }
  }

  /**
   * Read a paged list to its end or to `pageLimit` pages. `truncated` is true
   * when the last allowed page was full, so more may exist. `ssoPartial` is
   * true when any page was trimmed for organization SSO. Any failed page
   * rejects the whole read.
   */
  async function readPages<T>(
    token: string,
    path: string,
    query: Record<string, string>,
    pageLimit: number,
    convert: (raw: unknown) => T | null,
  ): Promise<{ items: T[]; truncated: boolean; ssoPartial: boolean }> {
    const items: T[] = [];
    let ssoPartial = false;
    for (let page = 1; page <= pageLimit; page += 1) {
      const { response, json } = await request(token, "GET", path, {
        ...query,
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      if (!Array.isArray(json)) throw unreadable(response.status);
      if (isSsoPartial(response)) ssoPartial = true;
      for (const raw of json) {
        const item = convert(raw);
        if (item) items.push(item);
      }
      if (json.length < PAGE_SIZE) return { items, truncated: false, ssoPartial };
    }
    return { items, truncated: true, ssoPartial };
  }

  return {
    async viewer(token) {
      const { response, json } = await request(token, "GET", "/user");
      const user = json as { login?: unknown; name?: unknown; avatar_url?: unknown } | null;
      if (!user || typeof user.login !== "string" || user.login.length === 0) {
        throw unreadable(response.status);
      }
      const viewer: GitHubViewer = {
        login: user.login,
        // Classic and OAuth tokens list their scopes here; a fine-grained
        // token sends no such header and so has none to report.
        scopes: (response.headers.get("x-oauth-scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0),
      };
      const name = optionalString(user.name);
      if (name !== undefined) viewer.name = name;
      const avatarUrl = optionalString(user.avatar_url);
      if (avatarUrl !== undefined) viewer.avatarUrl = avatarUrl;
      return viewer;
    },

    async listRepositories(token) {
      const { items, truncated, ssoPartial } = await readPages(
        token,
        "/user/repos",
        { sort: "pushed", affiliation: "owner,collaborator,organization_member" },
        REPOSITORY_PAGE_LIMIT,
        toRepository,
      );
      const list: GitHubRepositoryList = { repositories: items, truncated };
      if (ssoPartial) list.ssoPartial = true;
      return list;
    },

    async listBranches(token, repository) {
      const path = repositoryPath(repository);
      const { response, json } = await request(token, "GET", path);
      const defaultBranch = (json as { default_branch?: unknown } | null)?.default_branch;
      if (typeof defaultBranch !== "string") throw unreadable(response.status);
      const { items, truncated, ssoPartial } = await readPages(
        token,
        `${path}/branches`,
        {},
        BRANCH_PAGE_LIMIT,
        toBranch,
      );
      const list: GitHubBranchList = { branches: items, defaultBranch, truncated };
      if (ssoPartial || isSsoPartial(response)) list.ssoPartial = true;
      return list;
    },

    async findPullRequest(token, repository, head) {
      const path = repositoryPath(repository);
      const branch = branchName(head);
      const { response, json } = await request(token, "GET", `${path}/pulls`, {
        state: "all",
        head: `${repository.owner}:${branch}`,
        per_page: "5",
      });
      if (!Array.isArray(json)) throw unreadable(response.status);
      const open = json.find((raw) => (raw as { state?: unknown } | null)?.state === "open");
      const chosen =
        open ?? [...json].sort((left, right) => createdAt(right) - createdAt(left))[0];
      if (chosen === undefined) return null;
      const summary = toPullRequest(chosen);
      if (!summary) throw unreadable(response.status);
      return summary;
    },

    async createPullRequest(token, repository, input) {
      const path = repositoryPath(repository);
      if (!input || typeof input !== "object") throw invalid("pull request");
      const head = branchName(input.head);
      const base = branchName(input.base);
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        throw invalid("pull request title");
      }
      const { response, json } = await request(token, "POST", `${path}/pulls`, undefined, {
        title: input.title,
        head,
        base,
        body: typeof input.body === "string" ? input.body : "",
        draft: input.draft === true,
      });
      const summary = toPullRequest(json);
      if (!summary) throw unreadable(response.status);
      return summary;
    },
  };
}
