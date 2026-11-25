import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LanAdminView } from "@pi-desktop/shared";
import { Button, cx } from "../../components/ui";
import { IconCheck, IconCopy, IconRefresh, IconSmartphone } from "../../components/icons";
import { LanDialog } from "./LanDialog";
import { pairingQr } from "./pairing-qr";
import { useCountdown } from "./use-lan-webui-admin";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation("lan");
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 1800);
    return () => clearTimeout(timer);
  }, [feedback]);

  return (
    <Button
      type="button"
      size="sm"
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setFeedback("copied");
        } catch {
          setFeedback("copyFailed");
        }
      }}
    >
      {feedback === "copied" ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />}
      {feedback ? t(feedback) : label ?? t("copy")}
    </Button>
  );
}

export function LanPairDialog({ origin, code, busy, error, issueCode, onClose }: {
  origin: string;
  code: LanAdminView["code"];
  busy: boolean;
  error: string | null;
  issueCode: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("lan");
  const seconds = useCountdown(code?.expiresAt);
  const value = code && !busy && seconds > 0 ? code.value : null;
  const qr = useMemo(() => value ? pairingQr(origin, value) : null, [origin, value]);
  const digits = (value ?? "······").split("");

  return (
    <LanDialog
      id="lan-pair"
      title={t("pairTitle")}
      description={t("pairDescription")}
      icon={<IconSmartphone size={18} />}
      onClose={onClose}
      error={error}
      footer={value ? (
        <p className="lan-pair-waiting" role="status">
          <span className="lan-pair-waiting-dot" aria-hidden="true" />
          {t("waiting")}
        </p>
      ) : null}
    >
      <div className="lan-pair-content">
        {qr ? (
          <div className="lan-pair-scan">
            <svg
              className="lan-pair-qr"
              role="img"
              aria-label={t("pairQrLabel")}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              shapeRendering="crispEdges"
            >
              <rect width={qr.size} height={qr.size} />
              <path d={qr.path} />
            </svg>
            <p>{t("pairScan")}</p>
          </div>
        ) : null}
        <ol className="lan-pair-steps" role="list">
          <li className="lan-pair-step">
            <span className="lan-pair-step-number" aria-hidden="true">1</span>
            <div className="lan-pair-step-body">
              <p className="lan-pair-step-title">{t("pairStepOpen")}</p>
              <div className="lan-pair-url">
                <code className="lan-pair-url-text">{origin}</code>
                <CopyButton text={origin} />
              </div>
            </div>
          </li>
          <li className="lan-pair-step">
            <span className="lan-pair-step-number" aria-hidden="true">2</span>
            <div className="lan-pair-step-body">
              <p className="lan-pair-step-title">{t("pairStepCode")}</p>
              <span className="sr-only" aria-live="polite">{value ? digits.join(" ") : ""}</span>
              <div className={cx("lan-code", !value && "is-expired")} aria-hidden="true">
                {digits.map((digit, index) => <span key={index} className="lan-code-digit">{digit}</span>)}
              </div>
              <div className="lan-code-meta">
                {value ? <span>{t("codeExpiresIn", { seconds })}</span> : (
                  <span role="status">{busy ? t("codeLoading") : !error ? t("codeExpired") : null}</span>
                )}
                {value ? <CopyButton key={value} text={value} label={t("copyCode")} /> : null}
                <Button type="button" size="sm" variant="ghost" aria-disabled={busy || undefined} onClick={busy ? undefined : issueCode}>
                  <IconRefresh size={14} aria-hidden="true" />
                  {t("newCode")}
                </Button>
              </div>
            </div>
          </li>
        </ol>
      </div>
    </LanDialog>
  );
}
