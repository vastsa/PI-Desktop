/**
 * The GitHub device authorization flow (ADR github-connector).
 *
 * Device flow suits a desktop app that ships no client secret: the app asks
 * GitHub for a short code, the user types it on github.com, and the app polls
 * until GitHub hands over a token. This driver owns that conversation and
 * nothing else — it stores nothing and knows nothing about the connector.
 *
 * Three properties matter:
 *
 * - It talks only to `https://github.com/login/…`, both URLs constants, and
 *   the page it tells the user to open is always on github.com.
 * - It polls no faster than GitHub allows, and backs off when told to.
 * - It stops. Approval, refusal, expiry, and the caller's abort signal each
 *   end it, the expiry is enforced locally, and once the signal fires it makes
 *   no further request and resolves no token, even one already in flight.
 *
 * The device code is as sensitive as the token it turns into, so neither
 * appears in an event or an error.
 */
import {
  ErrorCodes,
  GITHUB_DEVICE_WAITING_MESSAGE,
  isGitHubTokenShape,
} from "@pi-desktop/shared";
import { GitHubApiError } from "./github-api";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Where the user enters the code. GitHub returns this same address. */
export const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60;
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const MAX_EXPIRES_IN_SECONDS = 1800;

export type DeviceFlowEvent =
  | {
      kind: "deviceCode";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresInSeconds: number;
    }
  | { kind: "progress"; message: string };

export type GitHubDeviceFlowOptions = {
  clientId: string;
  scopes: string[];
  onEvent: (event: DeviceFlowEvent) => void;
  /** Aborting ends the flow: no further request, no token. */
  signal: AbortSignal;
  /** Test seam; defaults to the process fetch at the time of each request. */
  fetchImpl?: typeof fetch;
  /** Test seam; must reject when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Test seam for the local expiry check. */
  now?: () => number;
};

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("The GitHub sign-in was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function unavailable(): GitHubApiError {
  return new GitHubApiError(
    ErrorCodes.GITHUB_DEVICE_FLOW_UNAVAILABLE,
    "Sign-in with a code is not available. Use a personal access token.",
  );
}

function expired(): GitHubApiError {
  return new GitHubApiError(
    ErrorCodes.GITHUB_LOGIN_EXPIRED,
    "The sign-in code expired before it was approved. Start again.",
  );
}

/** An OAuth `error` value, reduced to what such a code can contain. */
function oauthErrorName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9_ -]/g, "").slice(0, 64) : "";
}

function authFailed(oauthError?: unknown): GitHubApiError {
  const name = oauthErrorName(oauthError);
  return new GitHubApiError(
    ErrorCodes.GITHUB_AUTH_FAILED,
    name ? `GitHub did not complete the sign-in (${name}).` : "GitHub did not complete the sign-in.",
  );
}

function positiveSeconds(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.ceil(value), max);
}

type Answer = { status: number; body: Record<string, unknown> | null };

export async function runGitHubDeviceFlow(
  options: GitHubDeviceFlowOptions,
): Promise<{ token: string }> {
  const { signal, onEvent } = options;
  const clientId = typeof options.clientId === "string" ? options.clientId.trim() : "";
  if (!clientId) throw unavailable();
  throwIfAborted(signal);

  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  /** One form POST to a fixed github.com URL. A thrown fetch is a network failure. */
  const post = async (url: string, form: Record<string, string>): Promise<Answer> => {
    throwIfAborted(signal);
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    let response: Response;
    let body: Record<string, unknown> | null = null;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "pi-desktop",
        },
        body: new URLSearchParams(form).toString(),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const parsed: unknown = await response.json().catch(() => null);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      throwIfAborted(signal);
      throw new GitHubApiError(ErrorCodes.GITHUB_NETWORK, "GitHub could not be reached.", {
        retriable: true,
      });
    }
    // An answer that arrives after the abort is discarded, token included.
    throwIfAborted(signal);
    return { status: response.status, body };
  };

  const issued = await post(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope: options.scopes.join(" "),
  });
  if (issued.body?.error === "device_flow_disabled") throw unavailable();
  if (issued.status >= 500) {
    throw new GitHubApiError(ErrorCodes.GITHUB_NETWORK, "GitHub is unavailable.", {
      retriable: true,
      status: issued.status,
    });
  }
  const deviceCode = issued.body?.device_code;
  const userCode = issued.body?.user_code;
  if (
    issued.status >= 400 ||
    issued.body?.error !== undefined ||
    typeof deviceCode !== "string" ||
    deviceCode.length === 0 ||
    typeof userCode !== "string" ||
    userCode.length === 0
  ) {
    throw authFailed(issued.body?.error);
  }

  let intervalSeconds = positiveSeconds(
    issued.body?.interval,
    DEFAULT_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  const expiresInSeconds = positiveSeconds(
    issued.body?.expires_in,
    DEFAULT_EXPIRES_IN_SECONDS,
    MAX_EXPIRES_IN_SECONDS,
  );
  const deadline = now() + expiresInSeconds * 1000;

  onEvent({
    kind: "deviceCode",
    userCode,
    // The user is sent to a page where they authorize this app, so it is
    // never an address the response alone chose.
    verificationUri: GITHUB_DEVICE_VERIFICATION_URL,
    intervalSeconds,
    expiresInSeconds,
  });
  onEvent({ kind: "progress", message: GITHUB_DEVICE_WAITING_MESSAGE });

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw expired();
    await sleep(Math.min(intervalSeconds * 1000, remaining), signal);
    throwIfAborted(signal);
    if (now() >= deadline) throw expired();

    let answer: Answer;
    try {
      answer = await post(GITHUB_DEVICE_TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      });
    } catch (error) {
      // The user may be approving in the browser right now; a dropped poll is
      // not a reason to make them start over. The expiry still bounds this.
      if (error instanceof GitHubApiError && error.errorCode === ErrorCodes.GITHUB_NETWORK) {
        continue;
      }
      throw error;
    }
    if (answer.status >= 500 || answer.body === null) continue;

    const accessToken = answer.body.access_token;
    if (accessToken !== undefined) {
      if (typeof accessToken !== "string" || !isGitHubTokenShape(accessToken)) throw authFailed();
      return { token: accessToken };
    }
    switch (answer.body.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalSeconds =
          typeof answer.body.interval === "number"
            ? positiveSeconds(answer.body.interval, intervalSeconds, MAX_INTERVAL_SECONDS)
            : Math.min(intervalSeconds + SLOW_DOWN_STEP_SECONDS, MAX_INTERVAL_SECONDS);
        break;
      case "expired_token":
        throw expired();
      case "access_denied":
        throw new GitHubApiError(
          ErrorCodes.GITHUB_LOGIN_DENIED,
          "The sign-in was declined on GitHub.",
        );
      case "device_flow_disabled":
        throw unavailable();
      default:
        throw authFailed(answer.body.error);
    }
  }
}
