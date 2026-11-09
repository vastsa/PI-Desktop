import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ModeRun, ModeUpdateRequest } from "@pi-desktop/shared";
import { Button, Input, Textarea } from "../../components/ui";
import { modeRunDraft, modeUpdateRequest, type ModeRunDraft } from "./mode-run-model";

/**
 * Inline editor of an open run's objective and budget. The Host applies both
 * from the next turn; the turn in progress keeps what it started with.
 */
export function ModeRunEditForm({
  run,
  busy,
  onSave,
  onCancel,
}: {
  run: ModeRun;
  busy: boolean;
  onSave: (request: ModeUpdateRequest) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<ModeRunDraft>(() => modeRunDraft(run));
  const request = modeUpdateRequest(run, draft);
  const invalid = request === "invalid";
  const set = (field: keyof ModeRunDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || invalid) return;
    if (request === null) {
      onCancel();
      return;
    }
    onSave(request);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className="mode-run-edit"
      aria-label={t("modes.run.editRegion")}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      data-testid="mode-run-edit"
    >
      <label className="mode-run-edit-field mode-run-edit-objective" htmlFor={`${id}-input`}>
        <span>{t("modes.run.objective")}</span>
        <Textarea
          id={`${id}-input`}
          value={draft.input}
          rows={3}
          autoFocus
          aria-invalid={!draft.input.trim()}
          onChange={(event) => set("input")(event.target.value)}
        />
      </label>
      <div className="mode-run-edit-budget">
        {(["maxTurns", "maxTokens"] as const).map((field) => (
          <label key={field} className="mode-run-edit-field" htmlFor={`${id}-${field}`}>
            <span>{t(`modes.run.${field}`)}</span>
            <Input
              id={`${id}-${field}`}
              inputMode="numeric"
              value={draft[field]}
              placeholder={t("modes.run.unlimited")}
              aria-invalid={invalid && Boolean(draft[field].trim())}
              onChange={(event) => set(field)(event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="mode-run-edit-footer">
        <span className="mode-run-edit-hint" role={invalid ? "alert" : undefined}>
          {invalid ? t("modes.errors.invalidEdit") : t("modes.run.editHint")}
        </span>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          {t("modes.run.cancel")}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || invalid}>
          {t("modes.run.save")}
        </Button>
      </div>
    </form>
  );
}
