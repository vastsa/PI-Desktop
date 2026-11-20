import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  GITHUB_CONNECTOR_BASE_SCOPES,
  GITHUB_CONNECTOR_LOGIN_ID,
  GITHUB_CONNECTOR_SECRET_REF,
  GITHUB_CONNECTOR_WORKFLOW_SCOPE,
  GITHUB_OAUTH_CLIENT_ID,
  githubConnectorScopes,
  isGitHubTokenShape,
} from "./index.js";

describe("GitHub connector contract", () => {
  it("pins the constants other plans build against", () => {
    expect(typeof GITHUB_OAUTH_CLIENT_ID).toBe("string");
    expect([...GITHUB_CONNECTOR_BASE_SCOPES]).toEqual(["repo", "read:org"]);
    expect(GITHUB_CONNECTOR_WORKFLOW_SCOPE).toBe("workflow");
    expect(GITHUB_CONNECTOR_LOGIN_ID).toBe("github-connector");
    expect(GITHUB_CONNECTOR_SECRET_REF).toBe("secret:app:github-connector");
  });

  it("requests the base scopes and adds workflow only on opt-in", () => {
    expect(githubConnectorScopes(false)).toEqual(["repo", "read:org"]);
    expect(githubConnectorScopes(true)).toEqual(["repo", "read:org", "workflow"]);
  });

  it("returns a fresh scope list each time", () => {
    const first = githubConnectorScopes(false);
    first.push("admin:org");
    expect(githubConnectorScopes(false)).toEqual(["repo", "read:org"]);
  });

  it("accepts a token with no whitespace or control characters", () => {
    expect(isGitHubTokenShape("gho_abc123")).toBe(true);
    expect(isGitHubTokenShape("github_pat_11ABCDEFG0_abcdef")).toBe(true);
    expect(isGitHubTokenShape("a".repeat(4096))).toBe(true);
  });

  it("rejects empty, spaced, multi-line, control-character, and oversized tokens", () => {
    expect(isGitHubTokenShape("")).toBe(false);
    expect(isGitHubTokenShape("a b")).toBe(false);
    expect(isGitHubTokenShape("a\nb")).toBe(false);
    expect(isGitHubTokenShape("a\tb")).toBe(false);
    expect(isGitHubTokenShape("a\u0000b")).toBe(false);
    expect(isGitHubTokenShape("a\u007fb")).toBe(false);
    expect(isGitHubTokenShape("a b")).toBe(false);
    expect(isGitHubTokenShape(" gho_abc123")).toBe(false);
    expect(isGitHubTokenShape("a".repeat(4097))).toBe(false);
    expect(isGitHubTokenShape(undefined as unknown as string)).toBe(false);
  });

  it("rejects anything outside printable ASCII, which could not be sent in a header", () => {
    // A header value is bytes; a pasted smart quote or accented letter would
    // fail at the transport and read as a network problem instead of a typo.
    expect(isGitHubTokenShape("gho_abc\u00e9123")).toBe(false);
    expect(isGitHubTokenShape("gho_abc\u2019123")).toBe(false);
    expect(isGitHubTokenShape("gho_\u4ee4\u724c")).toBe(false);
    expect(isGitHubTokenShape("gho_\ud83d\ude00")).toBe(false);
    expect(isGitHubTokenShape("gho_abc\u200b123")).toBe(false);
    expect(isGitHubTokenShape("gho_abc\u0080")).toBe(false);
    // Every printable ASCII character stays acceptable.
    let printable = "";
    for (let code = 0x21; code <= 0x7e; code += 1) printable += String.fromCharCode(code);
    expect(isGitHubTokenShape(printable)).toBe(true);
  });

  it("registers the connector error codes", () => {
    const codes = [
      "GITHUB_NOT_CONNECTED",
      "GITHUB_AUTH_FAILED",
      "GITHUB_FORBIDDEN",
      "GITHUB_NOT_FOUND",
      "GITHUB_RATE_LIMITED",
      "GITHUB_NETWORK",
      "GITHUB_INVALID_TOKEN",
      "GITHUB_DEVICE_FLOW_UNAVAILABLE",
      "GITHUB_LOGIN_EXPIRED",
      "GITHUB_LOGIN_DENIED",
      "GITHUB_VALIDATION_FAILED",
    ] as const;
    for (const code of codes) {
      expect(ErrorCodes[code]).toBe(code);
    }
  });
});
