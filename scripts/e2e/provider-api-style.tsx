import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { ProviderPublic, ProviderCreateInput, ProviderUpdateInput } from "@pi-desktop/shared";
import { ProviderSetupDialog, type ProviderSetupDialogProps } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { copyProviderConfiguration } from "../../apps/desktop/src/components/settings/provider-copy";
import { api } from "../../apps/desktop/src/lib/api";

declare global { var providerApiStyleProbe: () => Promise<unknown>; }
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const click = (element: HTMLElement | null) => {
    assert(element, "missing click target");
    flushSync(() => element!.click());
  };
  const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.textContent?.trim() === i18n.t(key))!;
  const select = () => host.querySelector<HTMLSelectElement>(".provider-setup-custom-auth-row select")!;
  const choose = (style: string) => {
    const element = select();
    flushSync(() => {
      element.value = style;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const results: string[] = [];
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      render();
      click(host.querySelector(".provider-service-trigger"));
      click(document.querySelector(".provider-service-option"));
      const options = [...select().options].map((option) => option.value);
      assert(JSON.stringify(options) === JSON.stringify([
        "chat_completions", "responses", "anthropic_messages", "google_generative_ai",
      ]), `${locale}: new custom form exposes an account format`);
      results.push(`${locale}:new-custom-options`);

      for (const style of ["openai_codex_responses", "pi_messages"]) {
        const original = fixture(style);
        const before = JSON.stringify(original);
        render({ provider: original });
        assert(select().value === style && select().selectedOptions[0].disabled,
          "legacy format must remain visible without being a new choice");
        assert(host.textContent?.includes(i18n.t("settings.apiStyleLegacyAccount")), "legacy explanation missing");
        assert(!button("settings.saveProvider").disabled, "legacy unchanged save blocked");
        click(button("settings.saveProvider")); await pause();
        const update = updates.at(-1)!;
        assert(update.apiStyle === style && update.name === original.name && update.baseUrl === original.baseUrl,
          "legacy edit changed protocol/name/URL through preset matching");
        assert(!("authKind" in update) && !("secretValue" in update), "legacy edit changed authentication");
        assert(update.models?.[0].alias === "Fixture alias", "legacy bindings changed");

        render({ provider: original });
        choose("responses");
        click(button("settings.saveProvider")); await pause();
        assert(updates.at(-1)?.apiStyle === "responses", "explicit legacy protocol change not saved");

        const draft = copyProviderConfiguration(original, "Copy fixture");
        render({ initialDraft: draft });
        assert(select().value === style, "copy silently converted protocol");
        assert(button("settings.saveProvider").disabled, "copy accepts account-only protocol");
        assert(host.textContent?.includes(i18n.t("settings.apiStyleChooseCustom")), "copy choice explanation missing");
        const discoveryCount = discoveries.length;
        await pause(650);
        assert(discoveries.length === discoveryCount, "unsupported copy triggered discovery");
        const createCount = creates.length;
        click(button("settings.saveProvider")); await pause();
        assert(creates.length === createCount, "blocked copy was saved");
        click(button("settings.cancel"));
        assert(closes > 0 && creates.length === createCount, "cancel saved a copy");

        render({ initialDraft: draft });
        choose("anthropic_messages");
        await pause(650);
        const discovery = discoveries.at(-1)!;
        assert(discovery.apiStyle === "anthropic_messages" && !discovery.providerId && !discovery.apiKey,
          "copy discovery reused source protocol or credentials");
        assert(!button("settings.saveProvider").disabled, "supported copy is blocked");
        click(button("settings.saveProvider")); await pause();
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
