import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KEYBOARD_SHORTCUTS,
  keybindingDisplayParts,
  keybindingMatchesEvent,
  resolveKeybinding,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { IconCheck, IconClose, IconSearch } from "../../components/icons";
import { Badge, Button, cx, OverlayBackdrop, portalOverlay, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { ModalLayer } from "../../lib/portal-visibility";
import { useModalDialog } from "../../lib/use-modal-dialog";
import { useAppStore } from "../../stores/app-store";
import { SettingsDestinationContent } from "../settings/SettingsDestinationContent";
import type { StartupGuidePlan, StartupGuideStep } from "./app-overlay-model";

export type StartupGuideExit = "finished" | "skipped" | "openShortcuts";

/**
 * Startup guide. Users without a usable model may configure one with the
 * same Models destination Settings shows (optional); everyone then learns
 * the plugin launcher shortcut.
 */
export function StartupGuideDialog({
  plan,
  hasUsableModel,
  onExit,
}: {
  plan: StartupGuidePlan;
  hasUsableModel: boolean;
  onExit: (exit: StartupGuideExit) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const step: StartupGuideStep = plan.steps[Math.min(index, plan.steps.length - 1)];
  const last = index >= plan.steps.length - 1;
  useModalDialog(dialogRef, { onClose: () => onExit("skipped") });

  const next = () => {
    if (last) onExit("finished");
    else setIndex((value) => value + 1);
  };

  return portalOverlay(
    <ModalLayer>
      <OverlayBackdrop className="overlay startup-guide-overlay" role="presentation">
        <div
          ref={dialogRef}
          className="dialog startup-guide-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="startup-guide-title"
          aria-describedby="startup-guide-description"
          data-surface="startup-guide"
          data-step={step}
        >
          <header className="startup-guide-header">
            <div className="startup-guide-heading">
              {plan.steps.length > 1 ? (
                <span className="startup-guide-progress">
                  {t("startupGuide.progress", { current: index + 1, total: plan.steps.length })}
                </span>
              ) : null}
              <h2 id="startup-guide-title">{t(`startupGuide.${step}.title`)}</h2>
              <p id="startup-guide-description">{t(`startupGuide.${step}.description`)}</p>
            </div>
            <TooltipButton
              type="button"
              className="icon-btn"
              tooltip={t("startupGuide.skip")}
              ariaLabel={t("startupGuide.skip")}
              onClick={() => onExit("skipped")}
            >
              <IconClose size={16} />
            </TooltipButton>
          </header>

          <div className="startup-guide-body">
            {step === "model" ? (
              <div className="startup-guide-settings settings-content-inner">
                <SettingsDestinationContent tab="agent" />
              </div>
            ) : (
              <LauncherShortcutStep onOpenShortcuts={() => onExit("openShortcuts")} />
            )}
          </div>

          <footer className="startup-guide-footer">
            {step === "model" ? (
              hasUsableModel ? (
                <Badge tone="success" className="startup-guide-status">
                  <IconCheck size={12} aria-hidden />
                  {t("startupGuide.model.ready")}
                </Badge>
              ) : (
                <span className="startup-guide-hint">{t("startupGuide.model.pending")}</span>
              )
            ) : null}
            <div className="startup-guide-actions">
              <Button variant="ghost" onClick={() => (last ? onExit("skipped") : next())}>
                {t("startupGuide.skip")}
              </Button>
              <Button variant="primary" onClick={next}>
                {last
                  ? t("startupGuide.finish")
                  : step === "model" && !hasUsableModel
                    ? t("startupGuide.later")
                    : t("startupGuide.next")}
              </Button>
            </div>
          </footer>
        </div>
      </OverlayBackdrop>
    </ModalLayer>,
  );
}

/**
 * Left: the shortcut as keycaps plus actions. Right: a thumbnail of the
 * plugin launcher. The keycaps stay dimmed until the user actually opens the
 * launcher — by its global shortcut (Main reports the launcher shown) or by
 * the same keys reaching this window.
 */
function LauncherShortcutStep({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const { t } = useTranslation();
  const keybindings = useAppStore((s) => s.settings?.keybindings);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const definition = KEYBOARD_SHORTCUTS.find((entry) => entry.id === "openPluginLauncher");
  const binding = definition ? resolveKeybinding(definition, keybindings, platform) : null;
  const parts = binding ? keybindingDisplayParts(binding, platform) : [];
  const [pressed, setPressed] = useState(false);

  useEffect(() => api.onPluginLauncherShown(() => setPressed(true)), []);
  useEffect(() => {
    if (!binding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (keybindingMatchesEvent(binding, event, platform)) setPressed(true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [binding, platform]);

  return (
    <div className="startup-guide-launcher">
      <div className="startup-guide-launcher-main">
        <div
          className={cx("startup-guide-keys", pressed && "is-active")}
          data-pressed={pressed ? "true" : "false"}
          aria-label={parts.join("+") || t("startupGuide.launcher.unbound")}
        >
          {parts.length > 0 ? (
            parts.map((part, position) => (
              <span key={`${part}-${position}`} className="startup-guide-key-part">
                {position > 0 ? <span className="startup-guide-key-plus" aria-hidden>+</span> : null}
                <kbd>{part}</kbd>
              </span>
            ))
          ) : (
            <span className="startup-guide-hint">{t("startupGuide.launcher.unbound")}</span>
          )}
        </div>
        <p className="startup-guide-press-status" role="status" aria-live="polite">
          {pressed ? t("startupGuide.launcher.pressed") : t("startupGuide.launcher.pressPrompt")}
        </p>
        <ul className="startup-guide-points">
          <li>{t("startupGuide.launcher.pointAnywhere")}</li>
          <li>{t("startupGuide.launcher.pointPlugins")}</li>
        </ul>
        <div className="startup-guide-launcher-actions">
          <Button
            variant="secondary"
            onClick={() => {
              void api.togglePluginLauncher().catch((error: unknown) => {
                console.error("Failed to open the plugin launcher", error);
              });
            }}
          >
            {t("startupGuide.launcher.tryIt")}
          </Button>
          <Button variant="ghost" onClick={onOpenShortcuts}>
            {t("startupGuide.launcher.customize")}
          </Button>
        </div>
      </div>
      <LauncherPreview />
    </div>
  );
}

/** Static thumbnail of the plugin launcher panel. Decorative only. */
function LauncherPreview() {
  const { t } = useTranslation();
  return (
    <div className="startup-guide-preview" aria-hidden>
      <div className="startup-guide-preview-panel">
        <div className="startup-guide-preview-search">
          <IconSearch size={13} />
          <span>{t("startupGuide.launcher.previewSearch")}</span>
        </div>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className={cx("startup-guide-preview-row", row === 0 && "is-selected")}>
            <span className="startup-guide-preview-icon" />
            <span className="startup-guide-preview-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
