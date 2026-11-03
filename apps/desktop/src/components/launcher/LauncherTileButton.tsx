import { useTranslation } from "react-i18next";
import type { LauncherTile } from "../../lib/launcher-search";

/**
 * The second line of a tile.
 *
 * It answers "why is this here": the reason the query matched, or, for a
 * trigger hit, the text the plugin is about to receive. The launcher shows one
 * line, so the text is truncated rather than wrapped — a wrapped line would
 * break the eight-column grid alignment the panel promises.
 */
function useTileDetail(tile: LauncherTile): string {
  const { t } = useTranslation();
  switch (tile.reason) {
    case "pattern":
      return t("pluginLauncher.reasonReceived", { value: tile.detail });
    case "name":
      return t("pluginLauncher.reasonName", { value: tile.detail });
    case "pinyin":
      return t("pluginLauncher.reasonPinyin", { value: tile.detail });
    case "initials":
      return t("pluginLauncher.reasonInitials", { value: tile.detail });
    case "alias":
      return t("pluginLauncher.reasonAlias", { value: tile.detail });
    case "description":
      return t("pluginLauncher.reasonDescription", { value: tile.detail });
    case "pinned":
      return t("pluginLauncher.reasonPinned");
    default:
      return t("pluginLauncher.reasonRecent");
  }
}

export function LauncherTileButton({
  tile,
  active,
  disabled,
  optionId,
  onOpen,
  onMenu,
}: {
  tile: LauncherTile;
  active: boolean;
  disabled: boolean;
  optionId: string;
  onOpen: () => void;
  onMenu: (target: { tile: LauncherTile; anchor: DOMRect }) => void;
}) {
  const { t } = useTranslation();
  const detail = useTileDetail(tile);
  const sourceLabel =
    tile.kind === "plugin"
      ? t("pluginLauncher.sourcePlugin")
      : t("pluginLauncher.sourceApp");
  const executable = tile.kind === "app" ? tile.executableName : undefined;

  return (
    <div className={`plugin-launcher-tile${active ? " active" : ""}`}>
      <button
        id={optionId}
        type="button"
        role="option"
        aria-selected={active}
        disabled={disabled}
        className="plugin-launcher-tile-open"
        title={`${tile.name} · ${sourceLabel}${executable ? ` · ${executable}` : ""} · ${detail}`}
        onClick={onOpen}
      >
        <span
          className={`plugin-launcher-icon plugin-launcher-icon-${tile.kind}`}
          aria-hidden
        >
          {tile.iconDataUrl ? (
            <img src={tile.iconDataUrl} alt="" draggable={false} />
          ) : (
            <span className="plugin-launcher-monogram">{tile.monogram}</span>
          )}
        </span>
        <span className="plugin-launcher-tile-name">{tile.name}</span>
        <span className="plugin-launcher-tile-detail">
          <span className="plugin-launcher-source">{sourceLabel}</span>
          <span className="plugin-launcher-detail-text">{detail}</span>
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="plugin-launcher-tile-menu"
        aria-label={t("pluginLauncher.menuOpen", { name: tile.name })}
        onClick={(event) => {
          event.stopPropagation();
          onMenu({
            tile,
            anchor: event.currentTarget.getBoundingClientRect(),
          });
        }}
      >
        ⋯
      </button>
    </div>
  );
}
