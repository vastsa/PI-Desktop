import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  WorkspaceGitCredentialSetSchema,
  WorkspaceGitJobRefSchema,
  WorkspaceGitListSchema,
  WorkspaceGitPrepareSchema,
  WorkspaceGitRemoveSchema,
  WorkspaceGitRepositoryRequestSchema,
  WorkspaceGitSessionRefSchema,
  isEnvironmentVariableName,
  isGitBranchName,
  isGitHubOwner,
  isGitHubRepositoryName,
} from "./racp-workspace-git.js";

const installationId = "00000000-0000-4000-8000-000000000000";

describe("isGitHubOwner", () => {
  // `mona_acme`: Enterprise Managed Users carry an underscore and a short code.
  it.each(["o", "octo-cat", "A1", "a".repeat(39), "mona_acme", "_a", "a_"])("accepts %j", (value) => {
    expect(isGitHubOwner(value)).toBe(true);
  });
  it.each(["-a", "a-", "", "a/b", "a".repeat(40), "a.b", "a b", "a\n", "..", "--upload-pack=x", "-", "a_-", "mona_acme/x"])("rejects %j", (value) => {
    expect(isGitHubOwner(value)).toBe(false);
  });
});

describe("isGitHubRepositoryName", () => {
  it.each(["r", "PI-Desktop", "repo.js", ".github", "a_b", "a".repeat(100)])("accepts %j", (value) => {
    expect(isGitHubRepositoryName(value)).toBe(true);
  });
  it.each([".", "..", "a/b", "repo.git", "--upload-pack=x", "", "a".repeat(101), "a b", "a\u0000b", "a\n"])("rejects %j", (value) => {
    expect(isGitHubRepositoryName(value)).toBe(false);
  });
});

describe("isGitBranchName", () => {
  // git's own reference-name rules, not an allowlist: GitHub lists branches
  // such as `fix/#123`, `release=1.0`, and non-ASCII names.
  it.each([
    "main", "feature/x-1", "release/1.2", "fix/#123", "release=1.0", "功能/登录",
    "user@fix", "a+b", "a,b", "a".repeat(244), "功".repeat(244), "a@", "@a", "a$b;c|d&e", "😀".repeat(244),
  ])("accepts %j", (value) => {
    expect(isGitBranchName(value)).toBe(true);
  });
  it.each([
    "-x", "/a", "a/", "a..b", "a//b", "a@{b", "a/.b", "a.lock", "a b", "a\u0000b",
    "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "@",
    "", "a.", "a".repeat(245), "功".repeat(245), "a~1", "a^", "a?", "a*", "a\n", "a\tb", "a\u007fb", "a\u001fb",
    "--upload-pack=x", "../../etc", "refs/heads/a.lock", "a\u2028..b", "a\ud800b",
  ])("rejects %j", (value) => {
    expect(isGitBranchName(value)).toBe(false);
  });

  it("agrees with the request schema for every name in both tables", () => {
    const base = { installationId, sessionId: "s", repository: { owner: "mona_acme", name: "r" } };
    for (const name of ["main", "fix/#123", "release=1.0", "功能/登录", "😀".repeat(244), "-x", "a..b", "a.lock", "@", "a b", "a\u2028..b", "a~b", "功".repeat(245), ""]) {
      expect(Value.Check(WorkspaceGitPrepareSchema, { ...base, baseBranch: name }), JSON.stringify(name)).toBe(isGitBranchName(name));
    }
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...base, baseBranch: "main", repository: { owner: "a-", name: "r" } })).toBe(false);
  });
});

describe("isEnvironmentVariableName", () => {
  it.each(["my_var", "A", "_x", "NODE_ENV", "A".repeat(128)])("accepts %j", (value) => {
    expect(isEnvironmentVariableName(value)).toBe(true);
  });
  it.each([
    "PATH", "GIT_DIR", "PI_PORT", "LD_PRELOAD", "1A", "A-B", "", "A".repeat(129), "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD",
    "IFS", "ENV", "BASH_ENV", "PROMPT_COMMAND", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "BASH_FUNC_x", "A=B", "A\n",
  ])("rejects %j", (value) => {
    expect(isEnvironmentVariableName(value)).toBe(false);
  });
});

