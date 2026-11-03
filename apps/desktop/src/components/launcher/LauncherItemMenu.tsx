import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LauncherTile } from "../../lib/launcher-search";

/**
 * Per-tile actions the panel cannot show as tiles: pin or unpin the item, and
 * teach the launcher a second name for it.
 *
 * The alias is what makes tools the host cannot guess ("微信" for WeChat) findable
 * by the word the user actually types, so it is edited inline here rather than in
 * a settings page (issue #2085 §4).
 */
export function LauncherItemMenu({
  tile,
  pinned,
  aliases,
  onClose,
  onTogglePin,
  onSaveAliases,
}: {
  tile: LauncherTile;
  pinned: boolean;
  aliases: string[];
  onClose: () => void;
  onTogglePin: () => void;
  onSaveAliases: (aliases: string[]) => void;
}) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState(aliases.join(" "));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const commit = () => {
    onSaveAliases(
      alias
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    onClose();
  };

  return (
    <>
      <div
        className="plugin-launcher-menu-backdrop"
        role="presentation"
        onClick={onClose}
      />
      <div className="plugin-launcher-menu" role="dialog" aria-label={tile.name}>
        <strong className="plugin-launcher-menu-title">{tile.name}</strong>
        <button
          type="button"
          className="plugin-launcher-menu-action"
          onClick={() => {
            onTogglePin();
            onClose();
          }}
        >
          {pinned ? t("pluginLauncher.unpin") : t("pluginLauncher.pin")}
        </button>
        <label className="plugin-launcher-menu-label" htmlFor="launcher-alias">
          {t("pluginLauncher.alias")}
        </label>
        <input
          id="launcher-alias"
          ref={inputRef}
          className="plugin-launcher-menu-input"
          value={alias}
          placeholder={t("pluginLauncher.aliasHint")}
          onChange={(event) => setAlias(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <div className="plugin-launcher-menu-row">
          <button
            type="button"
            className="plugin-launcher-menu-action"
            onClick={commit}
          >
            {t("pluginLauncher.aliasSave")}
          </button>
          {aliases.length ? (
            <button
              type="button"
              className="plugin-launcher-menu-action"
              onClick={() => {
                onSaveAliases([]);
                onClose();
              }}
            >
              {t("pluginLauncher.aliasClear")}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
