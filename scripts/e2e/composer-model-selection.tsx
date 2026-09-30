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
    switches: Array<{ provider: string; model: string }>;
    switchWrites: Array<{ providerId?: string; modelId?: string }>;
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

/*
  A second, gateway-style service whose ids carry a route: switching between two
  of its models, and between it and the fixture provider, must send each
  `(providerId, modelId)` verbatim, including the id with several `/` segments.
*/
const edenProvider: ProviderPublic = {
  id: "edenai-fixture",
  name: "Eden AI",
  vendorKey: "edenai",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  authKind: "api_key_and_base_url",
  baseUrl: "https://api.edenai.run/v3",
  apiStyle: "chat_completions",
  hasSecret: true,
  models: [
    { id: "openai/gpt-latest", contextWindow: 400_000, maxTokens: 8_192, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "deepinfra/meta-llama/Llama-3.3-70B-Instruct", contextWindow: 131_072, maxTokens: 8_192, thinkingLevels: [], defaultThinkingLevel: null },
  ],
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const edenModels: ModelInfo[] = edenProvider.models.map((binding) => ({
  modelId: binding.id,
  displayName: binding.id,
  providerId: edenProvider.id,
  reasoning: false,
  capabilities: ["text", "tools"],
  contextWindow: binding.contextWindow,
  maxTokens: binding.maxTokens,
  source: "discovered",
}));
const providers = [provider, edenProvider];

useAppStore.setState({
  providers,
  providerModels: { [provider.id]: models, [edenProvider.id]: edenModels },
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }> = [];

function Fixture() {
  const [providerId, setProviderId] = useState(provider.id);
  const [modelId, setModelId] = useState("model-a");
  // Start with a manual value that differs from Model A's default.
  const [thinkingLevel, setThinkingLevel] = useState<SessionThinkingLevel>("low");
  const current = providers.find((candidate) => candidate.id === providerId) ?? provider;
  const controller = useComposerModelMenu({
    mode: "agent",
    activeSessionId: "fixture-session",
    provider: current,
    modelId,
    thinkingProvider: undefined,
    thinkingLevel,
    controlsBlocked: false,
    configureActiveSession: async (configuration) => {
      writes.push(configuration);
      if (configuration.providerId) setProviderId(configuration.providerId);
      setModelId(configuration.modelId ?? "model-a");
      setThinkingLevel(configuration.thinkingLevel);
    },
  });
  globalThis.composerModelSelectionController = controller;
  return (
    <div className="composer-stack" style={{ position: "absolute", left: 120, top: 300, width: 640 }}>
      <span className="selected-provider">{current.id}</span>
      <span className="selected-model">{modelId}</span>
      <span className="selected-thinking-level">{thinkingLevel}</span>
    </div>
  );
}

const shown = () => ({
  provider: document.querySelector(".selected-provider")?.textContent?.trim() ?? "",
  model: document.querySelector(".selected-model")?.textContent?.trim() ?? "",
});

const settle = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

globalThis.composerModelSelectionProbe = async () => {
  flushSync(() => root.render(<Fixture />));
  await settle();
  await globalThis.composerModelSelectionController!.selectModel(provider, "model-b");
  await settle();
  const switchedLevel = document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "";
  await globalThis.composerModelSelectionController!.commitThinkingLevel("low");
  await settle();
  await globalThis.composerModelSelectionController!.selectModel(provider, "model-b");
  await settle();
  const model = document.querySelector(".selected-model")?.textContent?.trim() ?? "";
  const level = document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "";
  const baseWrites = [...writes];
  // Cross-provider and gateway-id switching: fixture → Eden AI → Eden AI (deep
  // route) → back to the fixture provider. Each step is what the composer shows
  // after the hook committed the configuration it was given.
  const switches: Array<ReturnType<typeof shown>> = [];
  await globalThis.composerModelSelectionController!.selectModel(edenProvider, "openai/gpt-latest");
  await settle();
  switches.push(shown());
  await globalThis.composerModelSelectionController!.selectModel(edenProvider, "deepinfra/meta-llama/Llama-3.3-70B-Instruct");
  await settle();
  switches.push(shown());
  await globalThis.composerModelSelectionController!.selectModel(provider, "model-a");
  await settle();
  switches.push(shown());
  return {
    model,
    switchedLevel,
    level,
    writes: baseWrites,
    switches,
    switchWrites: writes.slice(baseWrites.length).map(({ providerId, modelId }) => ({ providerId, modelId })),
  };
};
