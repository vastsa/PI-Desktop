import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { IconCheck, IconChevronDown } from "../../components/icons";

export function ScheduledWeekdaySelect({
  value,
  onChange,
  disabled,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const days = Array.from({ length: 7 }, (_, day) => ({
    day,
    label: new Date(2026, 8, 21 + day).toLocaleDateString(i18n.language, { weekday: "short" }),
  }));
  const selectedLabel = days.filter(({ day }) => value.includes(day)).map(({ label }) => label).join(" · ");
  return (
    <AnchoredMenu
      open={open && !disabled}
      onClose={() => setOpen(false)}
      role="dialog"
      label={t("scheduled.weekday")}
      menuClassName="settings-menu-select-menu scheduled-weekday-menu"
      trigger={(ref) => (
        <button ref={ref} type="button" className="settings-menu-select-trigger scheduled-weekday-trigger"
          aria-label={t("scheduled.weekday")} aria-haspopup="dialog" aria-expanded={open && !disabled}
          disabled={disabled} onClick={() => setOpen((current) => !current)}>
          <span className="settings-menu-select-trigger-label">{selectedLabel || t("scheduled.selectDay")}</span>
          <IconChevronDown size={14} aria-hidden />
        </button>
      )}
      onMenuKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          setOpen(false);
          return;
        }
        const current = [...refs.current].find(([, node]) => node === document.activeElement)?.[0] ?? 0;
        const next = event.key === "ArrowDown" ? (current + 1) % 7
          : event.key === "ArrowUp" ? (current + 6) % 7
          : event.key === "Home" ? 0 : event.key === "End" ? 6 : null;
        if (next !== null) {
          event.preventDefault();
          refs.current.get(next)?.focus();
        }
      }}
    >
      <div className="settings-menu-select-results" role="listbox"
        aria-label={t("scheduled.weekday")} aria-multiselectable="true">
        {days.map(({ day, label }) => (
          <button key={day} ref={(node) => {
            if (node) refs.current.set(day, node);
            else refs.current.delete(day);
          }} type="button" role="option" tabIndex={-1}
            className="settings-menu-select-option scheduled-weekday-option"
            aria-selected={value.includes(day)}
            onClick={() => onChange(value.includes(day)
              ? value.filter((selected) => selected !== day)
              : [...value, day].sort((a, b) => a - b))}>
            <span className="settings-menu-select-option-label">{label}</span>
            <span className="scheduled-day-marker" aria-hidden="true">
              {value.includes(day) && <IconCheck size={10} />}
            </span>
          </button>
        ))}
      </div>
    </AnchoredMenu>
  );
}
