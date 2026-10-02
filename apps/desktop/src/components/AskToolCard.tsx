import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  askToolOptionDescription,
  askToolOptionLabel,
  type AskToolQuestion,
} from "@pi-desktop/shared";
import { AskToolRichText } from "./AskToolRichText";
import type { PendingAsk } from "../lib/pending-asks";
import { useAppStore } from "../stores/app-store";
import { Button } from "./ui";

type DraftAnswer = {
  values: string[];
  customSelected: boolean;
  customText: string;
  skipped: boolean;
};

const CUSTOM_OPTION = "__asktool_custom__";

function emptyDrafts(questions: AskToolQuestion[]): DraftAnswer[] {
  return questions.map(() => ({
    values: [],
    customSelected: false,
    customText: "",
    skipped: false,
  }));
}

export function AskToolCard({ request, queued = 0 }: { request: PendingAsk; queued?: number }) {
  const { t } = useTranslation();
  const resolveAsk = useAppStore((state) => state.resolveAsk);
  const showToast = useAppStore((state) => state.showToast);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState(() => emptyDrafts(request.questions));
  const [resolving, setResolving] = useState(false);
  const current = request.questions[index];
  const currentDraft = drafts[index];

  const currentValues = (draft: DraftAnswer): string[] => [
    ...draft.values,
    ...(draft.customSelected && draft.customText.trim()
      ? [draft.customText.trim()]
      : []),
  ];

  const statuses = useMemo(
    () =>
      drafts.map((draft) => {
        if (draft.skipped) return "skipped" as const;
        return currentValues(draft).length > 0 ? "answered" as const : "unanswered" as const;
      }),
    [drafts],
  );

  const updateDraft = (update: (draft: DraftAnswer) => DraftAnswer) => {
    setDrafts((previous) =>
      previous.map((draft, draftIndex) => (draftIndex === index ? update(draft) : draft)),
    );
  };

  const selectOption = (option: string) => {
    updateDraft((draft) => {
      if (option === CUSTOM_OPTION) {
        return {
          ...draft,
          customSelected: !draft.customSelected,
          skipped: false,
          ...(current.multiSelect ? {} : { values: [] }),
        };
      }
      if (current.multiSelect) {
        return {
          ...draft,
          values: draft.values.includes(option)
            ? draft.values.filter((value) => value !== option)
            : [...draft.values, option],
          skipped: false,
        };
      }
      return { ...draft, values: [option], customSelected: false, customText: "", skipped: false };
    });
  };

  const answers = (nextDrafts = drafts): Array<string[] | null> =>
    nextDrafts.map((draft) => {
      const values = currentValues(draft);
      return values.length > 0 && !draft.skipped ? values : null;
    });

  const submit = async (
    nextDrafts = drafts,
    explicitAnswers?: Array<string[] | null>,
  ) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolveAsk(request.sessionId, {
        requestId: request.requestId,
        sessionId: request.sessionId,
        answers: explicitAnswers ?? answers(nextDrafts),
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      setResolving(false);
    }
  };

  const next = () => {
    const nextDrafts = drafts.map((draft, draftIndex) =>
      draftIndex === index && currentValues(draft).length === 0
        ? { ...draft, skipped: true }
        : draft,
    );
    setDrafts(nextDrafts);
    if (index === request.questions.length - 1) void submit(nextDrafts);
    else setIndex((value) => value + 1);
  };

  const skip = () => {
    const nextDrafts = drafts.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, skipped: true, values: [], customSelected: false } : draft,
    );
    setDrafts(nextDrafts);
    if (index === request.questions.length - 1) void submit(nextDrafts);
    else setIndex((value) => value + 1);
  };

  return (
    <section className="asktool-card" role="region" aria-label={t("askTool.title")}>
      <div className="asktool-card-header">
        <div className="asktool-card-header-main">
          <span className="asktool-card-title" role="status" aria-live="polite">
            {t("askTool.title")}
          </span>
          <span className="asktool-card-progress">
            {t("askTool.progress", { current: index + 1, total: request.questions.length })}
            {queued > 0 ? <span> · {t("askTool.queued", { count: queued })}</span> : null}
          </span>
          <div className="asktool-indicators" aria-label={t("askTool.indicatorLabel")}>
            {statuses.map((status, statusIndex) => (
              <button
                key={`${request.requestId}-${statusIndex}`}
                type="button"
                className={`asktool-indicator ${status} ${statusIndex === index ? "current" : ""}`}
                aria-label={t(`askTool.status.${status}`, { number: statusIndex + 1 })}
                aria-current={statusIndex === index ? "step" : undefined}
                onClick={() => setIndex(statusIndex)}
              />
            ))}
          </div>
        </div>
        <div className="asktool-card-header-actions">
          <button
            type="button"
            className="asktool-decline"
            disabled={resolving}
            onClick={() => void submit(drafts, request.questions.map(() => null))}
          >
            {t("askTool.decline")}
          </button>
          <Button variant="ghost" size="sm" disabled={resolving} onClick={skip}>
            {t("askTool.skip")}
          </Button>
          <Button variant="primary" size="sm" disabled={resolving} onClick={next}>
            {index === request.questions.length - 1 ? t("askTool.submit") : t("askTool.next")}
          </Button>
        </div>
      </div>

      <h3 className="asktool-question">
        <span className="asktool-question-number">
          {t("askTool.questionNumber", { number: index + 1 })}
        </span>
        <AskToolRichText source={current.question} />
      </h3>
      <div className="asktool-options" role={current.multiSelect ? "group" : "radiogroup"}>
        {current.options.map((option, optionIndex) => {
          const label = askToolOptionLabel(option);
          const description = askToolOptionDescription(option);
          const selected = currentDraft.values.includes(label);
          return (
            <button
              key={`${label}-${optionIndex}`}
              type="button"
              className={`asktool-option ${selected ? "selected" : ""}`}
              aria-pressed={current.multiSelect ? selected : undefined}
              aria-checked={!current.multiSelect ? selected : undefined}
              role={current.multiSelect ? "checkbox" : "radio"}
              onClick={() => selectOption(label)}
            >
              <span className="asktool-option-mark" aria-hidden>{selected ? "✓" : ""}</span>
              <span className="asktool-option-copy">
                <span className="asktool-option-rich-label">
                  <AskToolRichText source={label} />
                </span>
                {description ? (
                  <span className="asktool-option-description">{description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className={`asktool-option asktool-custom-option ${currentDraft.customSelected ? "selected" : ""}`}
          aria-pressed={current.multiSelect ? currentDraft.customSelected : undefined}
          aria-checked={!current.multiSelect ? currentDraft.customSelected : undefined}
          role={current.multiSelect ? "checkbox" : "radio"}
          onClick={() => selectOption(CUSTOM_OPTION)}
        >
          <span className="asktool-option-mark" aria-hidden>{currentDraft.customSelected ? "✓" : ""}</span>
          <span>{t("askTool.customOption")}</span>
        </button>
      </div>
      {currentDraft.customSelected ? (
        <input
          className="asktool-custom-input"
          value={currentDraft.customText}
          placeholder={t("askTool.customPlaceholder")}
          aria-label={t("askTool.customOption")}
          onChange={(event) =>
            updateDraft((draft) => ({ ...draft, customText: event.target.value, skipped: false }))
          }
          autoFocus
        />
      ) : null}

    </section>
  );
}
