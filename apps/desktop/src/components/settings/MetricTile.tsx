import type { ReactNode } from "react";
import { cx } from "../ui";

export type MetricTone = "accent" | "success" | "warning" | "danger";

/**
 * Shared metric tile for the index library destination: a tinted icon chip,
 * a muted label, a large tabular value, and an optional badge or caption.
 */
export function MetricTile({
  icon,
  tone = "accent",
  label,
  value,
  caption,
  badge,
}: {
  icon: ReactNode;
  tone?: MetricTone;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="idx-tile">
      <div className="idx-tile-head">
        <span className={cx("idx-chip", `idx-chip-${tone}`)} aria-hidden="true">
          {icon}
        </span>
        <span className="idx-tile-label">{label}</span>
        {badge}
      </div>
      <div className="idx-tile-value">{value}</div>
      {caption ? <div className="idx-tile-caption">{caption}</div> : null}
    </div>
  );
}
