import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LauncherTile } from "../../lib/launcher-search";
import { IconPin } from "../icons";

/**
 * One grid cell: a rounded-square icon and the name, plus its own pin toggle.
 *
 * Every source renders the same shape at the same size, so the grid reads as
 * one set of tools and the whole line below the icon belongs to the name. The
 * source still appears in the hover title for anyone who needs it, but it no
 * longer costs a corner of the icon or a word of the name. A long name is
 * ellipsized instead of wrapping, which would break the row rhythm.
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
          className={`plugin-launcher-icon${
            showIcon && tile.kind === "app" ? " plugin-launcher-icon-native" : ""
          }`}
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
        <span className="plugin-launcher-tile-name">{tile.name}</span>
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
