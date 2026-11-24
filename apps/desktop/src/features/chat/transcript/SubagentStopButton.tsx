import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../../components/ui";
import { IconStop } from "../../../components/icons";
import { requestSubagentStop, useStops } from "../../../lib/subagent-stops";
import { useAppStore } from "../../../stores/app-store";

export function SubagentStopButton({
  delegationId,
  running,
  name,
  compact = false,
}: {
  delegationId?: string;
  running: boolean;
  name?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const paneSessionId = useSlotSessionId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const sessionId = useAppStore(state => paneSessionId || state.activeSessionId);
  const source = useAppStore(state => state.sessions.find(session => session.id === state.activeSessionId)?.source);
  const busy = useStops(state => sessionId ? state.busy[sessionId] : undefined);
  const pending = useStops(state => sessionId ? state.pending[sessionId] : undefined);
  const stopping = delegationId ? pending?.includes(delegationId) : false;
  const stoppingRequest = busy && (!delegationId || !busy.ids || busy.ids.includes(delegationId));
  useEffect(() => {
    if (running || !sessionId || !delegationId || !stopping) return;
    useStops.setState(state => ({ pending: {
      ...state.pending,
      [sessionId]: (state.pending[sessionId] ?? []).filter(id => id !== delegationId),
    } }));
  }, [running, sessionId, delegationId, stopping]);
  if (!running || !localToolsAllowed || !sessionId || source === "remote" || source === "pi-native") return null;

  const stop = () => requestSubagentStop(sessionId, delegationId ? [delegationId] : undefined);
  const label = stoppingRequest || stopping
    ? t("chat.stoppingSubagents")
    : delegationId
      ? t("chat.stopSubagentNamed", { name: name ?? t("chat.subagentUnnamed") })
      : t("chat.stopAllSubagents");
  if (compact) {
    return (
      <TooltipButton
        type="button"
        className="stop-btn"
        tooltip={label}
        ariaLabel={label}
        disabled={!!busy || stopping}
        onClick={() => void stop()}
      >
        {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={13} />}
      </TooltipButton>
    );
  }
  return (
    <Button
      className="subagent-stop-button"
      variant="secondary"
      size="sm"
      title={label}
      aria-label={label}
      disabled={!!busy || stopping}
      onClick={() => void stop()}
    >
      {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={9} />}
      <span>{stoppingRequest || stopping
        ? t("chat.stoppingSubagents")
        : t(delegationId ? "chat.stopSubagent" : "chat.stopAllSubagentsShort")}</span>
    </Button>
  );
}
