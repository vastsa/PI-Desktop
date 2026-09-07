/**
 * Theme picker for Settings → General → Appearance.
 *
 * Language, font, and theme are searchable picker rows. Built-in System /
 * Light / Dark stay pinned at the top; plugin themes follow after a divider.
 * Search matches labels, descriptions, ids, and plugin ids.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ThemePreference } from "@pi-desktop/shared";
import { cx } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { useAppStore } from "../../stores/app-store";

const BUILTIN_THEMES = ["system", "light", "dark"] as const;

type ThemeOption = {
  id: ThemePreference;
  title: string;
  hint: string | null;
  haystack: string;
  kind: "builtin" | "plugin";
};

export function ThemeRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const pluginThemes = useAppStore((s) => s.pluginThemes);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<ThemePreference>(settings.theme);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const selectedId: ThemePreference = settings.theme ?? "system";

  const options = useMemo<ThemeOption[]>(() => {
    const builtins: ThemeOption[] = BUILTIN_THEMES.map((id) => {
      const title = t(
        id === "light"
          ? "settings.themeLight"
          : id === "dark"
            ? "settings.themeDark"
            : "settings.themeSystem",
      );
      const hint = t(
        id === "light"
          ? "settings.themeLightDesc"
          : id === "dark"
            ? "settings.themeDarkDesc"
            : "settings.themeSystemDesc",
      );
      return {
        id,
        title,
        hint,
        haystack: `${title} ${hint} ${id}`.toLowerCase(),
        kind: "builtin",
      };
    });
    const plugins: ThemeOption[] = pluginThemes.map((theme) => {
      const hint = t("settings.themeFromPlugin", { plugin: theme.pluginId });
      return {
        id: theme.id,
        title: theme.label,
        hint,
        haystack: `${theme.label} ${hint} ${theme.id} ${theme.pluginId} ${theme.themeId} plugin`.toLowerCase(),
        kind: "plugin",
      };
    });
    return [...builtins, ...plugins];
  }, [pluginThemes, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.haystack.includes(needle));
  }, [options, query]);

  const visibleIds = useMemo(() => visible.map((option) => option.id), [visible]);

  useEffect(() => {
    setActiveId((current) =>
      visibleIds.includes(current) ? current : (visibleIds[0] ?? "system"),
    );
  }, [visibleIds]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  const selected = options.find((option) => option.id === selectedId);
  const triggerLabel = selected?.title ?? selectedId;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (id: ThemePreference) => {
    close();
    if (id === selectedId) return;
    void saveSettings({ theme: id });
  };

  const moveActive = (delta: number) => {
    if (visibleIds.length === 0) return;
    const index = visibleIds.indexOf(activeId);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : visibleIds.length - 1
        : (index + delta + visibleIds.length) % visibleIds.length;
    setActiveId(visibleIds[next] ?? "system");
  };

  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{t("settings.theme")}</div>
        <div className="settings-row-desc">{t("settings.themeDesc")}</div>
      </div>
      <div className="settings-row-control">
        <AnchoredMenu
          className="settings-theme-anchor"
          open={open}
          onClose={close}
          menuClassName="settings-theme-menu"
          label={t("settings.theme")}
          align="end"
          initialFocus="input"
          trigger={(ref) => (
            <button
              ref={ref}
              type="button"
              className="settings-theme-trigger"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={t("settings.theme")}
              onClick={() => {
                setQuery("");
                setActiveId(selectedId);
                setOpen((current) => !current);
              }}
            >
              <span className="settings-theme-trigger-label">{triggerLabel}</span>
              <IconChevronDown size={14} aria-hidden />
            </button>
          )}
        >
          <div className="settings-theme-search">
            <IconSearch size={13} aria-hidden />
            <input
              type="text"
              value={query}
              placeholder={t("settings.themeSearchPlaceholder")}
              aria-label={t("settings.themeSearchPlaceholder")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveActive(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveActive(-1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (activeId) choose(activeId);
                }
              }}
            />
          </div>
          <div className="settings-theme-results">
            {visible.length === 0 ? (
              <div className="settings-theme-empty">{t("settings.noResults")}</div>
            ) : (
              <ul className="settings-theme-list">
                {visible.map((option, index) => {
                  const isCurrent = option.id === selectedId;
                  const isActive = option.id === activeId;
                  const next = visible[index + 1];
                  const showDivider =
                    option.kind === "builtin" && next?.kind === "plugin";
                  return (
                    <li
                      key={option.id}
                      className={cx(showDivider && "has-divider")}
                    >
                      <button
                        ref={(node) => {
                          if (node) optionRefs.current.set(option.id, node);
                          else optionRefs.current.delete(option.id);
                        }}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={isCurrent}
                        className={cx(
                          "settings-theme-option",
                          isCurrent && "is-current",
                          isActive && "is-active",
                        )}
                        onMouseEnter={() => setActiveId(option.id)}
                        onClick={() => choose(option.id)}
                      >
                        <span className="settings-theme-option-copy">
                          <span className="settings-theme-option-title">
                            {option.title}
                          </span>
                          {option.hint ? (
                            <span className="settings-theme-option-hint">
                              {option.hint}
                            </span>
                          ) : null}
                        </span>
                        {isCurrent ? (
                          <IconCheck
                            size={14}
                            className="settings-theme-check"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                      {showDivider ? (
                        <span className="settings-theme-divider" aria-hidden />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </AnchoredMenu>
      </div>
    </div>
  );
}
