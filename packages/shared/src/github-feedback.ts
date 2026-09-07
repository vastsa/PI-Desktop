export const GITHUB_REPO = "vastsa/PI-Desktop";
export const GITHUB_BUG_TEMPLATE = "bug_report.yml";
export const GITHUB_ISSUE_ORIGIN = "https://github.com";

export type FeedbackIssueContext = {
  version: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  hostVersion?: string;
};

export type FeedbackOsLabel = "macOS" | "Windows" | "Linux" | "Other";

export function osLabelForFeedback(platform: string): FeedbackOsLabel {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Other";
  }
}

export function formatFeedbackEnvironment(info: FeedbackIssueContext): string {
  const host = info.hostVersion?.trim() || "unknown";
  return `PI-Desktop ${info.version} · ${info.platform} ${info.arch} · protocol ${info.protocolVersion} · host ${host}`;
}

export function buildBugReportUrl(info: FeedbackIssueContext): string {
  const url = new URL(`${GITHUB_ISSUE_ORIGIN}/${GITHUB_REPO}/issues/new`);
  url.searchParams.set("template", GITHUB_BUG_TEMPLATE);
  url.searchParams.set("app-version", info.version);
  url.searchParams.set("os", osLabelForFeedback(info.platform));
  url.searchParams.set("environment", formatFeedbackEnvironment(info));
  return url.toString();
}

export function assertFeedbackIssueUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid feedback URL");
  }
  if (parsed.origin !== GITHUB_ISSUE_ORIGIN) {
    throw new Error("invalid feedback URL origin");
  }
  if (parsed.pathname !== `/${GITHUB_REPO}/issues/new`) {
    throw new Error("invalid feedback URL path");
  }
  if (parsed.searchParams.get("template") !== GITHUB_BUG_TEMPLATE) {
    throw new Error("invalid feedback URL template");
  }
}
