import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import {
  fitSubagentChips,
  selectedSubagentModels,
  type ChipFit,
  type SubagentModelCandidate,
} from "./subagent-delegation";

/** Chip spacing, mirrored in `model-config.css`. */
const CHIP_GAP = 5;
/** The chip line never takes more than this share of the row. */
const CHIP_SHARE = 0.6;
/** Keep a few pixels clear so a rounding error cannot clip the last chip. */
const CHIP_SAFETY = 12;

/**
 * One quiet line on the Models page: which models the AI may pick when it
 * delegates, and a way into the editor.
 *
 * The row stays short by design — a configured install can delegate to a dozen
 * models — so the chips take at most 60% of the row and the rest collapse into
 * `+N`. Widths are measured from the rendered chips, because only the browser
 * knows how wide a model id is at the current font and zoom.
 */
export function SubagentModelRow({
  candidates,
  onEdit,
}: {
  candidates: SubagentModelCandidate[];
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const selected = selectedSubagentModels(candidates);
  const names = selected.map((candidate) => candidate.label);
  const identity = names.join("\u0000");
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [fit, setFit] = useState<ChipFit>({ visible: names.length, hidden: 0 });

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const element = measureRef.current;
    if (!element) return;
    const compute = () => {
      const chips = Array.from(element.children) as HTMLElement[];
      if (chips.length < 2) return;
      const moreChip = chips[chips.length - 1];
      const widths = chips.slice(0, -1).map((chip) => chip.getBoundingClientRect().width);
      const rowWidth = element.parentElement?.getBoundingClientRect().width ?? 0;
      setFit(
        fitSubagentChips({
          widths,
          gap: CHIP_GAP,
          available: Math.max(0, rowWidth * CHIP_SHARE - CHIP_SAFETY),
          moreWidth: moreChip.getBoundingClientRect().width,
        }),
      );
    };
    compute();
    const observer = new ResizeObserver(compute);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [identity]);

  // Nothing configured yet: the page hides this row rather than offering an
  // editor with no models in it.
  if (candidates.length === 0) return null;

  return (
    <div className="settings-row model-default-row model-subagent-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">
          {t("settings.subagentModels")}
        </div>
        <div className="settings-row-detail model-default-value">
          {selected.length === 0 ? (
            <span className="model-default-empty" role="status">
              {t("settings.subagentModelsUnset")}
            </span>
          ) : (
            <span
              className="model-subagent-chips"
              aria-label={names.join(", ")}
              title={names.join(", ")}
            >
              {names.slice(0, fit.visible).map((name) => (
                <span className="model-subagent-chip" key={name}>
                  {name}
                </span>
              ))}
              {fit.hidden > 0 ? (
                <span
                  className="model-subagent-chip model-subagent-chip-more"
                  aria-label={t("settings.subagentModelsMore", { count: fit.hidden })}
                >
                  {`+${fit.hidden}`}
                </span>
              ) : null}
            </span>
          )}
          {/* Off-screen twin: the only way to know how wide each chip is. */}
          <span ref={measureRef} className="model-subagent-measure" aria-hidden="true">
            {names.map((name) => (
              <span className="model-subagent-chip" key={name}>
                {name}
              </span>
            ))}
            <span className="model-subagent-chip">{`+${names.length}`}</span>
          </span>
        </div>
      </div>
      <div className="settings-row-control">
        <Button size="sm" variant="secondary" onClick={onEdit}>
          {t("settings.subagentModelEdit")}
        </Button>
      </div>
    </div>
  );
}
