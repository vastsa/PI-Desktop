import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { MessageUsage, SessionUsageCost } from "@pi-desktop/shared";
import { useAppStore } from "../../../stores/app-store";
import {
  subscriptionProviderIds,
  summarizeUsageCost,
  turnProviderCosts,
  usageCostView,
} from "../../../lib/usage-cost";
import { usageCostText, type UsageCostText } from "./usage-cost-text";
import {
  useSessionUsageCost,
  type SessionUsageCostState,
} from "./useSessionUsageCost";

function CostCell({ label, value }: { label: string; value: UsageCostText | string }) {
  const text = typeof value === "string" ? value : value.text;
  const help = typeof value === "string" ? undefined : value.help;
  return (
    <div>
      <span>{label}</span>
      <strong title={help} aria-label={help ? `${text}. ${help}` : undefined}>
        {text}
      </strong>
    </div>
  );
}

/**
 * Turn and whole-session spend in the composer context inspector. The turn
 * figure comes from the turn's own ledger; the session figure from the host
 * rollup, fetched only while the inspector is open. A section with nothing
 * priced, subscribed, or billed is left out rather than shown as zero.
 */
export function ContextCostKpis({
  open,
  sessionId,
  turnUsage,
  refreshKey,
  loadSessionCost,
}: {
  open: boolean;
  sessionId?: string;
  turnUsage: MessageUsage;
  /** Changes whenever the session may have been billed again. */
  refreshKey: string;
  loadSessionCost?: (sessionId: string) => Promise<SessionUsageCost>;
}) {
  const { t, i18n } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const subscriptions = useMemo(() => subscriptionProviderIds(providers), [providers]);
  const session = useSessionUsageCost({
    enabled: open,
    sessionId,
    refreshKey,
    ...(loadSessionCost ? { load: loadSessionCost } : {}),
  });
  const turn = usageCostText(
    usageCostView(summarizeUsageCost(turnProviderCosts(turnUsage), subscriptions)),
    t,
    i18n.language,
  );
  const total = sessionCostValue(session, subscriptions, t, i18n.language);
  if (!turn && !total) return null;
  return (
    <div className="context-inspector-kpis context-inspector-cost">
      {turn ? <CostCell label={t("chat.usageCostTurn")} value={turn} /> : null}
      {total ? <CostCell label={t("chat.usageCostSession")} value={total} /> : null}
    </div>
  );
}

function sessionCostValue(
  state: SessionUsageCostState | undefined,
  subscriptions: ReadonlySet<string>,
  t: ReturnType<typeof useTranslation>["t"],
  locale: string,
): UsageCostText | string | undefined {
  if (!state) return undefined;
  if (state.status === "loading") return "…";
  if (state.status === "error") {
    return { text: t("chat.usageCostUnknown"), help: t("chat.usageCostSessionError") };
  }
  return usageCostText(
    usageCostView(summarizeUsageCost(state.data.providers, subscriptions)),
    t,
    locale,
  );
}
