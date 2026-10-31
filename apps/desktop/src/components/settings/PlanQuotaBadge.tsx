/**
 * Subscription-plan quota badge for one provider row ("5H 68% · 周 92%").
 *
 * Mounted on settings service rows and the composer's model-group headers.
 * Fetches through the shared TTL cache (one network query per provider no
 * matter how many badges render), refreshes every minute while mounted, and
 * renders nothing for providers without a queryable plan — including a row
 * whose quota query just failed, so a vendor outage never turns into a row
 * of error badges.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPlanQuotaResult, ProviderPublic } from "@pi-desktop/shared";
import {
  fetchProviderPlanQuota,
  planQuotaBadgeTone,
  planQuotaPanelItem,
  planQuotaResetRows,
  planQuotaSummaryParts,
  planQuotaTooltipLines,
  supportsProviderPlanQuota,
} from "../../lib/plan-quota";
import { Badge } from "../ui";

const REFRESH_INTERVAL_MS = 60_000;

export function PlanQuotaBadge({ provider }: { provider: ProviderPublic }) {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<ProviderPlanQuotaResult | null>(null);
  const supported = supportsProviderPlanQuota(provider);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const load = () => {
      void fetchProviderPlanQuota(provider).then((result) => {
        if (!cancelled) setQuota(result);
      });
    };
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Re-run when the row's credential was re-saved: `updatedAt` invalidates
    // the shared cache, so the next fetch is a fresh query, not stale quota.
  }, [supported, provider, provider.updatedAt]);

  if (!supported || !quota?.supported || quota.windows.length === 0) return null;
  const summary = planQuotaSummaryParts(quota.windows, t);
  if (summary.length === 0) return null;
  const details = [
    quota.planName ?? t("chat.planQuotaBadgeTitle"),
    ...planQuotaTooltipLines(quota.windows, t),
  ].join("\n");

  return (
    <span
      className="model-provider-plan-quota"
      title={details}
      aria-label={details}
      tabIndex={0}
    >
      <Badge tone={planQuotaBadgeTone(quota.windows)}>{summary.join(" · ")}</Badge>
    </span>
  );
}

/**
 * The same quota as label/value rows for the context-usage inspector popover
 * ("每 5 小时  68%"). Mounted only while the popover is open, so the poll
 * stops when the panel closes; rows carry the reset time as their tooltip.
 */
export function PlanQuotaSection({ provider }: { provider: ProviderPublic }) {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<ProviderPlanQuotaResult | null>(null);
  const supported = supportsProviderPlanQuota(provider);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const load = () => {
      void fetchProviderPlanQuota(provider).then((result) => {
        if (!cancelled) setQuota(result);
      });
    };
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [supported, provider, provider.updatedAt]);

  if (!supported || !quota?.supported || quota.windows.length === 0) return null;
  const resetRows = planQuotaResetRows(quota.windows, t);
  return (
    <div className="context-inspector-summary">
      <div className="context-inspector-summary-row">
        <strong>{t("chat.planQuotaBadgeTitle")}</strong>
        <span className="context-inspector-summary-values">
          {quota.windows.map((window, index) => (
            <span key={`${window.kind}:${index}`}>
              {planQuotaPanelItem(window, t)}
            </span>
          ))}
        </span>
      </div>
      {resetRows.length > 0 ? (
        <div className="context-inspector-summary-row">
          <strong>{t("chat.planQuotaResetHeading")}</strong>
          <span className="context-inspector-summary-values">
            {resetRows.map((row, index) => (
              <span key={`${index}:${row}`}>{row}</span>
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
}
