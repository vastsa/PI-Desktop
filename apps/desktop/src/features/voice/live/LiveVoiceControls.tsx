import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { IconWaveform } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { PortalVisibilityContext } from "../../../lib/portal-visibility";
import { getLiveCallController } from "./live-call-controller";
import { hasUnconfirmedMediaRelease, liveVoiceMode } from "./live-voice-presentation";
import { LiveVoicePreparation } from "./LiveVoicePreparation";
import "../../../styles/voice.css";

export function LiveVoiceControls({ t, workSessionId }: {
  t: TFunction;
  workSessionId?: string;
}) {
  const controller = getLiveCallController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const visible = useContext(PortalVisibilityContext);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mode = liveVoiceMode(snapshot);
  const previousMode = useRef(mode);
  const releaseUnconfirmed = hasUnconfirmedMediaRelease(snapshot);
  const available = visible && snapshot.status?.enabled === true && mode === "idle" && !releaseUnconfirmed;
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!available) setOpen(false);
    if (available && previousMode.current !== "idle" && document.activeElement === document.body) {
      triggerRef.current?.focus();
    }
    previousMode.current = mode;
  }, [available, mode]);

  if (!available) return null;

  return (
    <AnchoredMenu
      open={open}
      onClose={close}
      role="dialog"
      label={t("liveVoice.prepareCall")}
      side="top"
      className="live-voice-control"
      menuClassName="live-voice-popup"
      anchorRef={triggerRef}
      trigger={() => (
        <TooltipButton
          ref={triggerRef}
          type="button"
          className="icon-btn icon-btn-square"
          tooltip={t("liveVoice.title")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <IconWaveform size={15} aria-hidden="true" />
        </TooltipButton>
      )}
    >
      <LiveVoicePreparation t={t} status={snapshot.status} workSessionId={workSessionId} onClose={close} />
    </AnchoredMenu>
  );
}
