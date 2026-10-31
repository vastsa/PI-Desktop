// Mounted production SettingsPage; only the preload boundary uses fixture data.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { initLanguageSync } from "../../apps/desktop/src/lib/app-language";

const destinations = ["A", "B"].map((id) => ({
  ref: `fixture:${id}`, pluginId: "fixture", label: `Themes ${id}`, keywords: [],
  description: "Fixture theme collection", themes: Array.from({ length: 12 }, (_, index) => ({
    themeId: `plugin:fixture:${id}${index}`, label: `Theme ${index}`, description: "Preview",
    previewUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", blur: 6,
  })),
}));
let settings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  enterToSend: true,
  developerMode: false,
  networkProxy: { mode: "custom", url: "socks5://10.0.0.8:1080" },
};
let updateState = {
  mode: "in-app",
  preference: "automatic",
  defaultPreference: "automatic",
  automaticSupported: true,
  manualReminder: false,
  status: "available",
  currentVersion: "0.15.8",
  availableVersion: "0.15.9",
  releasesUrl: "https://github.com/vastsa/PI-Desktop/releases/latest",
};
const updateStateListeners = new Set();
window.piDesktop = {
  platform: "darwin",
  on(channel, listener) {
    if (channel === IPC.event.updatesState) updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
  },
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations: data = destinations; break;
      case IPC.invoke.settingsGet: data = settings; break;
      case IPC.invoke.settingsSet:
        settings = input;
        data = settings;
        if (settings.updatePreference === "automatic" || settings.updatePreference === "manual") {
          updateState = {
            ...updateState,
            preference: settings.updatePreference,
            mode: settings.updatePreference === "automatic" ? "in-app" : "manual",
          };
          for (const listener of updateStateListeners) listener(updateState);
        }
        break;
      case IPC.invoke.providersList: data = { providers: [] }; break;
      case IPC.invoke.sessionList: data = { sessions: [] }; break;
      case IPC.invoke.appGetOnboarding: data = {}; break;
      case IPC.invoke.updatesGetState: data = updateState; break;
      case IPC.invoke.configSyncGetState:
        data = {
          configured: false,
          enabled: false,
          paused: false,
          locked: false,
          status: "notConfigured",
          remoteMode: "strict",
          categories: {},
          includeSecrets: false,
          includeMemory: false,
          automaticSync: false,
          pendingApprovals: [],
          mappings: [],
        };
        break;
      case IPC.invoke.commandShellList: data = { choices: [], effective: null }; break;
      default: throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(catalogs.en) },
    "pt-BR": { translation: flattenCatalog(catalogs["pt-BR"]) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) },
  },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings, settingsTab: "ai", page: "settings" });
initLanguageSync();
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<SettingsPage />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function assert(value, message) { if (!value) throw new Error(message); }
const pane = () => document.querySelector(".settings-content");
const navButton = (label) => [...document.querySelectorAll(".settings-nav-item")]
  .find((node) => node.querySelector(".settings-nav-label")?.textContent?.trim() === label);
