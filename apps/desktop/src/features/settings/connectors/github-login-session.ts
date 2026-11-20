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
 *
 * Main writes its progress and error text in English. The adapter is where
 * that text is replaced by the catalog's: an error by its code, the waiting
 * line by the exact message main is known to send.
 */
import {
  GITHUB_CONNECTOR_LOGIN_ID,
  GITHUB_DEVICE_WAITING_MESSAGE,
  type OAuthLoginEvent,
  type OAuthVendor,
} from "@pi-desktop/shared";
import {
  beginOAuthLogin,
  type OAuthLoginApi,
  type OAuthLoginSession,
} from "../../../lib/oauth-login-session";
import type { api } from "../../../lib/api";
import { githubErrorText, githubErrorTextForCode, type Translate } from "./github-error-message";

/** The slice of the preload API a GitHub login needs; injected so it can be tested. */
export type GitHubLoginSource = Pick<
  typeof api,
  "onGithubLogin" | "startGithubLogin" | "cancelGithubLogin"
>;

export type GitHubLoginOptions = {
  /** Also request the `workflow` scope. */
  allowWorkflowScope: boolean;
  /** Translates what main reports; without it main's English text is shown. */
  t?: Translate;
};

const WAITING_KEY = "settings.connectors.github.waitingForApproval";

/** One login event with main's English text replaced by the catalog's. */
function localized(event: OAuthLoginEvent, t: Translate): OAuthLoginEvent {
  if (event.kind === "error") {
    return { ...event, message: githubErrorTextForCode(t, event.code, event.message) };
  }
  if (event.kind === "progress" && event.message === GITHUB_DEVICE_WAITING_MESSAGE) {
    return { ...event, message: t(WAITING_KEY, { defaultValue: event.message }) };
  }
  return event;
}

/** What the dialog shows in its title. GitHub owns no provider account. */
export const GITHUB_LOGIN_VENDOR: OAuthVendor = {
  vendorId: GITHUB_CONNECTOR_LOGIN_ID,
  name: "GitHub",
  isSubscription: false,
  accounts: [],
};

export function githubLoginApi(
  source: GitHubLoginSource,
  { allowWorkflowScope, t }: GitHubLoginOptions,
): OAuthLoginApi {
  return {
    onOauthLogin: (listener) =>
      source.onGithubLogin(t ? (event) => listener(localized(event, t)) : listener),
    // The session passes a vendor id; the connector has one fixed flow.
    startOauthLogin: async () => {
      try {
        return await source.startGithubLogin({ allowWorkflowScope });
      } catch (error) {
        // The session turns a failed start into the dialog's error line.
        if (!t) throw error;
        throw new Error(githubErrorText(t, error));
      }
    },
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
