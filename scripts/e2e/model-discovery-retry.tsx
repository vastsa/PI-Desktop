import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
import { IPC, type ProviderPublic, type ModelInfo } from "@pi-desktop/shared";
import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const i18n = createInstance();
const provider: ProviderPublic = { id: "discovery-fixture", name: "Fixture provider", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", enabled: true, authKind: "none", hasSecret: false, models: [{ id: "discovered-model", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null }], supportsReasoning: false, supportedThinkingLevels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Fixture() {
  const controller = useComposerModelMenu({ mode: "agent", activeSessionId: "fixture-session", provider, modelId: "", thinkingProvider: undefined, thinkingLevel: "off", controlsBlocked: false, configureActiveSession: useAppStore.getState().configureActiveSession });
  return <ComposerModelPicker t={i18n.t} controller={controller} modelLabel="Fixture" thinkingLabel="Off" thinkingLevel="off" selectedProviderId={provider.id} selectedModelId="" controlsBlocked={false} onCloseOtherMenus={() => {}} />;
}
Object.assign(globalThis, { maintenanceProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  let liveCalls = 0;
  const models: ModelInfo[] = [{ providerId: provider.id, modelId: "discovered-model", displayName: "Discovered model", discoveryState: "listed", capabilities: ["text"], source: "remote" }];
  window.piDesktop = { platform: "win32", channels: IPC, on: () => () => {}, invoke: async <T,>(channel: string, ...args: unknown[]) => {
    assert(channel === IPC.invoke.providersListModels, `Unexpected API ${channel}`);
    const input = args[0] as { source: string };
    if (input.source === "cache") return { ok: true, data: { models: [{ ...models[0]!, discoveryState: "unlisted" }], source: "cache" } as T };
    if (++liveCalls === 1) return { ok: false, error: { code: "NETWORK_ERROR", message: "fixture network failure" } };
    return { ok: true, data: { models, source: "remote" } as T };
  } };
  useAppStore.setState({ providers: [provider], providerModels: {}, recentModels: [] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />)); await settle();
    const toggle = () => { const button = host.querySelector<HTMLButtonElement>(".composer-model-thinking-chip"); assert(button, "picker button mounts"); flushSync(() => button.click()); };
    toggle(); await settle();
    assert(liveCalls === 1, "opening the picker performs live discovery");
    assert(!document.querySelector(".composer-model-list [role=menuitemradio]"), "failed lookup retains the cached unlisted state");
    toggle(); await settle(); toggle(); await settle();
    assert(liveCalls === 2, "reopening retries the failed discovery");
    assert(useAppStore.getState().providerModels[provider.id]?.[0]?.modelId === "discovered-model", "retry populates production catalog state");
    const source = Array.from(document.querySelectorAll<HTMLButtonElement>(".composer-model-rail [role=menuitemradio]")).find(button => button.textContent?.includes("Fixture provider"));
    if (source) { flushSync(() => source.click()); await settle(); }
    assert(document.querySelector(".composer-model-list")?.textContent?.includes("discovered-model"), `retry makes the model selectable in the actual picker: ${document.body.textContent?.slice(-2000)}`);
    return { ok: true, liveCalls };
  } finally { root.unmount(); host.remove(); }
} });
