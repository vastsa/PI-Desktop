/**
 * Language picker for Settings → General → Appearance.
 *
 * Theme stays a three-card grid because those options are visual and fixed.
 * Language is a growing named list, so it uses the same searchable anchored
 * menu as Service: Auto pinned at the top, then shipped locales with native
 * names (endonyms, never translated) and English names for search/sort.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import {
  listedLocales,
  localeInfo,
  type AppLanguageSetting,
  type AppLocale,
} from "@pi-desktop/i18n";
import { cx } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { resolveAppLanguage } from "../../lib/app-language";

type LanguageOption = {
  id: AppLanguageSetting;
  nativeName: string;
  englishName: string | null;
  haystack: string;
};

export function LanguageRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<AppLanguageSetting>(
    settings.language ?? "auto",
  );
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const detected = resolveAppLanguage("auto");
  const detectedInfo = localeInfo(detected);
  const selectedId: AppLanguageSetting = settings.language ?? "auto";
  const autoLabel = t("settings.languageAuto");

  const options = useMemo<LanguageOption[]>(() => {
    const auto: LanguageOption = {
      id: "auto",
      nativeName: autoLabel,
      englishName: t("settings.languageAutoDesc", {
        state: detectedInfo.nativeName,
      }),
      haystack:
        `${autoLabel} auto system ${detectedInfo.nativeName} ${detectedInfo.englishName} ${detectedInfo.id}`.toLowerCase(),
    };
    const locales = listedLocales().map((locale) => ({
      id: locale.id,
      nativeName: locale.nativeName,
      englishName:
        locale.englishName === locale.nativeName ? null : locale.englishName,
      haystack: `${locale.nativeName} ${locale.englishName} ${locale.id}`.toLowerCase(),
    }));
    return [auto, ...locales];
  }, [autoLabel, detectedInfo, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.haystack.includes(needle));
  }, [options, query]);

  const visibleIds = useMemo(() => visible.map((option) => option.id), [visible]);

  useEffect(() => {
    setActiveId((current) =>
      visibleIds.includes(current) ? current : (visibleIds[0] ?? "auto"),
    );
  }, [visibleIds]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  const selected = options.find((option) => option.id === selectedId);
  const triggerLabel =
    selectedId === "auto"
      ? `${autoLabel} · ${detectedInfo.nativeName}`
      : (selected?.nativeName ?? localeInfo(selectedId as AppLocale).nativeName);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (id: AppLanguageSetting) => {
    close();
    if (id === selectedId) return;
    void saveSettings({ language: id });
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
    setActiveId(visibleIds[next] ?? "auto");
  };

  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{t("settings.language")}</div>
        <div className="settings-row-desc">{t("settings.languageDesc")}</div>
      </div>
      <div className="settings-row-control">
        <AnchoredMenu
          className="settings-language-anchor"
          open={open}
          onClose={close}
          menuClassName="settings-language-menu"
          label={t("settings.language")}
          align="end"
          initialFocus="input"
          trigger={(ref) => (
            <button
              ref={ref}
              type="button"
              className="settings-language-trigger"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={t("settings.language")}
              onClick={() => {
                setQuery("");
                setActiveId(selectedId);
                setOpen((current) => !current);
              }}
            >
              <span className="settings-language-trigger-label">{triggerLabel}</span>
              <IconChevronDown size={14} aria-hidden />
            </button>
          )}
        >
          <div className="settings-language-search">
            <IconSearch size={13} aria-hidden />
            <input
              type="text"
              value={query}
              placeholder={t("settings.languageSearchPlaceholder")}
              aria-label={t("settings.languageSearchPlaceholder")}
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
          <div className="settings-language-results">
            {visible.length === 0 ? (
              <div className="settings-language-empty">{t("settings.noResults")}</div>
            ) : (
              <ul className="settings-language-list">
                {visible.map((option, index) => {
                  const isCurrent = option.id === selectedId;
                  const isActive = option.id === activeId;
                  const showDivider =
                    option.id === "auto" &&
                    visible.some((candidate) => candidate.id !== "auto");
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
                          "settings-language-option",
                          isCurrent && "is-current",
                          isActive && "is-active",
                        )}
                        onMouseEnter={() => setActiveId(option.id)}
                        onClick={() => choose(option.id)}
                      >
                        <span className="settings-language-option-copy">
                          <span className="settings-language-option-native">
                            {option.nativeName}
                          </span>
                          {option.englishName ? (
                            <span className="settings-language-option-english">
                              {option.englishName}
                            </span>
                          ) : null}
                        </span>
                        {isCurrent ? (
                          <IconCheck
                            size={14}
                            className="settings-language-check"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                      {index === 0 && showDivider ? (
                        <span className="settings-language-divider" aria-hidden />
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
