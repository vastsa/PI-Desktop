import type { TFunction } from "i18next";
import { cx } from "../../components/ui";
import { IconChevronLeft, IconChevronRight } from "../../components/icons";
import { paginationItems } from "./market-paging";

/** Numbered pager for the marketplace grid; hidden when one page holds all. */
export function MarketPagination({
  t,
  page,
  pageCount,
  disabled,
  onPage,
}: {
  t: TFunction;
  page: number;
  pageCount: number;
  disabled?: boolean;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const items = paginationItems(page, pageCount);
  return (
    <nav className="plugins-pager" aria-label={t("plugins.pagination")}>
      <button
        type="button"
        className="plugins-pager-btn is-step"
        aria-label={t("plugins.pagePrev")}
        disabled={disabled || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <IconChevronLeft size={14} />
      </button>
      {items.map((item, index) =>
        item === "gap" ? (
          <span key={`gap-${index}`} className="plugins-pager-gap" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className={cx("plugins-pager-btn", item === page && "active")}
            aria-label={t("plugins.pageN", { page: item })}
            aria-current={item === page ? "page" : undefined}
            disabled={disabled && item !== page}
            onClick={() => item !== page && onPage(item)}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        className="plugins-pager-btn is-step"
        aria-label={t("plugins.pageNext")}
        disabled={disabled || page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        <IconChevronRight size={14} />
      </button>
      <span className="plugins-pager-status" aria-live="polite">
        {t("plugins.pageStatus", { page, pageCount })}
      </span>
    </nav>
  );
}
