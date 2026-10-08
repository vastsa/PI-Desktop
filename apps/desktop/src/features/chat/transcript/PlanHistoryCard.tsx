import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { PlanProposal, UiMessage } from "@pi-desktop/shared";
import { Badge, Button, Panel } from "../../../components/ui";
import { Markdown } from "../../../components/Markdown";
import { useAppStore } from "../../../stores/app-store";
import { preferredFileWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { disclosureKey, useAutomaticDisclosure } from "./disclosure";
import { useMessageRevealRequest } from "./shared";
import "../../../styles/plan-history.css";

/** Historical submissions are read-only; approval remains in PlanApprovalBar. */
export function PlanHistoryCard({ message, proposal, onUserInteraction }: {
  message: UiMessage; proposal: PlanProposal; onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const reveal = useMessageRevealRequest(message.id);
  const disclosure = useAutomaticDisclosure(false, reveal, disclosureKey("tool", message.id));
  const openTab = useAppStore(state => state.openWorkPanelTabForSession);
  const views = useAppStore(state => state.pluginViews);
  const sessionId = useSlotSessionId() || proposal.sessionId;
  const path = proposal.artifact?.relativePath;
  const status = message.planHistory?.proposal.status ?? "unknown";
  const statusKey = ["pending", "approved", "rejected", "expired", "interrupted"].includes(status) ? status : "unknown";
  const kind = proposal.kind === "goal" ? "goal" : "plan";
  return <Panel className="plan-history-card">
    <div className="plan-history-heading">
      <Button ref={disclosure.titleRef} variant="ghost" className="plan-history-title" aria-expanded={disclosure.open} aria-controls={bodyId}
        onClick={() => { onUserInteraction?.(); disclosure.toggle(); }}>
        <span aria-hidden="true">{disclosure.open ? "▾" : "▸"}</span>
        {proposal.title || t(`${kind}.untitled`)}
      </Button>
      <Badge tone={status === "approved" ? "success" : status === "pending" ? "warning" : "neutral"}>
        {t(`planHistory.${statusKey}`)}
      </Badge>
      {message.planHistory?.superseded && <Badge>{t("planHistory.superseded")}</Badge>}
    </div>
    {path && <Button variant="ghost" className="plan-history-artifact"
      aria-label={t(`${kind}.openArtifactLabel`, { path })}
      onClick={() => { onUserInteraction?.(); openTab(sessionId, preferredFileWorkPanelTab(path, views)); }}>
      {path}
    </Button>}
    {disclosure.open && <div id={bodyId} className="plan-history-body">
      <Markdown source={proposal.markdown} baseDir={path?.slice(0, path.lastIndexOf("/"))} />
    </div>}
  </Panel>;
}
