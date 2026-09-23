import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { PermissionCard } from "permission-card-under-test";
import { useAppStore } from "permission-store-under-test";
import { api } from "permission-api-under-test";
import { SessionPermissionGrants } from "../../apps/desktop/src/features/chat/composer/SessionPermissionGrants";
import { PermissionReviewRows } from "../../apps/desktop/src/features/settings/PermissionReviewRows";
import { MAX_PERMISSION_REVIEW_POLICY_CHARS, type AppSettings } from "@pi-desktop/shared";
import "permission-tokens-under-test";
import "permission-base-under-test";
import "permission-styles-under-test";
import "permission-ui-kit-under-test";

// esbuild aliases point both imports at the same actual source checkout.
const i18n = createInstance();
document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.platform = "win32";
const container = document.createElement("main");
container.style.cssText = "max-width:760px;margin:70px auto;font:14px system-ui;";
document.body.style.cssText = "margin:0;background:var(--ds-bg-app,#171717);color:var(--ds-text-primary,#eee);";
document.body.append(container);
const root = createRoot(container);
let decisions: string[] = [];
let takeovers: string[] = [];
const painted = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

declare global {
  var renderPermissionFixture: (locale: string, state?: "user" | "reviewing") => Promise<void>;
  var verifyPermissionFixture: () => Promise<{ locale: string; decisions: string[] }>;
  var verifyReviewTakeoverFixture: () => Promise<{ locale: string; takeovers: string[] }>;
  var verifyGrantSwitchFixture: () => Promise<{ locale: string; revoked: string[] }>;
  var verifyReviewPolicySettingsFixture: () => Promise<{ locale: string; checks: string[] }>;
}

globalThis.renderPermissionFixture = async (locale, state = "user") => {
  if (!i18n.isInitialized) await i18n.init({
    lng: locale,
    resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  else await i18n.changeLanguage(locale);
  decisions = [];
  takeovers = [];
  api.takeoverPermissionReview = async (requestId: string) => { takeovers.push(requestId); return { ok: true }; };
  useAppStore.setState({ resolvePermission: async (_session: string, _request: string, decision: string) => {
    decisions.push(decision);
  } });
  flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <PermissionCard key={`${locale}-${state}`} permission={{
      requestId: "fixture-request", sessionId: "fixture-session", toolCallId: "fixture-call",
      toolName: "Bash", risk: "high", reason: "Inspect the current working tree",
      argsPreview: { command: "git status --short" }, receivedAt: Date.now(),
      reviewState: state,
      scopeLabel: "Bash [powershell]: git status --short",
    }} />
    <textarea className="composer-input" aria-label="Message" style={{ marginTop: 24, width: "100%" }} />
  </I18nextProvider>));
  await painted();
};

globalThis.verifyReviewTakeoverFixture = async () => {
  const status = container.querySelector('[role="status"]');
  if (status?.textContent !== i18n.t("permission.reviewing")) throw new Error("Review status is not visible");
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  const takeover = buttons.find((button) => button.textContent?.trim() === i18n.t("permission.takeOver"));
  if (!takeover || takeover.disabled) throw new Error("Manual takeover must be reachable");
  const allow = buttons.find((button) => button.textContent?.trim() === i18n.t("permission.allowOnce"));
  if (allow && !allow.disabled) throw new Error("Reviewing must not offer an unclaimed manual approval");
  takeover.click();
  await painted();
  if (takeovers.join() !== "fixture-request" || decisions.length) throw new Error("Takeover must target only the current request");
  return { locale: i18n.language, takeovers };
};

globalThis.verifyPermissionFixture = async () => {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  const allow = buttons.find((button) => button.textContent?.trim() === i18n.t("permission.allowOnce"));
  if (!allow || allow.disabled) throw new Error("Allow once must be reachable");
  const rect = allow.getBoundingClientRect();
  if (rect.width <= 0 || rect.left < 0 || rect.right > innerWidth) throw new Error("Approval button is clipped");
  allow.click();
  await painted();
  if (decisions.join() !== "allow-once") throw new Error("Approval did not reach the permission action exactly once");
  const deadline = performance.now() + 2000;
  while (document.activeElement?.className !== "composer-input" && performance.now() < deadline) await painted();
  if (document.activeElement?.className !== "composer-input") throw new Error("Composer focus was not restored");
  return { locale: i18n.language, decisions };
};

