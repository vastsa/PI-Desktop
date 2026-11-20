/**
 * Renderer-visible shapes of the built-in GitHub connector (ADR
 * github-connector). None of them carries the token: it stays in Electron
 * main, and these describe only the account, what it may do, and what GitHub
 * returned.
 */

export type GitHubConnectorAccount = {
  login: string;
  name?: string;
  avatarUrl?: string;
};

export type GitHubConnectorStatus = {
  connected: boolean;
  /** Sign-in with a device code is possible: the build carries an OAuth client id. */
  deviceLoginAvailable: boolean;
  account?: GitHubConnectorAccount;
  /** Scopes GitHub reported for the token. Empty for a fine-grained token. */
  scopes?: string[];
  tokenKind?: "oauth" | "pat";
  /** GitHub answered 401 with the stored token; the user has to connect again. */
  needsReauthentication?: boolean;
};

export type GitHubRepositorySummary = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  pushedAt?: string;
  description?: string;
};

export type GitHubBranchSummary = { name: string; protected: boolean };

export type GitHubPullRequestSummary = {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  head: string;
  base: string;
};

/** A repository named by its owner and name, as every connector call takes it. */
export type GitHubRepositoryRef = { owner: string; name: string };

export type GitHubRepositoryListInput = { query?: string; refresh?: boolean };

export type GitHubRepositoryList = {
  repositories: GitHubRepositorySummary[];
  /** More repositories exist than the connector reads; the list is a prefix. */
  truncated: boolean;
  /**
   * GitHub left entries out because an organization's SAML SSO has not
   * authorized this token. The list is real but incomplete; absent otherwise.
   */
  ssoPartial?: boolean;
};

export type GitHubBranchList = {
  branches: GitHubBranchSummary[];
  defaultBranch: string;
  /** More branches exist than the connector reads; the list is a prefix. */
  truncated: boolean;
  /** GitHub trimmed the answer for organization SSO, as for repositories. */
  ssoPartial?: boolean;
};

export type GitHubPullRequestInput = {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};
