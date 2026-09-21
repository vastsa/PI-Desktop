import { memo, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import type { HostedSearchRound } from "@pi-desktop/shared";
import {
  IconChevronRight,
  IconCircleAlert,
  IconGlobe,
} from "../../../components/icons";
import {
  DisclosureCollapseRail,
  useAutomaticDisclosure,
  useMessageRevealRequest,
} from "./shared";
import { disclosureKey } from "./disclosure";

/**
 * One provider-hosted web search round, rendered on the same tool-row idiom
 * as thinking and tool calls: icon + name + summary header, chevron
 * disclosure, sources in the body. Sources link out as plain text — no
 * favicon fetches — so reading a transcript never leaks source hostnames to
 * a third party nor renders broken image placeholders (#579).
 */

const HOSTED_SEARCH_PREVIEW_COUNT = 5;

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export const HostedSearchRow = memo(function HostedSearchRow({
  messageId,
  round,
  streaming,
  autoOpen = false,
  onUserInteraction,
}: {
  messageId: string;
  round: HostedSearchRound;
  streaming: boolean;
  autoOpen?: boolean;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const searching = streaming && round.status === "searching";
  const failed = round.status === "failed";
  const revealRequest = useMessageRevealRequest(messageId);
  const disclosure = useAutomaticDisclosure(autoOpen && !failed, revealRequest, disclosureKey("hostedSearch", messageId, round.id));
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const titleRef = disclosure.titleRef;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);

  const sources = round.sources ?? [];
  // The opened page leads the body list; dedupe against extracted sources.
  const links = [
    ...(round.url ? [{ url: round.url }] : []),
    ...sources.filter((source) => source.url !== round.url),
  ];
  const shown = links.slice(0, HOSTED_SEARCH_PREVIEW_COUNT);
  const hidden = links.length - shown.length;
  const expandable = Boolean(round.query) || links.length > 0;
  const summary =
    round.query ??
    (round.url
      ? sourceHost(round.url)
      : sources.length > 0
        ? t("chat.webSearchSources", { count: sources.length })
        : "");
  const name = failed
    ? t("chat.webSearchFailed")
    : searching
      ? t("chat.webSearching")
      : round.kind === "openPage"
        ? t("chat.webOpenPage")
        : round.kind === "findInPage"
          ? t("chat.webFindInPage")
          : t("chat.webSearch");

  return (
    <div className={`tool-row hosted-search ${open ? "open" : ""}`}>
      <button
        ref={titleRef}
        className="tool-row-header"
        aria-expanded={open}
        aria-controls={expandable ? detailsId : undefined}
        disabled={!expandable}
        onClick={toggleRow}
      >
        <span className="tool-row-icon" aria-hidden>
          {failed ? <IconCircleAlert size={15} /> : <IconGlobe size={15} />}
        </span>
        <span
          className={`tool-row-name ${searching ? "running" : ""} ${failed ? "turn-process-error" : ""}`}
        >
          {name}
        </span>
        {summary ? <span className="tool-row-summary">{summary}</span> : null}
        {expandable ? (
          <span className="tool-row-caret" aria-hidden>
            <IconChevronRight size={12} />
          </span>
        ) : null}
      </button>
      {open && expandable ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.collapseDetails")}
            onCollapse={collapseRow}
          />
          {round.query ? (
            <div className="hosted-search-query selectable">{round.query}</div>
          ) : null}
          {shown.length > 0 ? (
            <ul className="hosted-search-sources">
              {shown.map((source) => {
                const host = sourceHost(source.url);
                return (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      <span className="hosted-search-source-title">
                        {source.title || host || source.url}
                      </span>
                      {host && source.title ? (
                        <span className="hosted-search-source-host">{host}</span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {hidden > 0 ? (
            <span className="hosted-search-more">
              {t("chat.webSearchMore", { count: hidden })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}, (previous, next) =>
  previous.messageId === next.messageId &&
  previous.round === next.round &&
  previous.streaming === next.streaming &&
  previous.autoOpen === next.autoOpen &&
  previous.onUserInteraction === next.onUserInteraction,
);
