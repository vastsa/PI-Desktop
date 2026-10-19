import { useTranslation } from "react-i18next";
import type { ProjectRunSummary } from "../lib/sidebar-project-runs";
import { projectRunSummaryIsLive } from "../lib/sidebar-project-runs";

/**
 * The two project-level "work is running under here" affordances (D-sidebar).
 *
 * Both live on the project group *header*, not on the session rows: a
 * collapsed group folds its body to `0fr` and marks it `inert`, so a
 * row-level status dot disappears exactly when the answer is most useful.
 * The header stays visible in both states.
 *
 * Colour carries the meaning and both come from theme tokens
 * (`--ds-warning` for running, `--ds-purple` for a pending permission), so
 * light, dark, and contributed themes all recolor them. Motion is purely
 * decorative and is dropped under `prefers-reduced-motion`; the static
 * shape must stay legible on its own (see `.project-run-*` in the stylesheet).
 */

function runLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  summary: ProjectRunSummary,
): string {
  const parts: string[] = [];
  if (summary.running > 0) parts.push(t("nav.projectRunningCount", { count: summary.running }));
  if (summary.waiting > 0) parts.push(t("nav.projectWaitingCount", { count: summary.waiting }));
  return parts.join(" · ");
}

/**
 * Badge (A): a count capsule after the project name. Running is the primary
 * figure; a permission wait is a second, purple capsule so the two never
 * collapse into one ambiguous number.
 */
export function ProjectRunBadge({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (!projectRunSummaryIsLive(summary)) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-badges">
      {summary.running > 0 ? (
        <span className="project-run-badge running" aria-label={label} title={label}>
          <span className="project-run-badge-dot" aria-hidden />
          {summary.running}
        </span>
      ) : null}
      {summary.waiting > 0 ? (
        <span className="project-run-badge waiting" aria-label={label} title={label}>
          <span className="project-run-badge-dot" aria-hidden />
          {summary.waiting}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Activity rail (B): a 2px track down the group's left edge with a comet
 * pulse travelling along it. Rendered as a sibling of the header inside the
 * group so it spans the opened body too, and pinned to the header height
 * while the group is collapsed.
 */
export function ProjectRunRail({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (!projectRunSummaryIsLive(summary)) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-rail" aria-label={label} role="img">
      <span className="project-run-rail-pulse" aria-hidden />
    </span>
  );
}

/**
 * The "n" figure that accompanies the rail: a coloured pip per kind, so the
 * colour ties the number to its meaning instead of leaving a bare count.
 */
export function ProjectRunCount({ summary }: { summary: ProjectRunSummary }) {
  const { t } = useTranslation();
  if (!projectRunSummaryIsLive(summary)) return null;
  const label = runLabel(t, summary);
  return (
    <span className="project-run-count" aria-label={label} title={label}>
      {summary.running > 0 ? (
        <span className="project-run-pip running">{summary.running}</span>
      ) : null}
      {summary.waiting > 0 ? (
        <span className="project-run-pip waiting">{summary.waiting}</span>
      ) : null}
    </span>
  );
}
