import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionReviewHistoryEntry } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

/** Query Host audit when reopened, so reviews remain visible after a renderer reload. */
export function SessionPermissionReviewHistory({ sessionId, open }: { sessionId: string; open: boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<PermissionReviewHistoryEntry[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const request = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++request.current;
    setEntries([]);
    setStatus("loading");
    void api.listSessionPermissionReviews(sessionId).then((result) => {
      if (request.current !== current) return;
      setEntries([...new Map(result.entries.map((entry) => [entry.requestId, entry])).values()].slice(0, 5));
      setStatus("ready");
    }).catch(() => {
      if (request.current === current) setStatus("error");
    });
    return () => { if (request.current === current) request.current++; };
  }, [sessionId, open]);

  return (
    <div role="group" aria-label={t("permission.reviewHistoryTitle")} className="composer-permission-grants composer-permission-reviews">
      <span className="composer-plus-item" role="presentation">{t("permission.reviewHistoryTitle")}</span>
      {status === "loading" ? <span className="composer-plus-item" role="status">{t("permission.reviewHistoryLoading")}</span> : null}
      {status === "error" ? <span className="composer-plus-item" role="alert">{t("permission.reviewHistoryError")}</span> : null}
      {status === "ready" && entries.length === 0 ? <span className="composer-plus-item">{t("permission.reviewHistoryEmpty")}</span> : null}
      {status === "ready" && entries.map((entry) => (
        <div key={entry.requestId} className="composer-plus-item">
          <div className="flex-1 min-w-0 text-left [overflow-wrap:anywhere]">
            <span>{entry.toolName ?? t("permission.reviewUnknownTool")} · {t(`permission.reviewDecision.${entry.decision}`)}</span>
            <small className="block text-text-muted">{entry.reason}</small>
            {entry.reviewerModelId ? <small className="block text-text-muted">{t("permission.reviewModel", { model: entry.reviewerModelId })}</small> : null}
            <small className="block text-text-muted">
              {entry.usage
                ? t("permission.reviewTokens", { count: entry.usage.totalTokens })
                : t("permission.reviewUsageUnknown")}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}
