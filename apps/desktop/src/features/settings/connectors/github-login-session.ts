/**
 * Lets the vendor-account login dialog report a GitHub device login (ADR
 * github-connector).
 *
 * `OAuthLoginDialog` already renders a device code, a verification link, and
 * a cancel button from an `OAuthLoginSession`. GitHub's connector is not a
 * model vendor and has its own channels, so this maps the session's API onto
 * them instead of building a second dialog. The token never comes through
 * here: main keeps it, and the events carry a code to type and an account
 * name.
 */
import { GITHUB_CONNECTOR_LOGIN_ID, type OAuthVendor } from "@pi-desktop/shared";
import {
  beginOAuthLogin,
  type OAuthLoginApi,
  type OAuthLoginSession,
} from "../../../lib/oauth-login-session";
import type { api } from "../../../lib/api";

/** The slice of the preload API a GitHub login needs; injected so it can be tested. */
export type GitHubLoginSource = Pick<
  typeof api,
  "onGithubLogin" | "startGithubLogin" | "cancelGithubLogin"
>;

export type GitHubLoginOptions = {
  /** Also request the `workflow` scope. */
  allowWorkflowScope: boolean;
};

/** What the dialog shows in its title. GitHub owns no provider account. */
export const GITHUB_LOGIN_VENDOR: OAuthVendor = {
  vendorId: GITHUB_CONNECTOR_LOGIN_ID,
  name: "GitHub",
  isSubscription: false,
  accounts: [],
};

export function githubLoginApi(
  source: GitHubLoginSource,
  { allowWorkflowScope }: GitHubLoginOptions,
): OAuthLoginApi {
  return {
    onOauthLogin: (listener) => source.onGithubLogin(listener),
    // The session passes a vendor id; the connector has one fixed flow.
    startOauthLogin: () => source.startGithubLogin({ allowWorkflowScope }),
    // A device login raises no prompt, so there is never an answer to send.
    respondOauthLogin: async () => ({ ok: false }),
    cancelOauthLogin: (loginId) => source.cancelGithubLogin(loginId),
  };
}

/**
 * Begin one device login. Call it from a click handler, never from an effect:
 * the attempt must start exactly once (see `beginOAuthLogin`).
 */
export function beginGitHubLogin(
  source: GitHubLoginSource,
  options: GitHubLoginOptions,
): OAuthLoginSession {
  return beginOAuthLogin({
    api: githubLoginApi(source, options),
    vendorId: GITHUB_CONNECTOR_LOGIN_ID,
  });
}