describe("workspaceGit request schemas", () => {
  const good = { installationId, sessionId: "s", repository: { owner: "o", name: "r" }, baseBranch: "main" };

  it("rejects unknown fields and bad names at the schema boundary", () => {
    expect(Value.Check(WorkspaceGitPrepareSchema, good)).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, extra: 1 })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, baseBranch: "-x" })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, repository: { owner: "o", name: ".." } })).toBe(false);
  });

  it("accepts an optional bounded fromSessionId", () => {
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, fromSessionId: "parent" })).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, fromSessionId: "" })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, fromSessionId: "s".repeat(257) })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, fromSessionId: 1 })).toBe(false);
  });

  it("accepts an optional boolean rerunSetup", () => {
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, rerunSetup: true })).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, rerunSetup: false })).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, rerunSetup: "yes" })).toBe(false);
  });

  it("bounds the optional environment", () => {
    const variable = { name: "MY_VAR", value: "v" };
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [variable], setupScript: "pnpm i" } })).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [] } })).toBe(true);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: {} })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: Array.from({ length: 65 }, () => variable) } })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [{ name: "1A", value: "v" }] } })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [{ ...variable, value: "x".repeat(8193) }] } })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [{ ...variable, secret: true }] } })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [], setupScript: "x".repeat(65537) } })).toBe(false);
    expect(Value.Check(WorkspaceGitPrepareSchema, { ...good, environment: { variables: [], extra: 1 } })).toBe(false);
  });

  it("requires a UUID installation id and a bounded session id", () => {
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId, sessionId: "s" })).toBe(true);
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId: "not-a-uuid", sessionId: "s" })).toBe(false);
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId: `${installationId}\n`, sessionId: "s" })).toBe(false);
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId, sessionId: "" })).toBe(false);
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId, sessionId: "s".repeat(257) })).toBe(false);
    expect(Value.Check(WorkspaceGitSessionRefSchema, { installationId, sessionId: "s", path: "/tmp" })).toBe(false);
    expect(Value.Check(WorkspaceGitListSchema, { installationId })).toBe(true);
    expect(Value.Check(WorkspaceGitListSchema, {})).toBe(false);
    expect(Value.Check(WorkspaceGitListSchema, { installationId, sessionId: "s" })).toBe(false);
  });

  it("keeps the credential token bounded and free of control characters", () => {
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "gho_abcDEF123" })).toBe(true);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "" })).toBe(false);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "t".repeat(4097) })).toBe(false);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "a\r\nX-Injected: 1" })).toBe(false);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "a\u0000b" })).toBe(false);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "a\u007fb" })).toBe(false);
    expect(Value.Check(WorkspaceGitCredentialSetSchema, { installationId, token: "ok", extra: 1 })).toBe(false);
  });

  it("closes the repository, remove, and job reference requests", () => {
    expect(Value.Check(WorkspaceGitRepositoryRequestSchema, { repository: { owner: "o", name: "r" } })).toBe(true);
    expect(Value.Check(WorkspaceGitRepositoryRequestSchema, { repository: { owner: "-o", name: "r" } })).toBe(false);
    expect(Value.Check(WorkspaceGitRepositoryRequestSchema, { repository: { owner: "o", name: "r", host: "evil" } })).toBe(false);
    expect(Value.Check(WorkspaceGitRepositoryRequestSchema, { repository: { owner: "o", name: "a/b" } })).toBe(false);
    expect(Value.Check(WorkspaceGitRemoveSchema, { installationId, sessionId: "s", force: false })).toBe(true);
    expect(Value.Check(WorkspaceGitRemoveSchema, { installationId, sessionId: "s" })).toBe(false);
    expect(Value.Check(WorkspaceGitRemoveSchema, { installationId, sessionId: "s", force: "yes" })).toBe(false);
    expect(Value.Check(WorkspaceGitJobRefSchema, { jobId: "job-1" })).toBe(true);
    expect(Value.Check(WorkspaceGitJobRefSchema, { jobId: "" })).toBe(false);
    expect(Value.Check(WorkspaceGitJobRefSchema, { jobId: "j".repeat(65) })).toBe(false);
    expect(Value.Check(WorkspaceGitJobRefSchema, { jobId: "job-1", sessionId: "s" })).toBe(false);
  });
});
