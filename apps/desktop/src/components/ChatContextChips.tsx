/**
 * A compact reference with an optional remove button. Hovering previews the
 * content. Sent messages reuse the same chips without removal controls.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Quote } from "lucide-react";
import { TooltipButton } from "./ui";
import { IconClose } from "./icons";
import type { ChatContextChip } from "../lib/chat-context-chips";

interface PreviewLayout {
  top: number;
  left: number;
  below: boolean;
}

/** The hover preview: view-only, measured once and clamped into the viewport. */
function ChipPreview({ chip, layout, id, onEnter, onLeave }: {
  chip: ChatContextChip; layout: PreviewLayout; id: string;
  onEnter: () => void; onLeave: () => void;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [position, setPosition] = useState({ top: layout.top, left: layout.left });

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const clamp = (value: number, size: number, limit: number) => Math.max(8, Math.min(value, limit - size - 8));
    setPosition({
      top: clamp(layout.below ? layout.top : layout.top - rect.height, rect.height, window.innerHeight),
      left: clamp(layout.left, rect.width, window.innerWidth),
    });
  }, [layout.top, layout.left, layout.below, chip.content]);

  return (
    <pre
      ref={ref}
      id={id}
      role="tooltip"
      className="composer-ctx-chip-preview"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={position}
    >
      {chip.content}
    </pre>
  );
}

export function ChatContextChips({
  chips,
  onRemove,
}: {
  chips: ChatContextChip[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const previewId = useId();
  const [preview, setPreview] = useState<(PreviewLayout & { id: string }) | null>(
    null,
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepPreview = () => clearTimeout(hideTimer.current);
  const hidePreview = () => {
    keepPreview();
    hideTimer.current = setTimeout(() => setPreview(null), 160);
  };
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".composer-ctx-chip-preview")) return;
      setPreview(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  if (chips.length === 0) return null;

  const showPreview = (chip: ChatContextChip, anchor: HTMLElement) => {
    keepPreview();
    const rect = anchor.getBoundingClientRect();
    // Prefer above the chip; flip below near the top of the window.
    const below = rect.top < 240;
    setPreview({
      id: chip.id,
      top: below ? rect.bottom + 6 : rect.top - 6,
      left: rect.left,
      below,
    });
  };

  const previewChip = preview
    ? chips.find((chip) => chip.id === preview.id)
    : null;

  return (
    <div className="composer-ctx-chips" data-readonly={!onRemove || undefined}>
      {chips.map((chip) => (
        <div
          key={chip.id}
          className="composer-ctx-chip"
          role="group"
          tabIndex={0}
          aria-label={chip.title}
          aria-describedby={preview?.id === chip.id ? previewId : undefined}
          onPointerEnter={(event) => showPreview(chip, event.currentTarget)}
          onPointerLeave={hidePreview}
          onFocus={(event) => showPreview(chip, event.currentTarget)}
          onBlur={hidePreview}
          onKeyDown={(event) => { if (event.key === "Escape") setPreview(null); }}
        >
          <Quote size={14} className="composer-ctx-chip-icon" />
          <span className="composer-ctx-chip-title">{chip.title}</span>
          {onRemove ? <TooltipButton
            type="button"
            className="composer-ctx-chip-remove"
            tooltip={t("sideQuestions.removeReference")}
            ariaLabel={t("sideQuestions.removeReference")}
            onClick={() => onRemove(chip.id)}
          >
            <IconClose size={12} />
          </TooltipButton> : null}
        </div>
      ))}
      {preview && previewChip && typeof document !== "undefined"
        ? createPortal(
            <ChipPreview chip={previewChip} layout={preview} id={previewId} onEnter={keepPreview} onLeave={hidePreview} />,
            document.body,
          )
        : null}
    </div>
  );
}
