import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModeCatalogEntry, ModeDocumentValidation } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, Textarea } from "../../components/ui";
import { useArmedDelete } from "../../hooks/use-armed-delete";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard } from "../settings/primitives";
import { modesApi } from "./modes-api";
import { setModeCatalog, useModesStore } from "./modes-store";
import { refreshModeCatalog } from "./modes-sync";
import { modeErrorMessage } from "./mode-run-model";
import {
  duplicateModeSource,
  labelFromModeId,
  modeEntryDiagnostic,
  modeEntryKey,
  newModeIdProblem,
  rejectedValidation,
  settingsModeEntries,
  simpleModeTemplate,
  type NewModeIdProblem,
} from "./modes-settings-model";
import { useModeSourceValidation } from "./use-mode-source-validation";
import "../../styles/modes.css";

/** The document open in the editor; `saved: false` is a new or duplicated one. */
type OpenDocument = { id: string; builtin: boolean; filePath?: string; savedSource: string; saved: boolean };

type IdForm = { purpose: "new" | "duplicate"; value: string };

const ID_PROBLEM_KEYS: Record<NewModeIdProblem, string> = {
  invalid: "modes.settings.idInvalid",
  reserved: "modes.settings.idReserved",
  taken: "modes.settings.idTaken",
};

/**
 * Settings → Modes (ADR mode-definitions): every mode in the catalog, the
 * definitions folder, and a source editor. Builtins are read-only and can be
 * duplicated under a new id; user documents are validated while typing and
 * saved or deleted through Electron main.
 */
