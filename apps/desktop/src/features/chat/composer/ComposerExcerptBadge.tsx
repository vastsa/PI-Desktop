import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChat, IconClose } from "../../../components/icons";
import type { ComposerExcerpt } from "../../../lib/composer-excerpts";

/** Compact context attachment; the editable prompt stays separate below it. */
export function ComposerExcerptBadge({ excerpts, onRemove, disabled }: {
  excerpts: readonly ComposerExcerpt[];
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!excerpts.length) return null;
  return (
    <div className="composer-excerpts" ref={rootRef}>
      <button
        type="button"
        className="composer-excerpts-badge"
        aria-expanded={open}
        aria-label={t("chat.excerptCount", { count: excerpts.length })}
        onClick={() => setOpen((current) => !current)}
      >
        <IconChat size={16} />
        <span>{t("chat.excerptCount", { count: excerpts.length })}</span>
      </button>
      {open ? (
        <div className="composer-excerpts-list" role="group" aria-label={t("chat.selectedExcerpts")}>
          {excerpts.map((excerpt) => (
            <div className="composer-excerpt" key={excerpt.id}>
              <blockquote>{excerpt.text}</blockquote>
              <button
                type="button"
                className="composer-excerpt-remove"
                aria-label={t("chat.removeExcerpt")}
                title={t("chat.removeExcerpt")}
                disabled={disabled}
                onClick={() => onRemove(excerpt.id)}
              ><IconClose size={14} /></button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
