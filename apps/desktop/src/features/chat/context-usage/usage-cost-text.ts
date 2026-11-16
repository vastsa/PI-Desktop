import type { TFunction } from "i18next";
import { formatUsd, type UsageCostView } from "../../../lib/usage-cost";

export type UsageCostText = {
  /** Short figure shown inline. */
  text: string;
  /** One-sentence explanation for the tooltip and accessible name. */
  help: string;
};

/**
 * Single wording for every cost figure: exact bills read plainly, catalog
 * estimates carry "≈", totals missing a price carry "≥", and subscription
 * usage is named as such with its API-price equivalent kept as context.
 */
export function usageCostText(
  view: UsageCostView,
  t: TFunction,
  locale?: string,
): UsageCostText | undefined {
  switch (view.kind) {
    case "none":
      return undefined;
    case "unknown":
      return { text: t("chat.usageCostUnknown"), help: t("chat.usageCostUnknownHelp") };
    case "subscription":
      return {
        text: t("chat.usageCostSubscription"),
        help: view.equivalent === undefined
          ? t("chat.usageCostSubscriptionHelp")
          : t("chat.usageCostSubscriptionEquivalentHelp", {
              amount: formatUsd(view.equivalent, locale),
            }),
      };
    case "billed": {
      const amount = formatUsd(view.amount, locale);
      const text = view.qualifier === "exact"
        ? amount
        : t(view.qualifier === "estimated" ? "chat.usageCostEstimated" : "chat.usageCostLowerBound", { amount });
      const help = [
        view.qualifier === "lowerBound"
          ? t("chat.usageCostLowerBoundHelp", { count: view.unpricedRequests })
          : t(view.qualifier === "estimated" ? "chat.usageCostEstimatedHelp" : "chat.usageCostReportedHelp"),
        view.subscriptionEquivalent === undefined
          ? undefined
          : t("chat.usageCostPlusSubscriptionHelp", {
              amount: formatUsd(view.subscriptionEquivalent, locale),
            }),
      ].filter(Boolean).join(" ");
      return { text, help };
    }
  }
}
