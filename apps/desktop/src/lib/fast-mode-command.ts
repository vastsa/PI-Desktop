import i18n from "i18next";
import { fastModeBillingOn, type ProviderPublic } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { sameComposerModelId } from "./composer-models";
import { isRemoteSession } from "./remote-session-safety";
import { inheritedSessionModelBinding } from "./session-model";

/**
 * The `/fast` builtin (ADR 0334): a per-session switch for OpenAI's priority
 * service tier. Model settings decide which models may use it.
 */

type FastModeProvider = Pick<ProviderPublic, "apiStyle" | "models"> | undefined | null;

function fastModeAllowed(provider: FastModeProvider, modelId: string | undefined): boolean {
  return !!modelId && provider?.models.some(
    (binding) => sameComposerModelId(binding.id, modelId) && binding.fastModeAllowed === true,
  ) === true;
}

/** Whether the Composer should mark the selected model as running in Fast mode. */
export function sessionFastModeActive(
  provider: FastModeProvider,
  modelId: string | undefined,
  target: { fastMode?: boolean } | null | undefined,
): boolean {
  return target?.fastMode === true && !!fastModeBillingOn(provider?.apiStyle) &&
    fastModeAllowed(provider, modelId);
}

export async function toggleSessionFastMode(): Promise<void> {
  const store = useAppStore.getState();
  const activeSession = store.sessions.find((session) => session.id === store.activeSessionId);
  if (store.activeSessionId && !activeSession) return;
  if (activeSession && isRemoteSession(activeSession)) {
    store.showToast(i18n.t("chat.fastModeRemote"), { variant: "warning" });
    return;
  }
  const target = activeSession ?? store.draftConfiguration;
  const enabled = target?.fastMode !== true;
  const selected = inheritedSessionModelBinding({
    draft: target,
    settings: store.settings,
    providers: store.providers,
    recentModels: store.recentModels,
  });
  const provider = store.providers.find((candidate) => candidate.id === selected.providerId);
  const billing = fastModeBillingOn(provider?.apiStyle);
  // Without a configured model the switch does nothing, so `/fast` only
  // points to the setting; a stale stored switch stays inert at launch.
  if (!billing) {
    store.showToast(i18n.t("chat.fastModeUnsupported"), { variant: "warning" });
    return;
  }
  if (!fastModeAllowed(provider, selected.modelId)) {
    store.showToast(i18n.t("chat.fastModeNotAllowed"), { variant: "warning" });
    return;
  }

  if (activeSession) {
    await store.configureActiveSession({
      mode: activeSession.mode,
      providerId: activeSession.providerId,
      modelId: activeSession.modelId,
      thinkingLevel: activeSession.thinkingLevel,
      fastMode: enabled,
    });
    // A pending plan review or a read-only session leaves the switch as is.
    const after = useAppStore.getState().sessions.find((session) => session.id === activeSession.id);
    if ((after?.fastMode === true) !== enabled) return;
  } else {
    useAppStore.setState((state) => ({
      draftConfiguration: { ...state.draftConfiguration, fastMode: enabled },
    }));
  }
  const message = !enabled ? "chat.fastModeOff" : billing === "usage" ? "chat.fastModeOnUsage" : "chat.fastModeOn";
  store.showToast(i18n.t(message), { variant: "info" });
}
