import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { renderedTextPage } from "../lib/render-content-limits";
import { Button } from "./ui";

export function LargeTextPreview({
  text,
  preClassName,
  renderPage,
  followLatest = false,
}: {
  text: string;
  preClassName?: string;
  renderPage?: (page: string) => ReactNode;
  /** Keep a live output on its newest page until the reader navigates away. */
  followLatest?: boolean;
}) {
  const { t } = useTranslation();
  const [selectedPage, setSelectedPage] = useState<number | null>(() =>
    followLatest ? null : 0,
  );
  const page = renderedTextPage(
    text,
    selectedPage ?? 0,
    selectedPage === null,
  );
  const content = renderPage ? renderPage(page.text) : page.text;
  const pre = <pre className={preClassName}>{content}</pre>;

  if (page.count === 1) return pre;

  const movePrevious = () => {
    setSelectedPage(Math.max(0, page.index - 1));
  };
  const moveNext = () => {
    if (page.index + 1 < page.count) {
      const nextPage = page.index + 1;
      setSelectedPage(followLatest && nextPage === page.count - 1 ? null : nextPage);
    } else {
      setSelectedPage(null);
    }
  };

  return (
    <div className="large-text-preview" data-page-index={page.index} data-page-count={page.count}>
      <div className="large-text-preview-controls" role="group" aria-label={t("chat.largeTextPageControls")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("chat.largeTextPreviousPage")}
          disabled={page.index === 0}
          onClick={movePrevious}
        >
          {t("chat.largeTextPreviousPage")}
        </Button>
        <span className="large-text-preview-status" role="status" aria-live="polite">
          {t("chat.largeTextPage", { current: page.index + 1, total: page.count })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("chat.largeTextNextPage")}
          disabled={page.index === page.count - 1}
          onClick={moveNext}
        >
          {t("chat.largeTextNextPage")}
        </Button>
      </div>
      {pre}
    </div>
  );
}
