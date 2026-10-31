import { memo } from "react";

/**
 * A whole-run text shimmer.
 *
 * The base layer stays in the layout while the shimmer layer sweeps a narrow
 * gradient across the complete string. It is deliberately not a spinner and not
 * a per-character animation: the same gradient crosses the whole label.
 */
export const TextShimmer = memo(function TextShimmer({
  text,
  active = true,
  className,
}: {
  text: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`text-shimmer${className ? ` ${className}` : ""}`}
      data-active={active ? "true" : "false"}
      aria-label={text}
    >
      <span className="text-shimmer-base" aria-hidden="true">{text}</span>
      <span className="text-shimmer-peak" aria-hidden="true">{text}</span>
    </span>
  );
});