globalThis.verifyGrantSwitchFixture = async () => {
  const revoked: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const grantsFor = (sessionId: string) => [{
    id: `grant-${sessionId}`, sessionId, actorId: "agent", toolName: "Write",
    scope: "path" as const, label: `Write: ${sessionId}.txt`,
  }];
  api.listSessionPermissionGrants = async (sessionId: string) => ({ grants: grantsFor(sessionId) });
  api.revokeSessionPermissionGrant = async (sessionId: string, grantId: string) => {
    revoked.push(`${sessionId}:${grantId}`);
    if (sessionId === "first") await new Promise<void>((done) => { releaseFirst = done; });
    return { ok: true };
  };
  const render = async (sessionId: string) => {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <SessionPermissionGrants sessionId={sessionId} open />
    </I18nextProvider>));
    await painted();
  };
  const revokeButton = (sessionId: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label")?.includes(`${sessionId}.txt`));
  const waitForGrant = async (sessionId: string) => {
    const deadline = performance.now() + 2000;
    while (!revokeButton(sessionId) && performance.now() < deadline) await painted();
    const button = revokeButton(sessionId);
    if (!button || button.disabled) throw new Error(`Grant is not actionable: ${container.innerText}`);
    return button;
  };
  await render("first");
  const first = await waitForGrant("first");
  first.click();
  await painted();
  if (!releaseFirst) throw new Error("Revoke did not start at the real API boundary");
  await render("second");
  await waitForGrant("second");
  releaseFirst();
  await painted();
  const second = revokeButton("second");
  if (revokeButton("first") || !second || second.disabled) {
    throw new Error("A late revoke response replaced or disabled the new session's grants");
  }
  second.click();
  await painted();
  if (revoked.join() !== "first:grant-first,second:grant-second") {
    throw new Error("Grant revocation crossed session identities");
  }
  return { locale: i18n.language, revoked };
};

globalThis.verifyReviewPolicySettingsFixture = async () => {
  await i18n.changeLanguage("en");
  let settings: AppSettings = {
    defaultMode: "agent", theme: "system", enterToSend: true,
    onboardingDismissed: true, approvalReviewer: "user",
  };
  let saveMode: "succeed" | "fail" | "defer" = "succeed";
  let finishSave: (() => void) | undefined;
  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (saveMode === "fail") throw new Error("Fixture save failure");
    if (saveMode === "defer") await new Promise<void>((done) => { finishSave = done; });
    settings = { ...settings, ...patch };
    render();
  };
  const render = () => {
    useAppStore.setState({ settings });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <section className="settings-panel">
        <PermissionReviewRows settings={settings} providers={[]} saveSettings={saveSettings} />
      </section>
    </I18nextProvider>));
  };
  const editor = () => container.querySelector<HTMLTextAreaElement>("#permission-review-policy-draft")!;
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline) await painted();
    if (!predicate()) throw new Error(`Policy settings: ${label}`);
  };
  const edit = async (value: string) => {
    const element = editor();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => editor().value === value, "editor must reflect input");
  };
  render();
  if (editor().value !== "" || !editor().placeholder.includes("default policy") ||
      container.querySelector(".permission-review-policy button, .permission-review-policy summary, .permission-review-policy .settings-row-detail")) {
    throw new Error("Custom policy must be a visible blank input without extra controls");
  }

  // A pristine editor follows a new stored policy; an unsaved editor does not.
  settings = { ...settings, autoReview: { policyPrompt: "External update" } };
  render();
  await until(() => editor().value === "External update", "pristine draft must follow settings");
  await edit("My unsaved change");
  settings = { ...settings, autoReview: { policyPrompt: "Another external update" } };
  render();
  await painted();
  if (editor().value !== "My unsaved change") throw new Error("External refresh erased dirty draft");

  await edit("   ");
  await until(() => settings.autoReview?.policyPrompt === undefined && editor().value === "",
    "blank input must restore the built-in policy automatically");
  await edit("x".repeat(MAX_PERMISSION_REVIEW_POLICY_CHARS + 1));
  if (editor().getAttribute("aria-invalid") !== "true" ||
      !container.querySelector(".permission-review-policy [role=alert]")) {
    throw new Error("Over-limit policy must show an inline error");
  }

  const custom = "Allow only the explicitly requested fixture action.";
  saveMode = "defer";
  await edit(custom);
  await until(() => Boolean(finishSave), "save must reach the API boundary");
  const selectors = [...container.querySelectorAll<HTMLButtonElement>(".settings-menu-select-trigger")];
  if (selectors.length !== 3 || selectors.some((button) => !button.disabled) || editor().disabled) {
    throw new Error("Other reviewer controls must wait, while typing stays available");
  }
  await edit("A newer policy while saving.");
  saveMode = "succeed";
  finishSave!();
  await until(() => settings.autoReview?.policyPrompt === "A newer policy while saving.",
    "latest input must win after the first write settles");

  saveMode = "fail";
  await edit("Retry this policy");
  await until(() => Boolean(container.querySelector(".permission-review-policy [role=alert]")), "failed save must show error");
  if (editor().value !== "Retry this policy" || settings.autoReview?.policyPrompt !== "A newer policy while saving.") {
    throw new Error("Failed auto-save must retain the draft and previous saved value");
  }
  saveMode = "succeed";
  editor().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await until(() => settings.autoReview?.policyPrompt === "Retry this policy", "blur must retry auto-save");
  await edit("");
  await until(() => settings.autoReview?.policyPrompt === undefined && editor().value === "",
    "clearing input must restore default without a button");
  return { locale: i18n.language,
    checks: ["minimal blank editor", "pristine refresh", "dirty refresh", "blank restores default", "length validation", "queued latest input", "failure retry", "automatic restore"] };
};
