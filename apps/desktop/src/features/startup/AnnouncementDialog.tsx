import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconClose } from "../../components/icons";
import { Button, OverlayBackdrop, portalOverlay, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { useModalDialog } from "../../lib/use-modal-dialog";
import {
  type AnnouncementContent,
  loadAnnouncementContent,
} from "./announcements/catalog";

/**
 * Release announcement: a short, plain-language Markdown note (text and
 * local images) bundled with the release. Shown at most once per release,
 * after the startup guide.
 */
export function AnnouncementDialog({
  id,
  onClose,
  onUnavailable,
}: {
  id: string;
  onClose: () => void;
  /** The content could not be loaded; the host drops the announcement. */
  onUnavailable: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<AnnouncementContent | null>(null);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  useModalDialog(dialogRef, { onClose });

  useEffect(() => {
    let cancelled = false;
    void loadAnnouncementContent(id, language).then(
      (loaded) => {
        if (cancelled) return;
        if (loaded) setContent(loaded);
        else onUnavailableRef.current();
      },
      (error: unknown) => {
        console.error(`Failed to load announcement ${id}`, error);
        if (!cancelled) onUnavailableRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, language]);

  const components = useMemo<Components>(() => ({
    img: ({ node: _node, src, alt, ...rest }: ComponentProps<"img"> & { node?: unknown }) => {
      const resolved = typeof src === "string" ? content?.resolveImage(src) : null;
      if (!resolved) return null;
      return <img {...rest} src={resolved} alt={alt ?? ""} loading="lazy" />;
    },
    a: ({ node: _node, href, children, ...rest }: ComponentProps<"a"> & { node?: unknown }) => (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (href && /^https:\/\//i.test(href)) void api.browserOpenExternal(href);
        }}
      >
        {children}
      </a>
    ),
  }), [content]);

  return portalOverlay(
    <OverlayBackdrop className="overlay app-announcement-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="dialog app-announcement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-announcement-title"
        data-surface="announcement"
      >
        <header className="app-announcement-header">
          <h2 id="app-announcement-title">{t("announcement.title")}</h2>
          <TooltipButton
            type="button"
            className="icon-btn"
            tooltip={t("announcement.close")}
            ariaLabel={t("announcement.close")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="app-announcement-body prose-chat selectable">
          {content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {content.markdown}
            </ReactMarkdown>
          ) : (
            <div className="route-pending" role="status" aria-label={t("app.loadingView")}>
              <span className="route-pending-indicator" aria-hidden />
            </div>
          )}
        </div>
        <footer className="app-announcement-footer">
          <Button variant="primary" onClick={onClose}>
            {t("announcement.gotIt")}
          </Button>
        </footer>
      </div>
    </OverlayBackdrop>,
  );
}
