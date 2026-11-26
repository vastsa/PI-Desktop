import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { flattenCatalog } from "@pi-desktop/i18n/locale-info";
import { en } from "@pi-desktop/i18n/locales/en";
import { IPC, type StarAiCatalog } from "@pi-desktop/shared";
import { StartupGuideDialog } from "../../src/features/startup/StartupGuideDialog";
import { starAiEn } from "../../src/locales/star-ai";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/tokens.css";
import "../../src/styles/ui-kit.css";
import "../../src/styles/settings.css";
import "../../src/styles/startup-overlays.css";
import "../../src/styles/service-setup.css";

let catalog: StarAiCatalog = { account: null, groups: [], selection: null };
const fastDescription = "实际倍率0.375-模型默认为Ultra fast 8倍计价8倍速度";
const grants = [
  { id: "gpt满血渠道", label: "gpt满血渠道", ratio: 0.25, chatModels: ["gpt-4o"], models: ["gpt-4o"] },
  { id: "gpt ultra fast", label: "gpt ultra fast", ratio: 3, description: fastDescription, chatModels: ["gpt-4o", "claude-sonnet"], models: ["gpt-4o", "claude-sonnet", "gpt-image-1"] },
  { id: "视频生成组", label: "视频生成组", chatModels: [], models: ["text-embedding-3-small", "gpt-image-1"] },
];
let failNextCatalog = false;
const calls: unknown[] = [];
const settings = { defaultProviderId: "", defaultModelId: "" };
Object.assign(window, { piDesktop: {
  channels: IPC,
  on: () => () => undefined,
  invoke: async (channel: string, input: { group: string; model: string }) => {
    switch (channel) {
      case IPC.invoke.starAiLogin:
        calls.push("login");
        catalog = { account: { id: 1, name: "Test account" }, groups: grants,
          selection: { group: grants[0].id, model: "gpt-4o", providerId: "starai-managed-base" } };
        Object.assign(settings, { defaultProviderId: "starai-managed-base", defaultModelId: "gpt-4o" });
        return { ok: true, data: catalog };
      case IPC.invoke.starAiCatalog:
        if (failNextCatalog) {
          failNextCatalog = false;
          return { ok: false, error: { code: "STARAI_UNAVAILABLE", message: "Marketplace unavailable" } };
        }
        return { ok: true, data: catalog };
      case IPC.invoke.starAiActivate: {
        calls.push(input);
        const selection = { ...input, providerId: `starai-managed-${input.group}` };
        catalog = { ...catalog, selection };
        Object.assign(settings, { defaultProviderId: selection.providerId, defaultModelId: input.model });
        catalog = { ...catalog, groups: [grants[1]] };
        return { ok: true, data: { ...selection, catalog } };
      }
      case IPC.invoke.starAiLogout:
        calls.push("logout");
        catalog = { account: null, groups: [], selection: null };
        Object.assign(settings, { defaultProviderId: "", defaultModelId: "" });
        return { ok: true, data: { ok: true } };
      case IPC.invoke.providersList: return { ok: true, data: { providers: [] } };
      case IPC.invoke.sessionList: return { ok: true, data: { sessions: [] } };
      case IPC.invoke.appGetOnboarding: return { ok: true, data: {} };
      case IPC.invoke.settingsGet: return { ok: true, data: { ...settings } };
      default: return { ok: false, error: { code: "UNAVAILABLE", message: "Unavailable in fixture" } };
    }
  },
} });

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = read();
    if (result) return result;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error("Control did not appear: " + read.toString());
}

async function click(selector: string, text?: string) {
  const button = await until(() => [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
    (entry) => !entry.disabled && (text == null || entry.innerText.trim() === text),
  ));
  button.click();
}

async function probe() {
  await i18n.use(initReactI18next).init({
    lng: "en", resources: { en: { translation: flattenCatalog(en), starAi: starAiEn } },
  });
  useAppStore.setState({ settings: { ...settings } as NonNullable<ReturnType<typeof useAppStore.getState>["settings"]> });
  createRoot(document.querySelector("#root")!).render(
    <StartupGuideDialog plan={{ audience: "new", steps: ["model", "launcher"] }}
      hasUsableModel={false} onExit={() => undefined} />,
  );
  await until(() => document.querySelector('[data-surface="startup-guide"][data-step="model"]'));
  await click("button", "Sign in to StarAI");
  await until(() => document.querySelector('button[aria-label="Model"]')?.textContent === "gpt-4o"
    && [...document.querySelectorAll(".settings-row-detail")].some((entry) => entry.textContent === "Current default"));
  if (document.querySelector('button[data-service="media"]')) {
    throw new Error("View-only media service card should not appear in model picker");
  }
  await click('button[data-service="gpt"]');
  await click('button[aria-label="Model group"]');
  if ([...document.querySelectorAll('[role="option"]')].some((entry) => entry.textContent?.includes("视频生成组"))) {
    throw new Error("GPT service contains a media group");
  }
  const fastOption = await until(() => [...document.querySelectorAll('[role="option"]')].find((entry) => entry.textContent === "gpt ultra fast · 3×"));
  const help = await until(() => fastOption.parentElement?.querySelector<HTMLButtonElement>(".ui-help-icon"));
  help.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  await until(() => document.querySelector('[role="tooltip"]')?.textContent === fastDescription);
  help.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: fastOption }));
  await until(() => !document.querySelector('[role="tooltip"]'));
  await click('[role="option"]', "gpt ultra fast · 3×");
  await click('button[aria-label="Model"]');
  if ([...document.querySelectorAll('button[role="option"]')].some((entry) => entry.textContent?.includes("gpt-image-1"))) {
    throw new Error("View-only image model should not appear in chat model selector");
  }
  const headings = [...document.querySelectorAll(".provider-service-group")].map((entry) => entry.textContent);
  if (headings.length !== 1 || headings[0] !== "gpt ultra fast") throw new Error("Model list is split by model name instead of site group");
  await click('[role="option"]', "gpt-4o");
  await until(() => settings.defaultProviderId === "starai-managed-gpt ultra fast" && settings.defaultModelId === "gpt-4o"
    && [...document.querySelectorAll(".settings-row-detail")].some((entry) => entry.textContent === "Current default"));
  if (document.querySelector('button[data-service="media"]')) throw new Error("Activation retained a removed group");
  failNextCatalog = true;
  await click('button[aria-label="Refresh groups and models"]');
  await until(() => document.querySelector('[role="alert"]') && !document.querySelector('button[data-service]'));
  await click('button[aria-label="Refresh groups and models"]');
  await until(() => document.querySelector('button[aria-label="Model"]')?.textContent === "gpt-4o");
  await click("button", "Sign out");
  await until(() => [...document.querySelectorAll("button")].some((entry) => !entry.disabled && entry.innerText === "Sign in to StarAI"));
  return calls;
}
Object.assign(window, { probe });
