import { isSettingsDestinationHidden } from "../../../lib/settings-search";
import { useAppStore } from "../../../stores/app-store";

export function openLiveVoiceSettings() {
  const store = useAppStore.getState();
  const voiceHidden = isSettingsDestinationHidden(
    "voice",
    store.settings?.developerMode === true,
    import.meta.env.DEV,
  );
  store.setSettingsTab(voiceHidden ? "agent" : "voice");
  store.setPage("settings");
}
