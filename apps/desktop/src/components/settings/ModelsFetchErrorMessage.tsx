/**
 * The classified copy for a failed model-list probe (`model-fetch-error.ts`).
 *
 * The picker renders it in the empty pane or above a stale list; the service
 * form reuses it under the key, so every surface says the same thing for the
 * same failure.
 */
import { useTranslation } from "react-i18next";
import { describeModelsFetchError } from "./model-fetch-error";

export function ModelsFetchErrorMessage({
  error,
  variant,
}: {
  error?: string;
  /** `status` is the one-line connection status under a service's key. */
  variant: "banner" | "placeholder" | "status";
}) {
  const { t } = useTranslation();
  const view = describeModelsFetchError(error);
  let summary = t("settings.modelsFetchFailed");
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
  }
  const className =
    variant === "placeholder"
      ? "provider-models-placeholder is-error"
      : variant === "status"
        ? "provider-connection-status is-error"
        : "provider-models-note is-error";
  return (
    <div className={className} role="alert">
      <span className="provider-models-error-summary">{summary}</span>
      {view.detail ? (
        <span className="provider-models-error-detail">{view.detail}</span>
      ) : null}
      {variant === "placeholder" ? (
        <span className="provider-models-error-hint">{t("settings.modelsFetchHint")}</span>
      ) : null}
    </div>
  );
}
