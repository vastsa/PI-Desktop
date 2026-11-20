import { useTranslation } from "react-i18next";
import type { ShortcutPlatform } from "@pi-desktop/shared";
import type { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { ModelConfigPage } from "../../components/settings/ModelConfigPage";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import { RemoteHostsPage } from "../../components/settings/RemoteHostsPage";
import { ConfigSyncPage } from "../../components/settings/ConfigSyncPage";
import { VoiceSettingsSection } from "./voice/VoiceSettingsSection";
import { AgentInstructionsSection } from "./agent-sections";
import { AboutSettings } from "./pages/AboutSettings";
import { AgentBehaviorSettings } from "./pages/AgentBehaviorSettings";
import { AppearanceSettings } from "./pages/AppearanceSettings";
import { ConversationSettings } from "./pages/ConversationSettings";
import { SystemSettings } from "./pages/SystemSettings";
import { ModesSettingsPage } from "../modes/ModesSettingsPage";
import { useSettingsPersistence } from "./useSettingsPersistence";

export type SettingsTab = ReturnType<typeof useAppStore.getState>["settingsTab"];

/** Destinations whose rows edit the app settings snapshot directly. */
const SETTINGS_BACKED_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  "appearance",
  "chat",
  "behavior",
  "system",
  "shortcuts",
  "agent",
]);

/**
 * One built-in Settings destination, without the dialog's rail or header.
 * Settings renders it for the selected tab; other surfaces (the startup
 * guide) embed a single destination the same way, so a row behaves
 * identically wherever it appears.
 */
export function SettingsDestinationContent({
  tab,
  tabHidden = false,
}: {
  tab: SettingsTab;
  /** The destination is hidden in this build/mode and must not render. */
  tabHidden?: boolean;
}) {
  const { t } = useTranslation();
  const { settings, saveSettings, recovering, recoveryFailed, recoverSettings } =
    useSettingsPersistence();
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const tabNeedsSettings = SETTINGS_BACKED_TABS.has(tab);

  return (
    <>
      {tabNeedsSettings && !settings ? (
        <div className="settings-recovery" role="status" aria-live="polite">
          {recovering ? (
            <>
              <span className="route-pending-indicator" aria-hidden />
              <span>{t("common.loading")}</span>
            </>
          ) : recoveryFailed ? (
            <>
              <span>{t("errors.HOST_UNAVAILABLE")}</span>
              <Button variant="secondary" onClick={() => void recoverSettings()}>
                {t("errors.action.retry")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "appearance" && settings && (
        <AppearanceSettings
          settings={settings}
          saveSettings={saveSettings}
          platform={platform}
        />
      )}

      {tab === "chat" && settings && (
        <ConversationSettings settings={settings} saveSettings={saveSettings} />
      )}

      {tab === "behavior" && settings && (
        <AgentBehaviorSettings settings={settings} saveSettings={saveSettings} />
      )}

      {tab === "system" && settings && (
        <SystemSettings
          settings={settings}
          saveSettings={saveSettings}
          platform={platform}
        />
      )}

      {tab === "voice" && !tabHidden && settings && (
        <VoiceSettingsSection
          t={t}
          settings={settings}
          saveSettings={saveSettings}
        />
      )}

      {tab === "shortcuts" && settings && (
        <div className="settings-stack">
          <KeyboardShortcutsSection
            settings={settings}
            platform={platform}
            saveSettings={saveSettings}
          />
        </div>
      )}

      {tab === "agent" && <ModelConfigPage />}

      {tab === "skills" && <AgentSkillsPage />}

      {tab === "mcp" && <AgentMcpPage />}

      {tab === "subagents" && <AgentSubagentsPage />}

      {tab === "modes" && <ModesSettingsPage />}

      {tab === "instructions" && <AgentInstructionsSection />}

      {tab === "projects" && <ProjectsPage />}

      {tab === "sync" && !tabHidden && <ConfigSyncPage />}

      {tab === "remoteHosts" && !tabHidden && <RemoteHostsPage />}

      {tab === "about" && (
        <AboutSettings settings={settings ?? null} saveSettings={saveSettings} />
      )}
    </>
  );
}
