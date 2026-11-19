import { imageGenerationBindings } from "@pi-desktop/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { providerServesChatModels } from "../../components/settings/default-model";
import { useAppStore } from "../../stores/app-store";
import {
  type AnnouncementSchedule,
  announcementShown,
  planStartupGuide,
  resolveAppOverlay,
  shouldShowAnnouncement,
  STARTUP_GUIDE_VERSION,
  startupGuideFor,
  type StartupGuidePlan,
} from "./app-overlay-model";
import {
  loadAnnouncementRecord,
  loadStartupGuideCompletedVersion,
  saveAnnouncementRecord,
  saveStartupGuideCompletedVersion,
} from "./app-overlay-preferences";
import { hasAnnouncementContent, RELEASE_ANNOUNCEMENT } from "./announcements/catalog";
import { useStartupGuideRequest } from "./startup-guide-request";
import type { StartupGuideExit } from "./StartupGuideDialog";

// The dialogs carry the Settings destinations and a Markdown renderer; keep
// them out of the startup bundle until one is actually shown.
const SettingsDialog = lazy(() =>
  import("../settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);
const StartupGuideDialog = lazy(() =>
  import("./StartupGuideDialog").then((module) => ({ default: module.StartupGuideDialog })),
);
const AnnouncementDialog = lazy(() =>
  import("./AnnouncementDialog").then((module) => ({ default: module.AnnouncementDialog })),
);

/** Whether any configured provider can run a chat model right now. */
function useHasUsableModel(): boolean {
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const imageGeneration = useAppStore((s) => s.settings?.imageGeneration);
  const imageGenerationModels = useAppStore((s) => s.settings?.imageGenerationModels);
  return useMemo(() => {
    const images = imageGenerationBindings(imageGenerationModels, imageGeneration);
    return providers.some((provider) =>
      providerServesChatModels(provider, images, providerModels),
    );
  }, [providers, providerModels, imageGeneration, imageGenerationModels]);
}

type ActiveGuide = { plan: StartupGuidePlan; source: "auto" | "manual" };

/**
 * Owns the app-level modal overlays and shows at most one of them, by
 * priority: startup guide > release announcement > Settings. A Settings
 * request made while a higher overlay is up stays pending (`settingsOpen`)
 * and opens once they are gone.
 *
 * The automatic guide and the announcement are decided once, when the shell
 * first becomes interactive (`active`), so the audience cannot change
 * mid-guide. A replay requested from Settings shows the guide for the user's
 * current state and never touches the first-launch marker.
 */
export function AppOverlayHost({ active }: { active: boolean }) {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const replayRequested = useStartupGuideRequest((s) => s.requested);
  const clearReplay = useStartupGuideRequest((s) => s.clear);
  const suppressed = useStartupGuideRequest((s) => s.suppressed);
  const hasUsableModel = useHasUsableModel();
  const [decided, setDecided] = useState(false);
  const [guide, setGuide] = useState<ActiveGuide | null>(null);
  const [announcement, setAnnouncement] = useState<AnnouncementSchedule | null>(null);

  useEffect(() => {
    if (!active || decided) return;
    setDecided(true);
    // Screenshot capture and automation drive a fixed scene; first-run hints
    // would cover it.
    if (window.__PI_CAPTURE__ || suppressed) return;
    const plan = planStartupGuide({
      completedVersion: loadStartupGuideCompletedVersion(),
      hasUsableModel,
    });
    if (plan) setGuide({ plan, source: "auto" });
    const schedule = RELEASE_ANNOUNCEMENT;
    if (
      schedule &&
      hasAnnouncementContent(schedule.id) &&
      shouldShowAnnouncement(schedule, loadAnnouncementRecord())
    ) {
      setAnnouncement(schedule);
    }
  }, [active, decided, hasUsableModel, suppressed]);

  // Suppression may arrive after the decision: drop what is showing without
  // recording it as seen.
  useEffect(() => {
    if (!suppressed) return;
    setGuide((current) => (current?.source === "auto" ? null : current));
    setAnnouncement(null);
  }, [suppressed]);

  useEffect(() => {
    if (!replayRequested) return;
    clearReplay();
    setGuide((current) => current ?? { plan: startupGuideFor(hasUsableModel), source: "manual" });
  }, [replayRequested, clearReplay, hasUsableModel]);

  const overlay = active
    ? resolveAppOverlay({
        guide: guide !== null,
        announcement: announcement !== null,
        settings: settingsOpen,
      })
    : null;

  // Once per release: the announcement counts as seen as soon as it is on
  // screen, not when the guide was still holding it back.
  useEffect(() => {
    if (overlay !== "announcement" || !announcement) return;
    saveAnnouncementRecord(announcementShown(announcement, loadAnnouncementRecord()));
  }, [overlay, announcement]);

  const exitGuide = useCallback((exit: StartupGuideExit) => {
    if (guide?.source === "auto") saveStartupGuideCompletedVersion(STARTUP_GUIDE_VERSION);
    setGuide(null);
    if (exit === "openShortcuts") setSettingsTab("shortcuts");
  }, [guide?.source, setSettingsTab]);

  const closeAnnouncement = useCallback(() => setAnnouncement(null), []);

  let dialog = null;
  if (overlay === "guide" && guide) {
    dialog = (
      <StartupGuideDialog
        plan={guide.plan}
        hasUsableModel={hasUsableModel}
        onExit={exitGuide}
      />
    );
  } else if (overlay === "announcement" && announcement) {
    dialog = (
      <AnnouncementDialog
        id={announcement.id}
        onClose={closeAnnouncement}
        onUnavailable={closeAnnouncement}
      />
    );
  } else if (overlay === "settings") {
    dialog = <SettingsDialog onClose={closeSettings} />;
  }
  return dialog ? <Suspense fallback={null}>{dialog}</Suspense> : null;
}
