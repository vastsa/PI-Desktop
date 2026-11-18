import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, portalOverlay, TooltipButton } from "../../components/ui";
import { IconClose, IconTrash } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useAppStore } from "../../stores/app-store";

export function DeleteSideQuestionButton({ id, disabled, onDeleted }: {
  id: string; disabled?: boolean; onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = useAppStore(state => state.runningSessions[id] === true);
  return <>
    <TooltipButton tooltip={t("sideQuestions.deleteTitle")} ariaLabel={t("sideQuestions.deleteTitle")}
      disabled={disabled || running} onClick={() => setOpen(true)}><IconTrash size={14} /></TooltipButton>
    {open ? <DeleteSideQuestionDialog id={id} onClose={() => setOpen(false)} onDeleted={onDeleted} /> : null}
  </>;
}

function DeleteSideQuestionDialog({ id, onClose, onDeleted }: {
  id: string; onClose: () => void; onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useAppStore(state => state.runningSessions[id] === true);
  useBlockingOverlay();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const confirm = async () => {
    if (pending.current || running) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await useAppStore.getState().deleteSideQuestion(id);
      onDeleted?.();
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; setBusy(false); }
  };
  return portalOverlay(<dialog ref={dialog} className="dialog lifecycle-confirmation-dialog side-question-delete-dialog"
    aria-labelledby="side-question-delete-title" aria-describedby="side-question-delete-description"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}>
    <div className="lifecycle-confirmation-heading side-question-delete-heading">
      <h2 id="side-question-delete-title">{t("sideQuestions.deleteTitle")}</h2>
      <TooltipButton tooltip={t("common.close")} ariaLabel={t("common.close")} disabled={busy} onClick={onClose}><IconClose size={16} /></TooltipButton>
    </div>
    <p id="side-question-delete-description">{t("sideQuestions.deleteDescription")}</p>
    {error ? <p role="alert" className="side-question-error">{error}</p> : null}
    <div className="lifecycle-confirmation-actions">
      <Button variant="ghost" autoFocus disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={busy || running} onClick={() => void confirm()}>{t("sideQuestions.delete")}</Button>
    </div>
  </dialog>);
}
