import { describe, expect, it } from "vitest";
import {
  assertFeedbackIssueUrl,
  buildBugReportUrl,
  formatFeedbackEnvironment,
  GITHUB_BUG_TEMPLATE,
  GITHUB_REPO,
  osLabelForFeedback,
} from "./github-feedback.js";

const sample = {
  version: "0.13.3",
  platform: "darwin",
  arch: "arm64",
  protocolVersion: 10,
  hostVersion: "0.13.3",
};

describe("GitHub feedback issue URL", () => {
  it("maps Electron platforms onto the bug-form OS options", () => {
    expect(osLabelForFeedback("darwin")).toBe("macOS");
    expect(osLabelForFeedback("win32")).toBe("Windows");
    expect(osLabelForFeedback("linux")).toBe("Linux");
    expect(osLabelForFeedback("freebsd")).toBe("Other");
  });

  it("builds a GitHub issue-form URL with version, OS, and environment filled in", () => {
    const url = new URL(buildBugReportUrl(sample));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe(`/${GITHUB_REPO}/issues/new`);
    expect(url.searchParams.get("template")).toBe(GITHUB_BUG_TEMPLATE);
    expect(url.searchParams.get("app-version")).toBe("0.13.3");
    expect(url.searchParams.get("os")).toBe("macOS");
    expect(url.searchParams.get("environment")).toBe(
      "PI-Desktop 0.13.3 · darwin arm64 · protocol 10 · host 0.13.3",
    );
  });

  it("treats a missing host version as unknown", () => {
    expect(
      formatFeedbackEnvironment({ ...sample, hostVersion: "  " }),
    ).toContain("host unknown");
  });

  it("rejects URLs that leave the allowlisted GitHub issue form", () => {
    expect(() => assertFeedbackIssueUrl(buildBugReportUrl(sample))).not.toThrow();
    expect(() =>
      assertFeedbackIssueUrl("https://evil.example/issues/new"),
    ).toThrow(/origin/);
    expect(() =>
      assertFeedbackIssueUrl(
        "https://github.com/vastsa/PI-Desktop/issues/new?template=feature_request.yml",
      ),
    ).toThrow(/template/);
  });
});
