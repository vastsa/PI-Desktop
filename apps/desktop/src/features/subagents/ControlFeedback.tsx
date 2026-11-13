import type { AgentSubagentControlResponse } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";

export function ControlFeedback({ error, delivery, busy, retry }: {
  error: Error | null; delivery: AgentSubagentControlResponse["delivery"] | null;
  busy: boolean; retry: () => void;
}) {
  const { t } = useTranslation();
  if (error) return <div className="session-subagents-control-feedback" role="alert">
    <span>{t("panel.sessionSubagents.control.sendFailed")}</span>
    <details><summary>{t("panel.sessionSubagents.errorDetails")}</summary><p>{error.message}</p></details>
    <Button type="button" size="sm" disabled={busy} onClick={retry}>{t("panel.sessionSubagents.retry")}</Button>
  </div>;
  return delivery ? <p className="session-subagents-control-feedback" role="status">
    {t(`panel.sessionSubagents.control.${delivery}`)}
  </p> : null;
}
