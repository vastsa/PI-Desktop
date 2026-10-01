import { useState } from "react";
import type { TFunction } from "i18next";
import type { LiveStatus } from "@pi-desktop/shared";
import { IconClose, IconPlay, IconSettings } from "../../../components/icons";
import { Button, Checkbox, Panel, TooltipButton } from "../../../components/ui";
import { getLiveCallController } from "./live-call-controller";
import { openLiveVoiceSettings } from "./live-voice-navigation";
import { liveReadinessMessage, selectedLiveBinding } from "./live-voice-presentation";

export function LiveVoicePreparation({ t, status, workSessionId, onClose }: {
  t: TFunction;
  status: LiveStatus | null;
  workSessionId?: string;
  onClose: () => void;
}) {
  const [shareSelectedSessionContext, setShareSelectedSessionContext] = useState(false);
  const binding = selectedLiveBinding(status);
  const readinessMessage = liveReadinessMessage(status);

  return (
    <Panel className="live-voice-preparation">
      <div className="live-voice-panel-heading">
        <strong>{t("liveVoice.prepareCall")}</strong>
        <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("common.close")} onClick={onClose}>
          <IconClose size={15} aria-hidden="true" />
        </TooltipButton>
      </div>
      <div className="live-voice-service-row">
        <div className="live-voice-service-label">
          <span className="live-voice-hint">{t("liveVoice.provider")}</span>
          <strong>{binding?.providerLabel ?? t("liveVoice.chooseProvider")}</strong>
        </div>
        <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t("errors.action.openSettings")} onClick={() => { onClose(); openLiveVoiceSettings(); }}>
          <IconSettings size={16} aria-hidden="true" />
        </TooltipButton>
      </div>
      {/* Only a blocking cause earns a line here: the panel states what the call
          will do and what it will not share through its own controls, so a
          paragraph of prose above Start would only push Start out of reach. */}
      {readinessMessage ? <p className="live-voice-hint" role="status">{t(readinessMessage)}</p> : null}
      <div className="live-voice-work-setup">
        <Checkbox
          checked={shareSelectedSessionContext}
          label={t("liveVoice.shareContext")}
          onChange={(event) => setShareSelectedSessionContext(event.currentTarget.checked)}
        />
      </div>
      <Button
        type="button"
        variant="primary"
        className="live-voice-start"
        disabled={Boolean(readinessMessage)}
        onClick={() => {
          void getLiveCallController().start({
            ...(workSessionId ? { workTarget: { workSessionId } } : {}),
            shareSelectedSessionContext,
          }).catch(() => undefined);
          onClose();
        }}
      >
        <IconPlay size={16} aria-hidden="true" />
        {t("liveVoice.start")}
      </Button>
    </Panel>
  );
}
