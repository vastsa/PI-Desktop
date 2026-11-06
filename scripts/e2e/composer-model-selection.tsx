import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
const i18n = createInstance();
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModelInfo, ProviderPublic, SessionThinkingLevel } from "@pi-desktop/shared";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "./fixtures/composer-model-selection-store";

type MenuController = ReturnType<typeof useComposerModelMenu>;

declare global {
  var composerModelSelectionProbe: () => Promise<{
    model: string;
    switchedLevel: string;
    level: string;
    writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }>;
  }>;
  var composerModelSelectionController: MenuController | undefined;
}

const provider: ProviderPublic = {
  id: "fixture-provider",
  name: "Fixture provider",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  authKind: "none",
  hasSecret: false,
  models: [
    { id: "model-c", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-d", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-a", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
    { id: "model-b", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
  ],
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "high"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const models: ModelInfo[] = ["model-a", "model-b"].map((modelId) => ({
  modelId,
  displayName: modelId === "model-a" ? "Model A" : "Model B",
  providerId: provider.id,
  reasoning: true,
  supportedThinkingLevels: ["low", "high"],
  capabilities: ["text", "reasoning"],
  source: "user",
}));

useAppStore.setState({ providers: [provider], providerModels: { [provider.id]: models },
  recentModels: ["model-d", "model-c", "model-b", "model-a"].map(modelId => ({ providerId: provider.id, modelId })),
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }> = [];

function Fixture() {
  const [modelId, setModelId] = useState("model-a");
  // Start with a manual value that differs from Model A's default.
  const [thinkingLevel, setThinkingLevel] = useState<SessionThinkingLevel>("low");
  const controller = useComposerModelMenu({
    mode: "agent",
    activeSessionId: "fixture-session",
    provider,
    modelId,
    thinkingProvider: undefined,
    thinkingLevel,
    controlsBlocked: false,
    configureActiveSession: async (configuration) => {
      writes.push(configuration);
      setModelId(configuration.modelId ?? "model-a");
      setThinkingLevel(configuration.thinkingLevel);
    },
  });
  globalThis.composerModelSelectionController = controller;
  return (
    <div className="composer-stack" style={{ position: "absolute", left: 120, top: 300, width: 640 }}>
      <ComposerModelPicker
        t={i18n.t} controller={controller} modelLabel={modelId}
        thinkingLabel={thinkingLevel} thinkingLevel={thinkingLevel}
        selectedProviderId={provider.id} selectedModelId={modelId}
        controlsBlocked={false} onCloseOtherMenus={() => {}}
      />
      <span className="selected-model">{modelId}</span>
      <span className="selected-thinking-level">{thinkingLevel}</span>
    </div>
  );
}

const settle = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

globalThis.composerModelSelectionProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  flushSync(() => root.render(<Fixture />));
  await settle();
  document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click();
  await settle();
  const modelRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".composer-model-list [role=menuitemradio]"));
  const railItems = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".composer-model-rail [role=menuitemradio]"));
  const recentRows = modelRows();
  if (recentRows.length !== 4 || !recentRows[0].textContent?.includes("model-d") || !recentRows[2].textContent?.includes("model-b")) {
    throw new Error("The recent source must list recent models in usage order");
  }
  if (railItems().length !== 2 || railItems()[0].getAttribute("aria-checked") !== "true") {
    throw new Error("The rail must offer recent plus each provider, with recent selected first");
  }
  recentRows[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await settle();
  const providerSource = railItems()[1];
  providerSource.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  providerSource.focus();
  await settle();
  if (document.querySelector(".composer-model-list .kb-active")) {
    throw new Error("Moving from a recent model to the rail must clear stale keyboard highlight");
  }
  const keyboardSearch = document.querySelector<HTMLInputElement>(".composer-model-search input")!;
  keyboardSearch.focus();
  keyboardSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle();
  if (!document.querySelector(".composer-model-list .kb-active")) throw new Error("Arrow navigation must highlight a model");
  providerSource.focus();
  // The offscreen window does not own OS focus; deliver the native focusout edge.
  keyboardSearch.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: providerSource }));
  await settle();
  if (document.querySelector(".composer-model-list .kb-active")) throw new Error("Leaving search must clear keyboard highlight");
  recentRows[2].click();
  await settle();
  if (!modelRows()[0]?.textContent?.includes("model-d")) {
    throw new Error("Selecting without sending must preserve actual usage order");
  }

  const switchedLevel = document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "";
  await globalThis.composerModelSelectionController!.commitThinkingLevel("low");
  await settle();
  const recentStyle = getComputedStyle(modelRows()[0]);
  const recentType = `${recentStyle.fontSize}/${recentStyle.fontWeight}`;
  railItems()[1].click();
  await settle();
  const providerRows = modelRows();
  if (providerRows.length !== 4 || railItems()[1].getAttribute("aria-checked") !== "true") {
    throw new Error("Choosing a provider source must list each of its models once");
  }
  const otherStyle = getComputedStyle(providerRows[3]);
  const otherType = `${otherStyle.fontSize}/${otherStyle.fontWeight}`;
  if (recentType !== otherType) {
    throw new Error(`Model typography differs: recent ${recentType}, other ${otherType}`);
  }
  railItems()[0].click();
  await settle();
  const search = document.querySelector<HTMLInputElement>(".composer-model-search input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "model-b");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  if (modelRows().length !== 1 || railItems().some((item) => item.getAttribute("aria-checked") === "true")) {
    throw new Error("Search must span every source and release the rail selection");
  }
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  const restored = useAppStore.getState().recentModels;
  if (restored[0]?.modelId !== "model-d") throw new Error("Menu interactions alone must not record usage");
  useAppStore.setState({ recentModels: [] });
  await settle();
  if (railItems().length !== 0 || modelRows().length !== 4) {
    throw new Error("Without history a single source shows all configured models without a rail");
  }
  useAppStore.setState({ recentModels: restored });
  await settle();
  return {
    model: document.querySelector(".selected-model")?.textContent?.trim() ?? "",
    switchedLevel,
    level: document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "",
    writes: [...writes],
  };
};
