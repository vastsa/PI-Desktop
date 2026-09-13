import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SessionSearchContext as Context,
  SessionSearchContextRequest,
} from "@pi-desktop/shared";
import { api } from "../lib/api";
import { SearchHighlight } from "./SearchHighlight";

/** A bounded historical reader; it never writes to the live transcript store. */
export function SessionSearchContext({
  focus,
  onClose,
}: {
  focus: SessionSearchContextRequest;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState(focus);
  const [context, setContext] = useState<Context>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const target = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void api
      .getSearchContext(request)
      .then((result) => {
        if (!cancelled) setContext(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  useEffect(() => {
    if (!context) return;
    if (target.current) target.current.scrollIntoView({ block: "center" });
    else scroller.current?.scrollTo({ top: 0 });
  }, [context]);

  const page = (direction: "before" | "after") => {
    const anchor =
      direction === "before" ? context?.messages[0] : context?.messages.at(-1);
    if (anchor) setRequest({ ...focus, messageId: anchor.id, direction });
  };

  return (
    <section className="session-search-context" aria-label={t("search.messageContext")}>
      <div className="search-context-toolbar">
        <span>{t("search.messageContext")}</span>
        <button ref={close} type="button" className="btn btn-secondary" onClick={onClose}>
          {t("search.returnToConversation")}
        </button>
      </div>
      <div className="search-context-match-nav">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading || !context?.previousMatchId}
          onClick={() =>
            context?.previousMatchId &&
            setRequest({ ...focus, messageId: context.previousMatchId })
          }
        >
          {t("search.previousMatch")}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading || !context?.nextMatchId}
          onClick={() =>
            context?.nextMatchId &&
            setRequest({ ...focus, messageId: context.nextMatchId })
          }
        >
          {t("search.nextMatch")}
        </button>
      </div>
      <div className="search-context-scroll" ref={scroller} aria-busy={loading}>
        {failed ? (
          <div role="alert" className="search-empty">
            {t("search.contextUnavailable")}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRequest({ ...request })}
            >
              {t("search.retry")}
            </button>
          </div>
        ) : null}
        {loading ? (
          <div role="status" className="search-empty">
            {t("search.loading")}
          </div>
        ) : null}
        {context?.hasMoreBefore ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => page("before")}
          >
            {t("search.previousMessages")}
          </button>
        ) : null}
        {context?.messages.map((message) => (
          <article
            key={message.id}
            ref={
              message.id === request.messageId &&
              (!request.direction || request.direction === "around")
                ? target
                : undefined
            }
            className={`search-context-message${message.id === request.messageId && (!request.direction || request.direction === "around") ? " search-context-target" : ""}`}
            data-search-message-id={message.id}
          >
            <div className="search-context-meta">
              <span>
                {message.role === "user"
                  ? t("search.user")
                  : message.role === "assistant"
                    ? t("search.assistant")
                    : message.toolName || message.role}
              </span>
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </div>
            <div className="search-context-text">
              <SearchHighlight text={message.content} query={focus.query} />
            </div>
          </article>
        ))}
        {context?.hasMoreAfter ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => page("after")}
          >
            {t("search.nextMessages")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
