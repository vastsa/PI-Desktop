import { useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import {
  activityBucketPhrase,
  activityLabelBuckets,
  activityOpsText,
} from "../../../lib/activity-group-label";
import { cachedActivitySummary } from "../../../lib/transcript-activity-summary";
import { IconChevronRight, IconSparkles } from "../../../components/icons";
import { DisclosureCollapseRail } from "./shared";
import { DisclosureScope, type useAutomaticDisclosure } from "./disclosure";

/** Keep the body identity stable when a singleton grows into a group. */
export function ProcessActivityGroup({
  items,
  active,
  disclosure,
  children,
}: {
  items: readonly AssistantActivityItem[];
  active: boolean;
  disclosure: ReturnType<typeof useAutomaticDisclosure>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const grouped = items.length > 1;
  // A group below a collapsed whole-turn process is not expanded even when the
  // user left it open: `disclosure.open` already folds in that gate, and the
  // choice itself survives so reopening the process restores it.
  const parentVisible = disclosure.parentVisible;
  const open = (!grouped || disclosure.open) && parentVisible;
  // A folded group is one line, so the line has to state what the group did and
  // how much of it: the composition phrase and the operation count are separate
  // values so the count can never be the part that gets ellipsized away.
  // Failures are not repeated here - the tool row that failed already says so.
  const { phrase, ops } = useMemo(() => {
    const summary = cachedActivitySummary(items);
    const { named, hidden } = activityLabelBuckets(summary.buckets);
    return {
      phrase: activityBucketPhrase(named, hidden, t),
      ops: activityOpsText(summary.tools, summary.thinking, t),
    };
  }, [items, t]);
  if (items.length === 0) return null;
  return (
    <div className={`process-activity-group${grouped ? " grouped" : " singleton"}${open ? " open" : ""}`}>
      {grouped ? (
        <button
          type="button"
          className="tool-activity-header"
          ref={disclosure.titleRef}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={disclosure.toggle}
        >
          <span className="tool-activity-icon" aria-hidden><IconSparkles size={14} /></span>
          <span className={`tool-activity-label${active ? " running" : ""}`}>
            {phrase}
          </span>
          {active ? <span className="activity-marker" aria-hidden /> : null}
          {ops ? (
            <>
              <span className="turn-sep" aria-hidden>·</span>
              <span className="tool-activity-count tool-activity-ops">{ops}</span>
            </>
          ) : null}
          {active ? <span className="tool-activity-count">{t("chat.running")}</span> : null}
          <span className="tool-activity-caret" aria-hidden><IconChevronRight size={12} /></span>
        </button>
      ) : null}
      <div
        id={detailsId}
        ref={disclosure.bodyRef}
        className="process-activity-body"
        hidden={!open}
        inert={!open}
        {...disclosure.bodyEvents}
      >
        {grouped ? <DisclosureCollapseRail label={t("chat.collapseActivityGroup")} onCollapse={disclosure.collapse} /> : null}
        <DisclosureScope disclosure={disclosure} open={open}>{children}</DisclosureScope>
      </div>
    </div>
  );
}