async function select(label) {
  const button = navButton(label);
  assert(button, `Missing destination: ${label}`);
  flushSync(() => button.click());
  await settle();
}
async function setSettingsSearch(value) {
  const input = document.querySelector(".settings-search");
  assert(input instanceof HTMLInputElement, "Settings search input must be rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Settings search input must expose its value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
async function checkCloudSyncVisibility() {
  // The isolated renderer is a development build; packaged-build visibility is
  // asserted by settings-developer-only-destinations.test.mjs.
  await setSettingsSearch("Cloud sync");
  const syncButton = navButton("Cloud sync");
  assert(syncButton, "Cloud sync must appear in Settings search");
  assert(
    syncButton.querySelector(".settings-nav-experimental")?.textContent?.trim() === "Experimental",
    "Cloud sync's rail entry must carry the Experimental badge",
  );

  flushSync(() => syncButton.click());
  await settle();
  assert(useAppStore.getState().settingsTab === "sync", "Cloud sync must open its page");
  assert(
    document.querySelector(".settings-section-title")?.textContent?.includes("Experimental"),
    "Cloud sync's page title must carry the Experimental badge",
  );
  await setSettingsSearch("");

  // Developer mode does not gate Cloud sync or Remote Hosts.
  settings = { ...settings, developerMode: true };
  flushSync(() => useAppStore.setState({ settings }));
  await settle();
  assert(navButton("Cloud sync"), "Cloud sync must stay in the rail with developer mode on");
  settings = { ...settings, developerMode: false };
  flushSync(() => useAppStore.setState({ settings }));
  await settle();
  assert(useAppStore.getState().settingsTab === "sync", "Cloud sync must stay selected");
  assert(navButton("Cloud sync"), "Cloud sync must stay in the rail without developer mode");

  await setSettingsSearch("Remote hosts");
  const remoteButton = navButton("Remote hosts");
  assert(remoteButton, "Remote hosts must appear in Settings search");
  assert(
    remoteButton.querySelector(".settings-nav-experimental")?.textContent?.trim() === "Experimental",
    "Remote hosts must carry the Experimental badge",
  );
  flushSync(() => remoteButton.click());
  await settle();
  assert(useAppStore.getState().settingsTab === "remoteHosts", "Remote hosts must open");
  assert(
    document.querySelector(".settings-section-title")?.textContent?.includes("Experimental"),
    "Remote hosts page title must carry the Experimental badge",
  );
  await setSettingsSearch("");

  for (const developerMode of [true, false]) {
    settings = { ...settings, developerMode };
    flushSync(() => useAppStore.setState({ settings }));
    await settle();
    assert(useAppStore.getState().settingsTab === "remoteHosts");
    assert(navButton("Remote hosts"), "Remote hosts must stay visible in every developer mode");
  }
}
async function scroll() {
  pane().scrollTop = 220;
  await settle();
  assert(pane().scrollTop > 0, "Destination must be scrollable for this check");
  return pane().scrollTop;
}
async function exerciseUpdatePreference() {
  await select("Info");
  await settle();
  const trigger = () => document.querySelector('button[aria-label="Update behavior"]');
  assert(trigger() instanceof HTMLButtonElement, "Update behavior selector must render");
  assert(trigger().textContent?.includes("Automatic"), "Installed package defaults to Automatic");
  const updateActionLabels = [...document.querySelectorAll(".about-update-actions button")]
    .map((button) => button.textContent?.trim() ?? "");
  assert(
    updateActionLabels.some((label) => label.includes("Check for updates")),
    `Automatic mode keeps the existing update check action: ${updateActionLabels.join(", ")}`,
  );

  async function choosePreference(label, value) {
    const selectTrigger = trigger();
    assert(selectTrigger instanceof HTMLButtonElement, "Update selector trigger must remain mounted");
    flushSync(() => selectTrigger.click());
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert(option instanceof HTMLButtonElement, `Missing update preference option: ${label}`);
    flushSync(() => option.click());
    await settle();
    assert(settings.updatePreference === value, `${label} preference must persist through settings IPC`);
    assert(useAppStore.getState().settings?.updatePreference === value, `${label} preference must update the renderer store`);
    assert(updateState.preference === value, `${label} preference must update the shared update state`);
  }

  await choosePreference("Manual", "manual");
  assert(trigger().textContent?.includes("Manual"), "Manual must become the selected value");
  assert(
    [...document.querySelectorAll(".about-update-actions button")]
      .some((button) => button.textContent?.includes("View release")),
    "Manual mode must offer the release page for an available version",
  );

  await select("AI");
  await select("Info");
  await settle();
  assert(trigger().textContent?.includes("Manual"), "Manual preference must survive leaving and reopening Info");
  await choosePreference("Automatic", "automatic");
  assert(trigger().textContent?.includes("Automatic"), "Automatic must be selectable again");
  return { updatePreference: settings.updatePreference, updateMode: updateState.mode };
}

async function exerciseBrazilianPortuguese() {
  await select("General");
  const trigger = document.querySelector(".settings-language-trigger");
  assert(trigger instanceof HTMLButtonElement, "Language picker trigger must render");
  flushSync(() => trigger.click());
  await settle();

  const search = document.querySelector(".settings-language-search input");
  assert(search instanceof HTMLInputElement, "Language picker search must render");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Language search input must expose its value setter");
  setter.call(search, "Português (Brasil)");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();

  const option = [...document.querySelectorAll(".settings-language-option")]
    .find((candidate) => candidate.textContent?.includes("Português (Brasil)"));
  assert(option instanceof HTMLButtonElement, "Brazilian Portuguese must be searchable");
  const languageChanged = new Promise((resolve) => i18n.once("languageChanged", resolve));
  flushSync(() => option.click());
  await languageChanged;
  await settle();

  assert(settings.language === "pt-BR", "Choosing Portuguese must persist pt-BR");
  assert(useAppStore.getState().settings?.language === "pt-BR", "App settings must retain pt-BR");
  assert(document.documentElement.lang === "pt-BR", "Document language must update to pt-BR");
  assert(navButton("Geral"), "Settings navigation must switch to Brazilian Portuguese");
  assert(!navButton("General"), "English navigation must be replaced after switching locales");
  const languageTitle = [...document.querySelectorAll(".settings-row-title")]
    .find((node) => node.textContent?.trim() === "Idioma");
  assert(languageTitle, "The language setting label must be translated");
  const selectedLabel = document.querySelector(".settings-language-trigger-label");
  assert(selectedLabel?.textContent?.trim() === "Português (Brasil)", "Picker must show the selected native name");
  return { locale: i18n.language, language: settings.language, label: selectedLabel.textContent.trim() };
}
async function exerciseProxyDraftRestoration() {
  await select("General");
  const urlInput = () => document.querySelector('input[aria-label="Proxy URL"]');
  const input = urlInput();
  assert(input instanceof HTMLInputElement, "Custom proxy URL field must render");
  const rememberedUrl = settings.networkProxy.url;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Proxy URL input must expose its value setter");
  setter.call(input, "not-a-proxy");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  urlInput().blur();
  await settle();
  assert(settings.networkProxy.url === rememberedUrl, "An invalid draft must not overwrite the saved proxy");

  const chooseMode = async (label) => {
    const group = document.querySelector('.settings-segment[aria-label="Proxy"]');
    assert(group, "Proxy mode control must render");
    const option = [...group.querySelectorAll('[role="radio"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert(option instanceof HTMLButtonElement, `Missing proxy mode: ${label}`);
    flushSync(() => option.click());
    await settle();
  };

  await chooseMode("System");
  assert(settings.networkProxy.mode === "system", "System mode must persist");
  assert(settings.networkProxy.url === rememberedUrl, "System mode must retain the remembered proxy");
  await chooseMode("Custom");
  assert(settings.networkProxy.mode === "custom", "Custom mode must persist on re-entry");
  assert(urlInput()?.value === rememberedUrl, "Re-entering Custom must restore the remembered URL");
  assert(settings.networkProxy.url === rememberedUrl, "Re-entry must not replace the saved URL with the default");
  return { proxyMode: settings.networkProxy.mode, proxyUrl: settings.networkProxy.url };
}
window.settingsScrollProbe = async () => {
  await settle();
  assert(
    document.activeElement === document.querySelector(".settings-search"),
    "Mounting Settings must move focus to its search control",
  );
  const checks = [];
  checks.push(await exerciseProxyDraftRestoration());
  await checkCloudSyncVisibility();
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await select("AI");
    const position = await scroll();
    await select("AI");
    assert(pane().scrollTop === position, "Re-selecting AI must retain scroll");
    flushSync(() => useAppStore.setState({ settings: { ...settings, enterToSend: false } }));
    await settle();
    assert(pane().scrollTop === position, "Settings updates must retain scroll");
    await select("Shortcuts");
    assert(pane().scrollTop === 0, "AI → Shortcuts must start at top");
    await scroll();
    await select("AI");
    assert(pane().scrollTop === 0, "Returning to AI must start at top");
    await scroll();
    await select("Themes A");
    assert(pane().scrollTop === 0, "Built-in → extension must start at top");
    const extensionPosition = await scroll();
    await select("Themes A");
    assert(pane().scrollTop === extensionPosition, "Re-selecting extension must retain scroll");
    await select("Themes B");
    assert(pane().scrollTop === 0, "Extension → extension must start at top");
    await scroll();
    await select("AI");
    assert(pane().scrollTop === 0, "Extension → unchanged built-in tab must start at top");
    await select("Themes A");
    await scroll();
    flushSync(() => useAppStore.getState().setSettingsTab("shortcuts"));
    assert(!document.querySelector(".plugin-scenic-theme-card"), "External tab change must leave the plugin");
    assert(document.querySelector(".settings-section-title")?.textContent?.includes("Shortcuts"), "Shortcuts must replace the plugin");
    assert(pane().scrollTop === 0, "External tab change must start at the top");
    await select("Themes A");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    assert(!document.querySelector(".plugin-scenic-theme-card"), "Search must leave the plugin destination");
    const fromPlugin = document.querySelector(".settings-anchor-flash");
    assert(fromPlugin && pane().scrollTop > 0, "Search from a plugin must be positioned before paint");
    const fromPluginBounds = fromPlugin.getBoundingClientRect();
    const fromPluginViewport = pane().getBoundingClientRect();
    assert(fromPluginBounds.top >= fromPluginViewport.top && fromPluginBounds.bottom <= fromPluginViewport.bottom,
      "Search from a plugin must show the target");
    // The same public store entry points used by SearchDialog.openSettingsHit.
    await select("Shortcuts");
    await scroll();
    flushSync(() => {
      useAppStore.getState().setSettingsAnchor("settings.enterToSend");
      useAppStore.getState().setSettingsTab("ai");
    });
    const target = document.querySelector(".settings-anchor-flash");
    assert(target && pane().scrollTop > 0, "Search anchor must be positioned before paint");
    const bounds = target.getBoundingClientRect();
    const viewport = pane().getBoundingClientRect();
    assert(bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      "Search target must be visible");
    assert(useAppStore.getState().settingsAnchor === null, "Search anchor must be consumed");
    const anchoredPosition = pane().scrollTop;
    await settle();
    assert(pane().scrollTop === anchoredPosition, "Consuming anchor must not reset scroll");
    pane().scrollTop = 0;
    flushSync(() => useAppStore.getState().setSettingsAnchor("settings.enterToSend"));
    const withinTab = document.querySelector(".settings-anchor-flash");
    assert(withinTab && pane().scrollTop > 0, "Search within the active tab must be positioned before paint");
    await settle();
    assert(pane().scrollTop > 0, "Search within the active tab must still locate its row");
    checks.push({ theme, ok: true });
  }
  checks.push(await exerciseUpdatePreference());
  checks.push(await exerciseBrazilianPortuguese());
  return { ok: true, checks };
};

window.settingsSegmentProbe = async (language, fontScale) => {
  settings = { ...settings, language };
  flushSync(() => useAppStore.setState({ settings, settingsTab: "ai" }));
  await i18n.changeLanguage(language);
  document.documentElement.style.setProperty("--font-scale", String(fontScale));
  await settle();

  const group = [...document.querySelectorAll('[role="radiogroup"]')]
    .find((node) => node.getAttribute("aria-label") === i18n.t("settings.transcriptDisplayMode"));
  assert(group, "Transcript display selector must render in AI settings");
  const row = group.closest(".settings-row");
  const copy = row.querySelector(".settings-row-copy");
  const buttons = [...group.querySelectorAll('[role="radio"]')];
  assert(buttons.length === 3, "All transcript display choices must be visible");
  for (const button of buttons) {
    const text = document.createRange();
    text.selectNodeContents(button);
    const lines = new Set([...text.getClientRects()].map((rect) => Math.round(rect.top)));
    assert(lines.size === 1, `${language}/${innerWidth}/${fontScale}: ${button.textContent} must stay on one line`);
    assert(button.scrollWidth <= button.clientWidth + 1, "Option text must not be clipped");
  }
  const bounds = group.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  assert(bounds.left >= rowBounds.left && bounds.right <= rowBounds.right + 1,
    "Transcript display control must stay inside its row");
  assert(row.scrollWidth <= row.clientWidth + 1, "The row must not overflow horizontally");
  assert(copy.clientWidth > 0 && copy.scrollWidth <= copy.clientWidth + 1,
    "The setting title and help control must retain their space");
  if (innerWidth >= 1440) {
    assert(bounds.width > 240, "Long labels must grow beyond the old 240px control cap");
    assert(bounds.top < copy.getBoundingClientRect().bottom, "Wide rows must retain the inline title/control layout");
  }

  for (const [index, value] of ["flat", "command-first", "fully-folded"].entries()) {
    flushSync(() => buttons[index].click());
    await settle();
    assert(settings.transcriptDisplayMode === value, "The selected display mode must persist through settings IPC");
    assert(buttons[index].getAttribute("aria-checked") === "true", "The saved display mode must be visibly selected");
  }
  return { language, fontScale, width: innerWidth, controlWidth: bounds.width,
    optionRows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size };
};
