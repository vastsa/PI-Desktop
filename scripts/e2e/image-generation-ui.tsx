import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { AppSettings, ProviderPublic, UiMessage } from "@pi-desktop/shared";
import { ModelConfigPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import { GeneratedImages } from "../../apps/desktop/src/features/chat/transcript/GeneratedImages";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/settings.css";
import "../../apps/desktop/src/styles/model-config.css";

declare global {
  var imageGenerationProbe: () => Promise<unknown>;
}
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 6000;
  while (!condition() && performance.now() < deadline) await painted();
  assert(condition(), message);
}

globalThis.imageGenerationProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  let settings = {
    defaultMode: "agent",
    defaultProviderId: "chat",
    defaultModelId: "chat-model",
    language: "en",
  } as AppSettings;
  const provider: ProviderPublic = {
    id: "p",
    name: "Images",
    baseUrl: "https://example.com/v1",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    apiStyle: "chat_completions",
    authKind: "api_key_and_base_url",
    enabled: true,
    hasSecret: true,
    supportsReasoning: false,
    supportedThinkingLevels: [],
    createdAt: "",
    updatedAt: "",
    models: ["image-one", "image-two"].map((id) => ({
      id,
      contextWindow: 32000,
      maxTokens: 4096,
      thinkingLevels: [],
      defaultThinkingLevel: null,
    })),
  };
  const alternate = { ...provider, id: "q", name: "Images B" };
  const chatProvider = { ...provider, id: "chat", name: "Chat", models: [{ ...provider.models[0], id: "chat-model" }] };
  const providers = [provider, alternate, chatProvider];
  api.getSettings = async () => structuredClone(settings);
  api.setSettings = async (next) => {
    settings = structuredClone(next);
    return { ok: true };
  };
  api.listProviders = async () => ({ providers });
  api.listSessions = async () => ({ sessions: [] });
  api.getOnboarding = async () => ({ dismissed: true });
  api.listProviderModels = async () => ({ models: [], source: "remote" });
  api.modelCatalogStatus = async () => ({
    loaded: true,
    source: "bundled",
    catalogPath: "",
    providerCount: 1,
    modelCount: 2,
  });
  api.updateProvider = async (input) => ({ provider: providers.find((entry) => entry.id === input.id)! });
  api.fsReadImageDataUrl = async () => ({
    kind: "image",
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  });
  useAppStore.setState({ settings, providers });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (message?: UiMessage) =>
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          {message ? <GeneratedImages message={message} /> : <ModelConfigPage />}
        </I18nextProvider>,
      ),
    );
  const click = (element: HTMLElement | undefined | null) => {
    assert(element, "missing click target");
    flushSync(() => element!.click());
  };
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === text,
    );
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      render();
      const defaultRow = container.querySelector<HTMLElement>(".model-default-row")!;
      const imageRow = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
        (element) => element.textContent?.includes(i18n.t("settings.imageModel")),
      )!;
      const gap = imageRow.getBoundingClientRect().top - defaultRow.getBoundingClientRect().bottom;
      assert(gap >= 11 && gap <= 13, `model defaults should be adjacent rows, got ${gap}px`);
      const edit =
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="' + i18n.t("settings.editProvider") + '"]',
        ) ??
        container.querySelector<HTMLButtonElement>(
          ".model-provider-row button[aria-label*='Edit']",
        );
      // Enter from the real model settings page, not the advanced pane alone.
      click(edit);
      await until(
        () => !!button(i18n.t("settings.setImageModel")),
        "advanced image-model action missing",
      );
      click(button(i18n.t("settings.setImageModel")));
      assert(!settings.imageGeneration, "draft selection persisted before Save");
      click(button(i18n.t("settings.cancel")));
      assert(!settings.imageGeneration, "cancel changed binding");
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="' + i18n.t("settings.editProvider") + '"]',
        ),
      );
      await until(() => !!button(i18n.t("settings.setImageModel")), "second edit did not mount");
      click(button(i18n.t("settings.setImageModel")));
      click(button(i18n.t("settings.saveProvider")));
      await until(
        () =>
          settings.imageGeneration?.modelId === "image-one" &&
          !document.querySelector(".provider-setup"),
        "saved image model missing",
      );
      assert(settings.defaultModelId === "chat-model", "image model changed default chat model");
      click(container.querySelector<HTMLButtonElement>(".model-default-trigger"));
      await until(() => !!document.querySelector(".model-default-list"), "default picker missing");
      assert(!document.querySelector('[aria-label="Images · image-one"]'), "image binding leaked into chat defaults");
      assert(document.querySelector('[aria-label="Images · image-two"]'), "other configured chat model disappeared");
      assert(document.querySelector('[aria-label="Images B · image-one"]'), "same model on another provider disappeared");
      click(container.querySelector<HTMLButtonElement>(".model-default-trigger"));
      const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find((element) =>
        element.textContent?.includes(i18n.t("settings.imageModel")),
      )!;
      assert(row.querySelectorAll("button").length === 0, "image summary still offers change or clear");
      const textStyle = (element: Element | null) => {
        assert(element, "missing model text");
        const style = getComputedStyle(element!);
        return [style.fontSize, style.fontWeight, style.fontFamily].join("|");
      };
      assert(textStyle(row.querySelector(".model-default-provider")) === textStyle(defaultRow.querySelector(".model-default-provider")), "provider typography differs from default model");
      assert(textStyle(row.querySelector(".model-default-model")) === textStyle(defaultRow.querySelector(".model-default-model")), "model typography differs from default model");
      const alternateRow = [...container.querySelectorAll<HTMLElement>(".model-provider-row")].find((element) => element.textContent?.includes("Images B"));
      click(alternateRow?.querySelector<HTMLButtonElement>('button[aria-label="' + i18n.t("settings.editProvider") + '"]'));
      await until(() => !!button(i18n.t("settings.setImageModel")), "alternate provider edit missing");
      click(button(i18n.t("settings.setImageModel")));
      click(button(i18n.t("settings.saveProvider")));
      await until(() => settings.imageGeneration?.providerId === "q" && !document.querySelector(".provider-setup"), "advanced provider switch did not persist");
      assert(settings.defaultProviderId === "chat" && settings.defaultModelId === "chat-model", "image switch changed chat default");
      assert(row.textContent?.includes("Images B"), "new provider name missing");
      for (const invalid of [
        { ...alternate, enabled: false },
        { ...alternate, hasSecret: false },
        { ...alternate, models: [] },
      ]) {
        flushSync(() => useAppStore.setState({ providers: [provider, invalid, chatProvider] }));
        assert(row.querySelector('[role="status"]')?.textContent === i18n.t("settings.imageModelUnavailable"), "unavailable state missing");
        assert(!row.querySelector(".model-default-provider"), "unavailable binding still displays provider");
      }
      settings = { ...settings, imageGeneration: null };
      flushSync(() => useAppStore.setState({ settings, providers }));
      assert(row.querySelector('[role="status"]')?.textContent === i18n.t("settings.imageModelUnavailable"), "unset state missing");

    }
    const message = {
      id: "image",
      role: "tool",
      content: "",
      createdAt: "",
      toolName: "GenerateImages",
      toolResult: {
        details: {
          kind: "generated-images",
          results: [
            { index: 0, status: "succeeded", path: "/scratch/result.png", mimeType: "image/png" },
            { index: 1, status: "failed", errorCode: "IMAGE_TIMEOUT" },
          ],
        },
      },
    } as UiMessage;
    render(message);
    await until(() => (container.querySelector("img")?.naturalWidth ?? 0) > 0, "generated preview did not decode");
    assert(container.textContent?.includes("IMAGE_TIMEOUT"), "partial failure missing");
    render({
      ...message,
      toolResult: {
        details: { kind: "image-generation-error", errorCode: "IMAGE_NOT_CONFIGURED" },
      },
    });
    click(button(i18n.t("settings.configureImageModel")));
    assert(
      useAppStore.getState().settingsTab === "agent" && useAppStore.getState().page === "settings",
      "setup action did not navigate",
    );
    const imageReads: string[] = [];
    const readImage = api.fsReadImageDataUrl;
    api.fsReadImageDataUrl = async (ref, mimeType) => {
      imageReads.push(ref);
      return readImage(ref, mimeType);
    };
    for (const ref of [String.raw`C:\scratch\cup.png`, "/tmp/scratch/cup.png"]) {
      flushSync(() => root.render(
        <I18nextProvider i18n={i18n}><Markdown source={`![Generated cup](${ref})`} /></I18nextProvider>,
      ));
      await until(() => (container.querySelector("img")?.naturalWidth ?? 0) > 0, "absolute generated image Markdown did not decode");
      await until(() => imageReads.includes(ref), `Markdown image did not use the contained host reader: ${JSON.stringify(imageReads)}`);
    }
    return {
      ok: true,
      locales: ["en", "zh-CN"],
      scenarios: [
        "advanced-save-cancel",
        "advanced-provider-switch",
        "read-only-summary-typography",
        "unavailable-summary",
        "chat-default-preserved",
        "image-excluded-from-chat-defaults",
        "image-preview-partial-failure",
        "setup-navigation",
        "absolute-image-markdown",
      ],
      apiBoundary: "fixture",
    };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
};
