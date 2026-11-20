/**
 * Fixed constants and pure checks for the built-in GitHub connector
 * (ADR github-connector).
 *
 * The connector signs the user in once and keeps the token in Electron main.
 * Everything here is safe to ship to the renderer: a public OAuth client id,
 * scope names, and the shape check both sides apply to a pasted token.
 */

/**
 * Client id of the fork's GitHub OAuth App. Public by design: device flow
 * uses no client secret. Empty until the owner registers the app, and while
 * it is empty sign-in is by pasted personal access token only.
 */
export const GITHUB_OAUTH_CLIENT_ID: string = "";

export const GITHUB_MCP_SERVER_ID = "github";
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_MCP_TOOLSETS = "issues,pull_requests";

/** Scopes every sign-in asks for: repository access and organization membership. */
export const GITHUB_CONNECTOR_BASE_SCOPES = ["repo", "read:org"] as const;

/** Opt-in scope that lets a push change files under `.github/workflows`. */
export const GITHUB_CONNECTOR_WORKFLOW_SCOPE = "workflow";

/**
 * Stands in for a provider id in the login events the connector emits, which
 * reuse the vendor-account `OAuthLoginEvent` shape.
 */
export const GITHUB_CONNECTOR_LOGIN_ID = "github-connector";

/**
 * The progress line main emits while a device code waits for approval. Main
 * authors it in English; the renderer recognizes this exact text and shows
 * its own translation instead.
 */
export const GITHUB_DEVICE_WAITING_MESSAGE = "Waiting for approval on GitHub…";

/** Longest token the connector accepts; GitHub's own formats are far shorter. */
export const GITHUB_TOKEN_MAX_LENGTH = 4096;

/** The scopes one sign-in requests. Returns a new array on every call. */
export function githubConnectorScopes(allowWorkflowScope: boolean): string[] {
  const scopes: string[] = [...GITHUB_CONNECTOR_BASE_SCOPES];
  if (allowWorkflowScope) scopes.push(GITHUB_CONNECTOR_WORKFLOW_SCOPE);
  return scopes;
}

/**
 * Whether a string can be a GitHub token at all: 1 to 4096 printable ASCII
 * characters (0x21 to 0x7E), so no whitespace, no control character, and
 * nothing a header value cannot carry. This is a shape check, not a format
 * check — GitHub has changed its token prefixes before. It keeps a pasted
 * value with an embedded newline out of a request header, and it makes a
 * stray smart quote or accented letter an invalid token rather than a
 * transport failure that reads like a network problem.
 */
export function isGitHubTokenShape(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > GITHUB_TOKEN_MAX_LENGTH) return false;
  return /^[\x21-\x7e]+$/.test(value);
}
