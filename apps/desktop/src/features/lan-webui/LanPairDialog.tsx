import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LanAdminView, LanGrants } from "@pi-desktop/shared";
import { Button, cx } from "../../components/ui";
import { IconCheck, IconCopy, IconRefresh, IconSmartphone } from "../../components/icons";
import { LanDialog } from "./LanDialog";
import { LanGrantsEditor } from "./LanGrantsEditor";
import { useCountdown } from "./use-lan-webui-admin";

export function CopyButton({ text }: { text: string }) {
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
      {t(feedback ?? "copy")}
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
  const digits = (value ?? "······").split("");

  return (
    <LanDialog
      id="lan-pair"
      title={t("pairTitle")}
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
              <Button type="button" size="sm" variant="ghost" aria-disabled={busy || undefined} onClick={busy ? undefined : issueCode}>
                <IconRefresh size={14} aria-hidden="true" />
                {t("newCode")}
              </Button>
            </div>
          </div>
        </li>
      </ol>
    </LanDialog>
  );
}

/** Approve a pending browser, or change what a paired device may do. */
export function LanAccessDialog({
  mode, label, projects, initial, busy, error, onSubmit, onDeny, onClose,
}: {
  mode: "approve" | "edit";
  label: string;
  projects: LanAdminView["projects"];
  initial: LanGrants;
  busy: boolean;
  error: string | null;
  onSubmit: (grants: LanGrants) => void;
  onDeny?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("lan");
  const [draft, setDraft] = useState(initial);
  const projectIds = projects.filter((project) => draft.projectIds.includes(project.id)).map((project) => project.id);
  const ready = projectIds.length > 0 || draft.temporary;
  return (
    <LanDialog
      id={`lan-access-${mode}`}
      title={mode === "approve" ? t("approveTitle", { label }) : t("editTitle", { label })}
      description={mode === "approve" ? t("approveDescription") : undefined}
      icon={<IconSmartphone size={18} />}
      busy={busy}
      error={error}
      onClose={onClose}
      footer={
        <>
          {!ready ? <span className="lan-dialog-footer-hint" role="status">{t("needScope")}</span> : null}
          {mode === "approve" ? (
            <Button type="button" variant="ghost" aria-disabled={busy || undefined} onClick={busy ? undefined : onDeny}>{t("deny")}</Button>
          ) : (
            <Button type="button" variant="ghost" aria-disabled={busy || undefined} onClick={busy ? undefined : onClose}>{t("cancel")}</Button>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : () => onSubmit({ ...draft, projectIds })}
          >
            {mode === "approve" ? t("allow") : t("save")}
          </Button>
        </>
      }
    >
      <LanGrantsEditor projects={projects} value={{ ...draft, projectIds }} onChange={setDraft} disabled={busy} />
    </LanDialog>
  );
}