export function ModesSettingsPage() {
  const { t } = useTranslation();
  const catalog = useModesStore((state) => state.catalog);
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState<OpenDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [idForm, setIdForm] = useState<IdForm | null>(null);
  const [busy, setBusy] = useState(false);
  const readTicket = useRef(0);
  const { armed, setArmed } = useArmedDelete();
  const editable = !!open && !open.builtin;
  const dirty = !!open && (!open.saved || draft !== open.savedSource);
  const { validation, pending, record } = useModeSourceValidation(open?.id ?? null, draft, editable);

  useEffect(() => {
    void refreshModeCatalog().catch((error: unknown) => {
      console.warn("[modes] catalog load failed", error);
    });
  }, []);

  const entries = settingsModeEntries(catalog);
  const discardAllowed = () => !dirty || window.confirm(t("modes.settings.discardConfirm"));

  const openEntry = async (entry: ModeCatalogEntry) => {
    if (entry.reserved || !discardAllowed()) return;
    const ticket = ++readTicket.current;
    setIdForm(null);
    try {
      const document = await modesApi.read(entry.id);
      if (ticket !== readTicket.current) return;
      setOpen({
        id: document.id,
        builtin: document.builtin,
        ...(document.filePath ? { filePath: document.filePath } : {}),
        savedSource: document.source,
        saved: true,
      });
      setDraft(document.source);
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
    }
  };

  const idProblem = idForm ? newModeIdProblem(idForm.value.trim(), catalog) : null;
  const submitIdForm = () => {
    if (!idForm || idProblem) return;
    const id = idForm.value.trim();
    if (idForm.purpose === "new" && !discardAllowed()) return;
    const source =
      idForm.purpose === "duplicate"
        ? duplicateModeSource(draft, id)
        : simpleModeTemplate(id, {
            description: t("modes.settings.templateDescription"),
            prompt: t("modes.settings.templatePrompt"),
          });
    readTicket.current += 1;
    setOpen({ id, builtin: false, savedSource: "", saved: false });
    setDraft(source);
    setIdForm(null);
  };

  const save = async () => {
    if (!open || open.builtin || busy) return;
    const source = draft;
    setBusy(true);
    try {
      const next = await modesApi.write({ id: open.id, source });
      if (next) setModeCatalog(next);
      setOpen((current) =>
        current?.id === open.id ? { ...current, savedSource: source, saved: true } : current,
      );
      showToast(t("modes.settings.saved"), { variant: "success" });
    } catch (error) {
      const rejected = rejectedValidation(error);
      if (rejected) record(source, rejected);
      showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!open || open.builtin || busy) return;
    if (armed !== open.id) {
      setArmed(open.id);
      return;
    }
    setArmed(null);
    setBusy(true);
    try {
      const next = await modesApi.remove(open.id);
      if (next) setModeCatalog(next);
      readTicket.current += 1;
      setOpen(null);
      setDraft("");
      showToast(t("modes.settings.deleted"), { variant: "success" });
    } catch (error) {
      showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const openLabel = open
    ? catalog?.modes.find((entry) => entry.id === open.id && !entry.reserved)?.label || labelFromModeId(open.id)
    : "";
  const knownErrors = !!validation && validation.errors.length > 0;

  return (
    <div className="settings-stack" data-testid="modes-settings">
      <SettingsCard
        title={t("modes.settings.listTitle")}
        action={
          <Button size="sm" onClick={() => setIdForm({ purpose: "new", value: "" })}>
            {t("modes.settings.newMode")}
          </Button>
        }
      >
        {catalog ? (
          <div className="modes-settings-directory">
            <span className="settings-row-title">{t("modes.settings.directory")}</span>
            <span className="modes-settings-path" data-testid="modes-directory">{catalog.directory}</span>
          </div>
        ) : null}
        {idForm ? (
          <ModeIdForm
            t={t}
            form={idForm}
            problem={idForm.value.trim() ? idProblem : null}
            onChange={(value) => setIdForm({ ...idForm, value })}
            onSubmit={submitIdForm}
            onCancel={() => setIdForm(null)}
          />
        ) : null}
        <div className="modes-settings-list" role="list" aria-label={t("modes.settings.listTitle")}>
          {entries.map((entry) => {
            const diagnostic = modeEntryDiagnostic(catalog, entry);
            const selected = !!open && open.id === entry.id && !entry.reserved;
            return (
              <div role="listitem" key={modeEntryKey(entry)}>
                <button
                  type="button"
                  className="modes-settings-row"
                  aria-current={selected || undefined}
                  aria-disabled={entry.reserved || undefined}
                  title={entry.reserved ? t("modes.settings.reservedHint") : entry.description || undefined}
                  data-mode-id={entry.id}
                  onClick={() => void openEntry(entry)}
                >
                  <span className="modes-settings-row-copy">
                    <span>{entry.label || entry.id}</span>
                    <span className="modes-settings-row-id">{entry.id}</span>
                    {diagnostic.errors[0] ? (
                      <span className="modes-settings-row-diagnostic">{diagnostic.errors[0]}</span>
                    ) : null}
                  </span>
                  <span className="modes-settings-row-badges">
                    <Badge>{t(entry.source === "builtin" ? "modes.settings.builtin" : "modes.settings.user")}</Badge>
                    {entry.staged ? <Badge>{t("modes.settings.staged")}</Badge> : null}
                    {entry.reserved ? (
                      <Badge tone="warning">{t("modes.settings.reserved")}</Badge>
                    ) : !entry.available ? (
                      <Badge tone="error">{t("modes.settings.unavailable")}</Badge>
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      {open ? (
        <SettingsCard title={openLabel}>
          <div className="modes-settings-editor" data-testid="modes-editor" data-mode-id={open.id}>
            <div className="modes-settings-editor-head">
              <span className="modes-settings-path">{open.filePath ?? open.id}</span>
              <div className="modes-settings-editor-actions">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setIdForm({ purpose: "duplicate", value: "" })}>
                  {t("modes.settings.duplicate")}
                </Button>
                {editable && open.saved ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
                    {armed === open.id ? t("modes.settings.deleteConfirm") : t("modes.settings.delete")}
                  </Button>
                ) : null}
                {editable ? (
                  <Button size="sm" variant="primary" disabled={busy || !dirty || knownErrors} onClick={() => void save()}>
                    {busy ? t("modes.settings.saving") : t("modes.settings.save")}
                  </Button>
                ) : null}
              </div>
            </div>
            {open.builtin ? <p className="modes-settings-hint">{t("modes.settings.readOnly")}</p> : null}
            <Textarea
              className="modes-settings-source"
              value={draft}
              readOnly={open.builtin}
              aria-label={t("modes.settings.source")}
              onChange={(event) => setDraft(event.target.value)}
            />
            {editable ? <ModeValidationPanel t={t} validation={validation} pending={pending} /> : null}
          </div>
        </SettingsCard>
      ) : (
        <p className="modes-settings-hint">{t("modes.settings.empty")}</p>
      )}
    </div>
  );
}

function ModeIdForm({
  t,
  form,
  problem,
  onChange,
  onSubmit,
  onCancel,
}: {
  t: (key: string) => string;
  form: IdForm;
  problem: NewModeIdProblem | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const empty = !form.value.trim();
  return (
    <form
      className="modes-settings-new"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label={t("modes.settings.newModeId")} hint={t("modes.settings.idInvalid")}>
        <Input
          value={form.value}
          autoFocus
          maxLength={40}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <Button type="submit" size="sm" variant="primary" disabled={empty || !!problem}>
        {t(form.purpose === "new" ? "modes.settings.create" : "modes.settings.duplicate")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {t("modes.settings.cancel")}
      </Button>
      {problem ? (
        <span className="modes-settings-validation-errors" role="alert">
          {t(ID_PROBLEM_KEYS[problem])}
        </span>
      ) : null}
    </form>
  );
}

function ModeValidationPanel({
  t,
  validation,
  pending,
}: {
  t: (key: string) => string;
  validation: ModeDocumentValidation | null;
  pending: boolean;
}) {
  return (
    <div className="modes-settings-validation" role="status" aria-live="polite" data-testid="modes-validation">
      {pending ? <span className="modes-settings-validation-ok">{t("modes.settings.validating")}</span> : null}
      {validation && validation.errors.length > 0 ? (
        <div className="modes-settings-validation-errors">
          <span>{t("modes.settings.errors")}</span>
          <ul>
            {validation.errors.map((error, index) => (
              <li key={`${index}:${error}`}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {validation && validation.warnings.length > 0 ? (
        <div className="modes-settings-validation-warnings">
          <span>{t("modes.settings.warnings")}</span>
          <ul>
            {validation.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {validation && validation.errors.length === 0 && validation.warnings.length === 0 ? (
        <span className="modes-settings-validation-ok">{t("modes.settings.valid")}</span>
      ) : null}
    </div>
  );
}
