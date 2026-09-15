import { useTranslation } from "react-i18next";

/** A measured request latency; absent on old records and before the first output. */
export function FirstOutputLatency({ milliseconds }: { milliseconds?: number }) {
  const { t } = useTranslation();
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  return (
    <span className="message-meta-chip first-output-latency" title={t("chat.firstOutputHint")}>
      {t("chat.firstOutputLatency", { seconds: (milliseconds / 1000).toFixed(1) })}
    </span>
  );
}
