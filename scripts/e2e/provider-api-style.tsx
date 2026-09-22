import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { ProviderPublic, ProviderCreateInput, ProviderUpdateInput } from "@pi-desktop/shared";
import { ProviderSetupDialog, type ProviderSetupDialogProps } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { API_STYLE_LABEL_KEYS, CUSTOM_PROVIDER_API_STYLES } from "../../apps/desktop/src/components/settings/provider-api-style";
import { copyProviderConfiguration } from "../../apps/desktop/src/components/settings/provider-copy";
import { api } from "../../apps/desktop/src/lib/api";

declare global { var providerApiStyleProbe: () => Promise<unknown>; }
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/* Anchored menus mount, position and reveal on animation frames, so wait for a
   frame instead of guessing a duration; the timeout keeps a throttled window
   from hanging the probe. */
const frame = () => new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 50);
  requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
});
const ACCOUNT_ONLY_STYLES = ["openai_codex_responses", "pi_messages"] as const;
type AccountOnlyStyle = (typeof ACCOUNT_ONLY_STYLES)[number];
const fixture = (apiStyle: string): ProviderPublic => ({
  id: "legacy", name: "Legacy custom", vendorKey: "custom", type: "openai_compatible",
  protocol: "openai_compatible", enabled: true, authKind: "api_key_and_base_url",
  apiStyle, baseUrl: "https://api.openai.com/v1", hasSecret: true,
  supportsReasoning: false, supportedThinkingLevels: ["off"], createdAt: "", updatedAt: "",
  models: [{ id: "fixture", alias: "Fixture alias", contextWindow: 32000, maxTokens: 4000,
    thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
});

globalThis.providerApiStyleProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: {
    en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] },
  }, interpolation: { escapeValue: false } });
  const creates: ProviderCreateInput[] = [];
  const updates: ProviderUpdateInput[] = [];
  const discoveries: Parameters<typeof api.listProviderModels>[0][] = [];
  // Only the API boundary is faked: render the production form/hooks and inspect
  // exact save payloads. This does not validate Host persistence or live OAuth.
  api.createProvider = async (input) => {
    creates.push(structuredClone(input));
    return { provider: { ...fixture(input.apiStyle!), ...input, id: "copy" } };
  };
  api.updateProvider = async (input) => {
    updates.push(structuredClone(input));
    return { provider: { ...fixture(input.apiStyle!), ...input } };
  };
  api.listProviderModels = async (input) => {
    discoveries.push(structuredClone(input));
    return { models: [], source: "remote" };
  };
  /* The root container only mounts React; every production surface under test
     renders itself through a portal, so all queries below are document-rooted. */
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let key = 0;
  let closes = 0;
  const render = (props: Partial<ProviderSetupDialogProps> = {}) => {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <ProviderSetupDialog key={++key} onClose={() => { closes++; }} onSaved={() => {}} {...props} />
    </I18nextProvider>));
  };
  const click = (element: HTMLElement | null | undefined) => {
    assert(element, "missing click target");
    flushSync(() => element!.click());
  };
  const button = (key: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.textContent?.trim() === i18n.t(key));
  const control = (key: string) => {
    const element = button(key);
    assert(element, `missing control ${key}`);
    return element;
  };
  /* A Field explains itself through the help icon's accessible name, so read the
     row's explanations from the affordance that carries them. */
  const rowHints = () => [...document.querySelectorAll<HTMLElement>(
    ".provider-setup-custom-auth-row .ui-help-icon")]
    .map((element) => element.getAttribute("aria-label") ?? "");
  const apiStyleLabel = (style: string) =>
    i18n.t(API_STYLE_LABEL_KEYS[style as keyof typeof API_STYLE_LABEL_KEYS]);
  const customLabels = () => CUSTOM_PROVIDER_API_STYLES.map(apiStyleLabel);

  /*
    The API format row is a SettingsMenuSelect: a trigger button that reports the
    current label, and options rendered by AnchoredMenu through a portal into
    document.body. Open the real control, read the real option list, and click
    the real option button.
  */
  const apiStyleTrigger = () => document.querySelector<HTMLButtonElement>(
    ".provider-setup-custom-auth-row .settings-menu-select-trigger");
  const apiStyleMenu = () => document.querySelector<HTMLElement>(".settings-menu-select-menu");
  const apiStyleOptions = () => [...(apiStyleMenu()?.querySelectorAll<HTMLButtonElement>(
    ".settings-menu-select-option") ?? [])];
  const optionLabel = (option: HTMLElement) =>
    option.querySelector(".settings-menu-select-option-label")?.textContent?.trim()
    ?? option.textContent?.trim() ?? "";
  const optionSnapshot = () => apiStyleOptions().map((option) => ({
    label: optionLabel(option),
    current: option.getAttribute("aria-selected") === "true",
    disabled: option.disabled,
  }));
  const openApiStyleMenu = async () => {
    const trigger = apiStyleTrigger();
    assert(trigger, "api style control missing");
    assert(trigger.getAttribute("aria-haspopup") === "listbox", "api style control is not a menu select");
    assert(!apiStyleMenu(), "api style menu was already open");
    // AnchoredMenu closes a menu whose anchor sits outside the viewport.
    trigger.scrollIntoView({ block: "center" });
    await frame();
    click(trigger);
    await frame();
    assert(apiStyleMenu(), "api style menu did not open");
    assert(trigger.getAttribute("aria-expanded") === "true", "api style menu did not report aria-expanded");
    return trigger;
  };
  const closeApiStyleMenu = async () => {
    const trigger = apiStyleTrigger();
    assert(trigger, "api style control missing");
    assert(apiStyleMenu(), "api style menu is not open");
    click(trigger);
    await frame();
    assert(!apiStyleMenu(), "api style menu stayed open");
  };
  const chooseApiStyle = async (style: string) => {
    await openApiStyleMenu();
    const option = apiStyleOptions().find((item) => optionLabel(item) === apiStyleLabel(style));
    assert(option, `${style}: api style option missing`);
    assert(!option.disabled, `${style}: api style option is disabled`);
    click(option);
    await frame();
    assert(!apiStyleMenu(), `${style}: api style menu stayed open after choosing`);
    assert(apiStyleTrigger()?.getAttribute("aria-expanded") === "false", `${style}: menu did not collapse`);
    assert(apiStyleTrigger()?.textContent?.trim() === apiStyleLabel(style), `${style}: choice did not reach the control`);
  };
  /* The legacy protocol stays listed, selected and unusable as a new choice. */
  const assertAccountOnlyOption = async (style: AccountOnlyStyle, context: string) => {
    assert(apiStyleTrigger()?.textContent?.trim() === apiStyleLabel(style), `${context}: shows the wrong format`);
    await openApiStyleMenu();
    const options = optionSnapshot();
    assert(options.length === CUSTOM_PROVIDER_API_STYLES.length + 1, `${context}: option list length`);
    assert(options[0]!.label === apiStyleLabel(style), `${context}: account format is not the first option`);
    assert(options[0]!.current, `${context}: account format is not the current selection`);
    assert(options[0]!.disabled, `${context}: account format must remain visible without being a new choice`);
    assert(JSON.stringify(options.slice(1).map((option) => option.label)) === JSON.stringify(customLabels()),
      `${context}: custom formats changed`);
    await closeApiStyleMenu();
  };

  const results: string[] = [];
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      render();
      const serviceTrigger = document.querySelector<HTMLButtonElement>(".provider-service-trigger");
      assert(serviceTrigger, "service picker trigger missing");
      serviceTrigger.scrollIntoView({ block: "center" });
      await frame();
      click(serviceTrigger);
      click(document.querySelector(".provider-service-option"));
      await frame();
      await openApiStyleMenu();
      const newCustomOptions = optionSnapshot();
      assert(JSON.stringify(newCustomOptions.map((option) => option.label)) === JSON.stringify(customLabels()),
        `${locale}: new custom form exposes an account format`);
      for (const style of ACCOUNT_ONLY_STYLES) {
        assert(!newCustomOptions.some((option) => option.label === apiStyleLabel(style)),
          `${locale}: new custom form offers the account format ${style}`);
      }
      await closeApiStyleMenu();
      results.push(`${locale}:new-custom-options`);

      for (const style of ACCOUNT_ONLY_STYLES) {
        const original = fixture(style);
        const before = JSON.stringify(original);
        render({ provider: original });
        await assertAccountOnlyOption(style, `${locale}:${style}:edit`);
        assert(rowHints().includes(i18n.t("settings.apiStyleLegacyAccount")), "legacy explanation missing");
        assert(!control("settings.saveProvider").disabled, "legacy unchanged save blocked");
        click(control("settings.saveProvider")); await pause();
        const update = updates.at(-1)!;
        assert(update.apiStyle === style && update.name === original.name && update.baseUrl === original.baseUrl,
          "legacy edit changed protocol/name/URL through preset matching");
        assert(!("authKind" in update) && !("secretValue" in update), "legacy edit changed authentication");
        assert(update.models?.[0].alias === "Fixture alias", "legacy bindings changed");

        render({ provider: original });
        await chooseApiStyle("responses");
        click(control("settings.saveProvider")); await pause();
        assert(updates.at(-1)?.apiStyle === "responses", "explicit legacy protocol change not saved");

        const draft = copyProviderConfiguration(original, "Copy fixture");
        render({ initialDraft: draft });
        await assertAccountOnlyOption(style, `${locale}:${style}:copy`);
        assert(control("settings.saveProvider").disabled, "copy accepts account-only protocol");
        assert(rowHints().includes(i18n.t("settings.apiStyleChooseCustom")), "copy choice explanation missing");
        const discoveryCount = discoveries.length;
        await pause(650);
        assert(discoveries.length === discoveryCount, "unsupported copy triggered discovery");
        const createCount = creates.length;
        click(control("settings.saveProvider")); await pause();
        assert(creates.length === createCount, "blocked copy was saved");
        click(control("settings.cancel"));
        assert(closes > 0 && creates.length === createCount, "cancel saved a copy");

        render({ initialDraft: draft });
        await chooseApiStyle("anthropic_messages");
        await pause(650);
        const discovery = discoveries.at(-1)!;
        assert(discovery.apiStyle === "anthropic_messages" && !discovery.providerId && !discovery.apiKey,
          "copy discovery reused source protocol or credentials");
        assert(!control("settings.saveProvider").disabled, "supported copy is blocked");
        click(control("settings.saveProvider")); await pause();
        const created = creates.at(-1)!;
        assert(created.apiStyle === "anthropic_messages" && created.authKind === "api_key_and_base_url",
          "copy did not persist the explicitly chosen protocol");
        assert(!created.secretValue && !("id" in created), "copy retained source identity or credential");
        assert(JSON.stringify(original) === before, "edit/copy mutated source object");
        results.push(`${locale}:${style}:edit-change-copy-cancel`);
      }
    }
    return { ok: true, scenarios: results, creates: creates.length, updates: updates.length,
      apiBoundary: "stubbed", hostPersistence: "not exercised", liveModel: "not exercised" };
  } finally { flushSync(() => root.unmount()); host.remove(); }
};
