/**
 * A menu select for a Settings row.
 *
 * Settings cards clip their overflow (`.settings-panel` draws the frame with
 * `overflow: hidden`), so the option list opens through `AnchoredMenu`. A
 * native `<select>` draws its popup at the OS level instead: it ignores the
 * menu surface tokens, shows the platform highlight, and has no current-value
 * marker. The closed trigger sizes to the current label (capped by its parent)
 * so a short value does not stretch the settings control column. Rows whose
 * list is short still use this control so one Settings window does not mix two
 * popup implementations.
 *
 * Short lists open on the current option. Model catalogs can opt into search
 * while retaining the same anchored menu and keyboard behavior.
 */
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";

export type MenuSelectOption = {
  id: string;
  label: string;
  /** Listed but not selectable; the host may report an unavailable shell. */
  disabled?: boolean;
};

export function SettingsMenuSelect({
  value,
  options,
  onChange,
  label,
  disabled = false,
  busy = false,
  fullWidth = false,
  className,
  triggerClassName,
  leading,
  searchPlaceholder,
  emptyLabel,
}: {
  value: string;
  options: MenuSelectOption[];
  onChange: (id: string) => void;
  /** Accessible name for the trigger and the menu. */
  label: string;
  disabled?: boolean;
  /** Keeps the trigger non-interactive while a write is in flight. */
  busy?: boolean;
  /** Stretch across a form field. Compact settings rows leave this off. */
  fullWidth?: boolean;
  className?: string;
  /** Optional surface-specific styling while retaining the shared menu behavior. */
  triggerClassName?: string;
  /** Optional icon or marker shown before the selected value. */
  leading?: ReactNode;
  /** Enables filtering for longer option lists such as model catalogs. */
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(value);
  const [query, setQuery] = useState("");
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const current = options.find((option) => option.id === value);
  const visibleOptions = searchPlaceholder && query.trim()
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : options;
  const selectable = visibleOptions.filter((option) => !option.disabled);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (option: MenuSelectOption) => {
    close();
    if (option.disabled || option.id === value) return;
    onChange(option.id);
  };

  const moveActive = (from: string, delta: number) => {
    if (selectable.length === 0) return;
    const index = selectable.findIndex((option) => option.id === from);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : selectable.length - 1
        : (index + delta + selectable.length) % selectable.length;
    const target = selectable[next];
    if (!target) return;
    setActiveId(target.id);
    optionRefs.current.get(target.id)?.focus();
  };

  /* Arrow keys wrap over the selectable rows for parity with the Appearance
     pickers; Home/End and Enter stay with the focused option button. */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveActive(activeId, event.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div className={cx("settings-menu-select-anchor", fullWidth && "is-full", className)}>
      <AnchoredMenu
        open={open}
        onClose={close}
        menuClassName={cx("settings-menu-select-menu", searchPlaceholder && "is-searchable")}
        label={label}
        align="end"
        initialFocus={searchPlaceholder ? "input" : "selected"}
        onMenuKeyDown={onMenuKeyDown}
        trigger={(ref) => (
          <button
            ref={ref}
            type="button"
            className={cx("settings-menu-select-trigger", triggerClassName)}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={label}
            disabled={disabled || busy}
            onClick={() => {
              setActiveId(value);
              if (!open) setQuery("");
              setOpen((current) => !current);
            }}
          >
            {leading ? (
              <span className="settings-menu-select-trigger-leading" aria-hidden="true">
                {leading}
              </span>
            ) : null}
            <span className="settings-menu-select-trigger-label">
              {current?.label ?? value}
            </span>
            <IconChevronDown size={14} aria-hidden />
          </button>
        )}
      >
        {searchPlaceholder ? (
          <div className="settings-menu-select-search">
            <IconSearch size={14} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
        ) : null}
        <div className="settings-menu-select-results">
          {visibleOptions.length === 0 && emptyLabel ? (
            <div className="settings-menu-select-empty">{emptyLabel}</div>
          ) : null}
          <ul className="settings-menu-select-list">
            {visibleOptions.map((option) => {
              const isCurrent = option.id === value;
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
                    disabled={option.disabled}
                    title={option.label}
                    className={cx(
                      "settings-menu-select-option",
                      isCurrent && "is-current",
                      option.id === activeId && "is-active",
                    )}
                    onMouseEnter={() => setActiveId(option.id)}
                    onFocus={() => setActiveId(option.id)}
                    onClick={() => choose(option)}
                  >
                    <span className="settings-menu-select-option-label">
                      {option.label}
                    </span>
                    {isCurrent ? (
                      <IconCheck
                        size={14}
                        className="settings-menu-select-check"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </AnchoredMenu>
    </div>
  );
}
