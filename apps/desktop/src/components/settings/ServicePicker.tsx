/**
 * Searchable Service menu for the add/edit provider dialog.
 *
 * Native <select> is sluggish in this overlay and cannot filter. This follows
 * the default-model picker: an anchored menu, a local search field, and a
 * flat vendor list. Filtering never talks to the host.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NAMED_ENDPOINT_PRESETS } from "@pi-desktop/shared";
import { cx, Input } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";

export const CUSTOM_SERVICE = "custom";

type ServiceOption = {
  id: string;
  label: string;
  haystack: string;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type ServicePickerProps = {
  value: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onChange: (next: string) => void;
};

export function ServicePicker({
  value,
  autoFocus = false,
  disabled = false,
  onChange,
}: ServicePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(value || CUSTOM_SERVICE);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const customLabel = t("settings.presetCustomEndpoint");
  const options = useMemo<ServiceOption[]>(() => {
    const custom: ServiceOption = {
      id: CUSTOM_SERVICE,
      label: customLabel,
      haystack: `${customLabel} custom endpoint`.toLowerCase(),
    };
    const named = NAMED_ENDPOINT_PRESETS.map((preset) => {
      const label = t(preset.labelKey);
      const aliases = preset.aliases?.join(" ") ?? "";
      return {
        id: preset.id,
        label,
        haystack:
          `${label} ${preset.name} ${preset.id} ${preset.vendorKey} ${aliases} ${preset.baseUrl} ${hostOf(preset.baseUrl)}`.toLowerCase(),
      };
    });
    return [custom, ...named];
  }, [customLabel, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.haystack.includes(needle));
  }, [options, query]);

  const visibleIds = useMemo(() => visible.map((option) => option.id), [visible]);

  useEffect(() => {
    setActiveId((current) =>
      visibleIds.includes(current) ? current : (visibleIds[0] ?? ""),
    );
  }, [visibleIds]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  const selected = options.find((option) => option.id === value);
  const triggerLabel = selected?.label ?? t("settings.chooseService");

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (id: string) => {
    // The next field (API key or Name) takes focus; do not bounce to the trigger.
    setRestoreFocus(false);
    onChange(id);
    close();
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
    setActiveId(visibleIds[next] ?? "");
  };

  return (
    <AnchoredMenu
      className="provider-service-anchor"
      open={open}
      onClose={close}
      menuClassName="provider-service-menu"
      label={t("settings.service")}
      initialFocus="input"
      restoreFocus={restoreFocus}
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className={cx(
            "field-select provider-service-trigger",
            !selected && "is-placeholder",
          )}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (disabled) return;
            setRestoreFocus(true);
            setQuery("");
            setActiveId(value || CUSTOM_SERVICE);
            setOpen((current) => !current);
          }}
        >
          <span className="provider-service-trigger-label">{triggerLabel}</span>
          <IconChevronDown
            className="provider-service-trigger-chevron"
            size={14}
            aria-hidden
          />
        </button>
      )}
    >
      <div className="provider-service-search">
        <IconSearch size={14} aria-hidden />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.searchService")}
          aria-label={t("settings.searchService")}
          autoComplete="off"
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
      <div className="provider-service-results" role="presentation">
        {visible.length === 0 ? (
          <div className="provider-service-no-results">
            {t("settings.noServiceMatches")}
          </div>
        ) : (
          <ul className="provider-service-list">
            {visible.map((option) => {
              const isCurrent = option.id === value;
              const isActive = option.id === activeId;
              return (
                <li key={option.id}>
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
                      "provider-service-option",
                      isCurrent && "is-current",
                      isActive && "is-active",
                    )}
                    onMouseEnter={() => setActiveId(option.id)}
                    onClick={() => choose(option.id)}
                  >
                    <span className="provider-service-option-check" aria-hidden>
                      {isCurrent ? <IconCheck size={12} /> : null}
                    </span>
                    <span className="provider-service-option-label">
                      {option.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AnchoredMenu>
  );
}
