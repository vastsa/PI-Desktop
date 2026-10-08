/**
 * Adding Jev from the service list (D625).
 *
 * The service chooser answers "which service"; this is the whole second half
 * for Jev, whose only decision is a TypeSafe key. One button runs both steps —
 * check the key against TypeSafe, then store it and turn Jev on — so a key
 * that never answered is never kept, and adding Jev is the same click as
 * enabling it. Closing this dialog while the check is still running cancels
 * the whole action: nothing is stored and nothing is enabled.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { Button, Field, PasswordInput } from "../ui";
import { addJevService } from "./jev-config";
import { appJevConfigDeps, useJevKeyStatus } from "./jev-app-config";

export type JevServiceFormProps = {
  onClose: () => void;
  /** The key was stored and Jev turned on; the caller closes this dialog. */
  onConfigured: () => void;
};

export function JevServiceForm({ onClose, onConfigured }: JevServiceFormProps) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [keyDraft, setKeyDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [keyStatus] = useJevKeyStatus();
  const aborted = useRef<AbortController | null>(null);
  const configured = keyStatus === "configured";

  // Unmounting is a cancel: the check may still be in flight, and a dialog the
  // user closed must not come back later with a stored credential.
  useEffect(() => () => aborted.current?.abort(), []);

  const statusText = configured
    ? t("settings.jevKeyConfigured")
    : keyStatus === "unavailable"
      ? t("settings.jevKeyStatusUnavailable")
      : keyStatus === "loading"
        ? t("settings.jevKeyStatusChecking")
        : t("settings.jevKeyMissing");

  const save = async () => {
    if (checking || !keyDraft.trim()) return;
    const controller = new AbortController();
    aborted.current = controller;
    setChecking(true);
    try {
      const outcome = await addJevService(appJevConfigDeps(), keyDraft, controller.signal);
      if (!outcome.ok) {
        // Closed while the check ran: the user cancelled, so say nothing at all.
        if (outcome.reason === "cancelled") return;
        showToast(
          outcome.reason === "missing-key"
            ? t("settings.jevKeyRequired")
            : outcome.message || t("settings.jevKeyCheckFailed"),
          { variant: "error" },
        );
        return;
      }
      setKeyDraft("");
      showToast(t("settings.jevServiceAdded"), { variant: "success" });
      onConfigured();
    } catch (error) {
      if (controller.signal.aborted) return;
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  return (
    <>
      <div className="provider-setup-head">
        <h3 id="provider-setup-title" className="provider-setup-title">
          {t("settings.jevTitle")}
        </h3>
        <div className="provider-setup-head-actions">
          <Button variant="ghost" size="sm" disabled={checking} onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={checking || !keyDraft.trim()}
            onClick={() => void save()}
          >
            {checking ? t("settings.jevCheckingKey") : t("settings.jevTestAndSave")}
          </Button>
        </div>
      </div>

      <div className="provider-setup-body">
        <div className="provider-setup-credentials">
          <div className="jev-setup">
            <p className="jev-setup-description">{t("settings.jevDescription")}</p>
            <p className="jev-setup-privacy">{t("settings.jevPrivacyNotice")}</p>
            <Field label={t("settings.jevApiKey")}>
              <PasswordInput
                value={keyDraft}
                autoFocus
                placeholder={t("settings.jevApiKeyPlaceholder")}
                aria-label={t("settings.jevApiKey")}
                autoComplete="new-password"
                showLabel={t("settings.configSync.showPassword")}
                hideLabel={t("settings.configSync.hidePassword")}
                disabled={checking}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
            </Field>
            <p className="jev-setup-status" role="status">
              {statusText}
            </p>
            <p className="jev-setup-note">{t("settings.jevAddEnableNote")}</p>
          </div>
        </div>
      </div>
    </>
  );
}
