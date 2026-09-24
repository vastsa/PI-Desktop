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
  api.updateProvider = async (input) => {
    const index = providers.findIndex((entry) => entry.id === input.id);
    const saved = { ...providers[index], models: structuredClone(input.models ?? providers[index].models) };
    providers[index] = saved;
    return { provider: saved };
  };
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
  const imageModelToggle = (label: string) =>
    [...document.querySelectorAll<HTMLInputElement>(
      ".provider-chosen-capability input[type=\"checkbox\"]",
    )].find((element) => element.getAttribute("aria-label") === label);
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      // The scenario precondition is "no image model configured", so each locale
      // pass starts unmarked instead of inheriting the candidates the previous
      // pass saved: a marked model's checkbox reads as selected, not "Set as
      // image model", which is what this pass looks for.
      settings = { ...settings, imageGeneration: null, imageGenerationModels: null };
      flushSync(() => useAppStore.setState({ settings }));
      render();
      const defaultRow = container.querySelector<HTMLElement>(".model-default-row")!;
      const initialImageRow = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
        (element) => element.textContent?.includes(i18n.t("settings.imageModel")),
      );
      assert(!initialImageRow, "unconfigured image model row should be hidden");
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
        () => !!imageModelToggle(i18n.t("settings.setImageModel")),
        "advanced image-model capability missing",
      );
      click(imageModelToggle(i18n.t("settings.setImageModel")));
      assert(!settings.imageGeneration, "draft selection persisted before Save");
      click(button(i18n.t("settings.cancel")));
      assert(!settings.imageGeneration, "cancel changed binding");
      click(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="' + i18n.t("settings.editProvider") + '"]',
        ),
      );
      await until(
        () => !!imageModelToggle(i18n.t("settings.setImageModel")),
        "second edit did not mount",
      );
      click(imageModelToggle(i18n.t("settings.setImageModel")));
      click(imageModelToggle(i18n.t("settings.setImageModel")));
      click(button(i18n.t("settings.saveProvider")));
      await until(
        () =>
          settings.imageGeneration?.modelId === "image-one" &&
          settings.imageGenerationModels?.length === 2 &&
          !document.querySelector(".provider-setup"),
        "saved image model candidates missing",
      );
      const imageRow = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
        (element) => element.textContent?.includes(i18n.t("settings.imageModel")),
      )!;
      assert(imageRow, "saved image model summary missing");
      assert(useAppStore.getState().toasts.at(-1)?.message === i18n.t("settings.providerUpdated"),
        "marking models should confirm the provider update");
      const gap = imageRow.getBoundingClientRect().top - defaultRow.getBoundingClientRect().bottom;
      assert(gap >= 11 && gap <= 13, `model defaults should be adjacent rows, got ${gap}px`);
      assert(settings.defaultModelId === "chat-model", "image model changed default chat model");
      click(container.querySelector<HTMLButtonElement>(".model-default-trigger"));
      await until(() => !!document.querySelector(".model-default-list"), "default picker missing");
      assert(!document.querySelector('[aria-label="Images · image-one"]'), "image binding leaked into chat defaults");
      assert(document.querySelector('[aria-label="Images B · image-one"]'), "same model on another provider disappeared");
      assert(!document.querySelector('[aria-label="Images · image-two"]'), "second image binding leaked into chat defaults");
      click(container.querySelector<HTMLButtonElement>(".model-default-trigger"));
      const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find((element) =>
        element.textContent?.includes(i18n.t("settings.imageModel")),
      )!;
      assert(row.querySelector('button[aria-haspopup="listbox"]'), "image summary selector missing");
      click(row.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]'));
      await until(
        () => !!document.querySelector('[role="option"]'),
        "image model candidate picker missing",
      );
      const secondImageOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (element) => element.textContent?.includes("image-two"),
      );
      click(secondImageOption);
      await until(
        () => settings.imageGeneration?.modelId === "image-two",
        "image default model did not switch",
      );
      const textStyle = (element: Element | null) => {
        assert(element, "missing model text");
        const style = getComputedStyle(element!);
        return [style.fontSize, style.fontWeight, style.fontFamily].join("|");
      };
      assert(textStyle(row.querySelector(".model-default-provider")) === textStyle(defaultRow.querySelector(".model-default-provider")), "provider typography differs from default model");
      assert(textStyle(row.querySelector(".model-default-model")) === textStyle(defaultRow.querySelector(".model-default-model")), "model typography differs from default model");
      const alternateRow = [...container.querySelectorAll<HTMLElement>(".model-provider-row")].find((element) => element.textContent?.includes("Images B"));
      click(alternateRow?.querySelector<HTMLButtonElement>('button[aria-label="' + i18n.t("settings.editProvider") + '"]'));
      await until(
        () => !!imageModelToggle(i18n.t("settings.setImageModel")),
        "alternate provider edit missing",
      );
      click(imageModelToggle(i18n.t("settings.setImageModel")));
      click(button(i18n.t("settings.saveProvider")));
      await until(
        () =>
          settings.imageGeneration?.modelId === "image-two" &&
          settings.imageGenerationModels?.length === 3 &&
          !document.querySelector(".provider-setup"),
        "additional image model candidate did not persist",
      );
      click(row.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]'));
      await until(() => !!document.querySelector('[role="option"]'), "image candidate picker did not reopen");
      const alternateImageOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (element) => element.textContent?.includes("Images B") && element.textContent?.includes("image-one"),
      );
      click(alternateImageOption);
      await until(
        () => settings.imageGeneration?.providerId === "q",
        "image default provider did not switch",
      );
      assert(settings.defaultProviderId === "chat" && settings.defaultModelId === "chat-model", "image switch changed chat default");
      assert(useAppStore.getState().toasts.at(-1)?.message === i18n.t("settings.imageModelSelected"),
        "explicit image default selection lost its specific confirmation");
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
      const unsetImageRow = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
        (element) => element.textContent?.includes(i18n.t("settings.imageModel")),
      );
      assert(unsetImageRow, "candidate image model row missing after clearing the default");
      assert(
        unsetImageRow.querySelector('[role="status"]')?.textContent === i18n.t("settings.imageModelUnset"),
        "cleared image default should expose the unset state",
      );

      // Issue #826: release the only chat model through the real edit/save path.
      providers.splice(0, providers.length, chatProvider);
      settings = {
        ...settings,
        imageGeneration: { providerId: "chat", modelId: "chat-model" },
        imageGenerationModels: [{ providerId: "chat", modelId: "chat-model" }],
      };
      flushSync(() => useAppStore.setState({ settings, providers: [...providers] }));
      const editOnlyProvider = () => click(container.querySelector<HTMLButtonElement>(
        'button[aria-label="' + i18n.t("settings.editProvider") + '"]',
      ));
      editOnlyProvider();
      await until(() => !!imageModelToggle(i18n.t("settings.imageModelSelected")), "selected image checkbox missing");
      click(imageModelToggle(i18n.t("settings.imageModelSelected")));
      click(button(i18n.t("settings.cancel")));
      assert(settings.imageGeneration?.modelId === "chat-model", "cancel cleared the image default");
      editOnlyProvider();
      await until(() => !!imageModelToggle(i18n.t("settings.imageModelSelected")), "selected checkbox did not reopen");
      click(imageModelToggle(i18n.t("settings.imageModelSelected")));
      click(button(i18n.t("settings.saveProvider")));
      await until(() => !document.querySelector(".provider-setup-dialog"), "unmark save did not finish");
      assert(useAppStore.getState().toasts.at(-1)?.message === i18n.t("settings.providerUpdated"),
        "unmark save incorrectly claims an image model was selected");
      assert(settings.imageGeneration === null, "unmark kept the old image default");
      assert(settings.imageGenerationModels?.length === 0, "unmark kept image candidates");
      // Remount settings from the saved API value, then reopen the provider.
      flushSync(() => root.render(null));
      flushSync(() => useAppStore.setState({ settings: structuredClone(settings) }));
      render();
      assert(!container.querySelector(".model-image-row"), "image summary returned after reopen");
      editOnlyProvider();
      await until(() => !!imageModelToggle(i18n.t("settings.setImageModel")), "unmarked checkbox did not persist");
      assert(!imageModelToggle(i18n.t("settings.setImageModel"))?.checked, "reopened model is still marked");
      click(button(i18n.t("settings.cancel")));
      click(container.querySelector<HTMLButtonElement>(".model-default-trigger"));
      await until(() => !!document.querySelector('[aria-label="Chat · chat-model"]'), "released chat model is missing");
      click(document.querySelector<HTMLButtonElement>('[aria-label="Chat · chat-model"]'));
      await until(() => !document.querySelector(".model-default-list"), "chat selection did not finish");
      assert(settings.defaultProviderId === "chat" && settings.defaultModelId === "chat-model", "released model cannot be the chat default");
      providers.splice(0, providers.length, provider, alternate, chatProvider);
      flushSync(() => useAppStore.setState({ providers: [...providers] }));

      // Removing a configured model is also an explicit release of its image
      // binding, even when the capability checkbox was never touched.
      for (const remaining of [false, true]) {
        providers.splice(0, providers.length, provider, alternate, chatProvider);
        const original = { providerId: "p", modelId: "image-one" };
        const other = { providerId: "q", modelId: "image-two" };
        settings = {
          ...settings,
          imageGeneration: original,
          imageGenerationModels: remaining ? [original, other] : undefined,
          defaultProviderId: remaining ? "chat" : "p",
          defaultModelId: remaining ? "chat-model" : "image-one",
        };
        flushSync(() => useAppStore.setState({ settings, providers: [...providers] }));
        const editImages = () => click(container.querySelector<HTMLButtonElement>(
          'button[aria-label="' + i18n.t("settings.editProvider") + '"]',
        ));
        const removeImage = async () => {
          await until(() => !!document.querySelector(".provider-chosen-row"), "chosen models missing");
          const chosen = [...document.querySelectorAll<HTMLElement>(".provider-chosen-row")]
            .find((element) => element.querySelector(".provider-chosen-row-id")?.textContent === "image-one");
          click(chosen?.querySelector<HTMLButtonElement>(".provider-chosen-remove"));
        };
        editImages();
        await removeImage();
        click(button(i18n.t("settings.cancel")));
        assert(settings.imageGeneration?.modelId === original.modelId, "cancel removed the image default");
        assert(providers[0].models.length === 2, "cancel persisted provider model removal");
        editImages();
        await removeImage();
        click(button(i18n.t("settings.saveProvider")));
        await until(() => !document.querySelector(".provider-setup-dialog"), "model removal save did not finish");
        assert(!providers[0].models.some((model) => model.id === "image-one"), "model was not removed");
        assert(settings.imageGeneration?.providerId === undefined,
          "removed provider model kept the image default");
        assert(settings.imageGenerationModels?.length === (remaining ? 1 : 0),
          "removed provider model kept an image candidate");
        assert(settings.defaultProviderId === (remaining ? "chat" : "p") &&
          settings.defaultModelId === (remaining ? "chat-model" : "image-two"),
          "model removal did not preserve the existing chat-default repair");
        flushSync(() => root.render(null));
        flushSync(() => useAppStore.setState({ settings: structuredClone(settings) }));
        render();
        assert(!!container.querySelector(".model-image-row") === remaining,
          "image summary did not reflect the saved candidates after reopen");
        editImages();
        await until(() => !!document.querySelector(".provider-chosen-row"), "saved provider did not reopen");
        assert(![...document.querySelectorAll(".provider-chosen-row-id")]
          .some((element) => element.textContent === "image-one"), "removed model returned after reopen");
        click(button(i18n.t("settings.cancel")));
      }
      providers.splice(0, providers.length, provider, alternate, chatProvider);
      flushSync(() => useAppStore.setState({ providers: [...providers] }));

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
        "provider-save-feedback-for-image-mark-and-unmark",
        "remove-marked-model-cancel-save-reopen-and-clear",
        "advanced-save-cancel",
        "unmark-only-image-model-save-reopen-chat-selection",
        "advanced-provider-switch",
        "read-only-summary-typography",
        "unconfigured-summary-hidden",
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
