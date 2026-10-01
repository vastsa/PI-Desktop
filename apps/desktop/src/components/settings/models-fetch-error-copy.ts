/**
 * Toast copy for a failed model-list probe (`model-fetch-error.ts`).
 *
 * A probe failure is an event, not a state: the picker reports it once through
 * the app toast stack instead of keeping a classified box inside the dialog,
 * where it would push the panes down for as long as the failure lasts. Every
 * surface that probes the endpoint goes through here, so the same failure says
 * the same thing everywhere.
 */
import type { TFunction } from "i18next";
import { describeModelsFetchError } from "./model-fetch-error";

/**
 * One line: the classified summary plus the short technical remainder the
 * classifier considered safe to repeat (`describeModelsFetchError`).
 *
 * The keys stay literal — the renderer's i18n contract is checked from the
 * `t("…")` call sites, and a dynamic key would leave this copy unchecked.
 */
export function modelsFetchErrorText(
  error: string | undefined,
  t: TFunction,
): string {
  const view = describeModelsFetchError(error);
  let summary: string;
  switch (view.kind) {
    case "unauthorized":
      summary = t("errors.PROVIDER_UNAUTHORIZED");
      break;
    case "notFound":
      summary = t("settings.modelsFetchNotFound");
      break;
    case "rateLimited":
      summary = t("errors.PROVIDER_RATE_LIMITED");
      break;
    case "timeout":
      summary = t("errors.TIMEOUT");
      break;
    case "network":
      summary = t("errors.NETWORK_ERROR");
      break;
    case "invalidResponse":
      summary = t("settings.modelsFetchInvalidResponse");
      break;
    case "http":
      summary = t("settings.modelsFetchFailedStatus", {
        status: view.summaryParams?.status ?? 0,
      });
      break;
    default:
      summary = t("settings.modelsFetchFailed");
      break;
  }
  return view.detail ? `${summary} ${view.detail}` : summary;
}
