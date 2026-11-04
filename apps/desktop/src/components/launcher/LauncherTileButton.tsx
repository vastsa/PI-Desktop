import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LauncherTile } from "../../lib/launcher-search";
import { IconPin } from "../icons";

/**
 * One grid cell: icon, type badge, and name — plus its own pin toggle.
 *
 * Every cell has the same three parts so the eight-column grid stays aligned:
 * the icon shape (square plugin, round application) and the small type badge
 * carry the source, and the name replaces the old second text line, which used
 * to explain why the item matched. A long name is ellipsized instead of
 * wrapping, which would break the row rhythm.
 *
 * The pin sits in the corner and is only visible while the cell is hovered,
 * active or focused; an already pinned cell keeps it visible and filled.
 */
export function LauncherTileButton({
  tile,
  pinned,
  active,
  disabled,
  optionId,
  onOpen,
  onTogglePin,
}: {
  tile: LauncherTile;
  pinned: boolean;
  active: boolean;
  disabled: boolean;
  optionId: string;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const { t } = useTranslation();
  const [iconBroken, setIconBroken] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);

  // A rescan can hand us a different icon for the same id; a URL that failed
  // before must get another chance instead of staying a monogram forever.
  useEffect(() => {
    setIconBroken(false);
  }, [tile.iconDataUrl]);

  // Keyboard navigation moves the active cell through a scrolling results
  // area, so the cell that receives focus-by-proxy must be brought into view.
  useEffect(() => {
    if (!active) return;
    openRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const typeLabel =
    tile.kind === "plugin"
      ? t("pluginLauncher.typePlugin")
      : t("pluginLauncher.typeApp");
  const pinLabel = pinned ? t("pluginLauncher.unpin") : t("pluginLauncher.pin");
  const executable = tile.kind === "app" ? tile.executableName : undefined;
  const title = `${tile.name} · ${typeLabel}${executable ? ` · ${executable}` : ""}`;
  const showIcon = Boolean(tile.iconDataUrl) && !iconBroken;

  return (
    <div className={`plugin-launcher-tile${active ? " active" : ""}`}>
      <button
        id={optionId}
        ref={openRef}
        type="button"
        role="option"
        aria-selected={active}
        disabled={disabled}
        className="plugin-launcher-tile-open"
        title={title}
        onClick={onOpen}
      >
        <span
          className={`plugin-launcher-icon plugin-launcher-icon-${tile.kind}`}
          aria-hidden
        >
          {showIcon ? (
            <img
              src={tile.iconDataUrl}
              alt=""
              draggable={false}
              onError={() => setIconBroken(true)}
            />
          ) : (
            <span className="plugin-launcher-monogram">{tile.monogram}</span>
          )}
        </span>
        <span className="plugin-launcher-tile-line">
          <span className="plugin-launcher-tile-name">{tile.name}</span>
          <span className="plugin-launcher-tile-type">{typeLabel}</span>
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="plugin-launcher-pin"
        aria-label={pinLabel}
        aria-pressed={pinned}
        title={pinLabel}
        onClick={(event) => {
          // Pinning must not open the item: the click never reaches the tile.
          event.stopPropagation();
          onTogglePin();
        }}
      >
        <IconPin size={12} aria-hidden />
      </button>
    </div>
  );
}
