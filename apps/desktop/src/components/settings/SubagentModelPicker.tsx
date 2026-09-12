/**
 * Searchable model menu for a subagent definition.
 *
 * A definition may pin any configured model, so this field can offer every
 * model of every configured provider — tens of rows on a real install. A native
 * `<select>` renders that list at the OS level: it cannot be filtered, has no
 * scroll bound, and a long list simply runs off the window instead of scrolling
 * inside itself. This follows the default-model picker and the service picker:
 * an anchored menu, a local search field, and a scroll-bounded grouped list.
 * Filtering never talks to the host.
 *
 * The surface reuses the `provider-service-*` option-menu styles on purpose:
 * all three pickers are the same control, and one definition of it means a
 * design change reaches them together.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx, Input } from "../ui";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import type { SubagentModelChoiceGroup } from "./subagent-models";

type ModelMenuRow = {
  /** Pin value; the empty string is inherit-session. */
  id: string;
  /** Text shown on the row: a model id, or the inherit label. */
  label: string;
  /** Provider this row belongs to; empty for inherit and orphan pins. */
  groupName: string;
  /** True on a group's first row, which draws the provider header. */
  startsGroup: boolean;
  /** True when that header needs the divider spacing above it. */
  divided: boolean;
};

export function SubagentModelPicker({
  value,
  groups,
  orphanPin,
  disabled = false,
  onChange,
}: {
  /** Current pin, or the empty string for inherit-session. */
  value: string;
  groups: readonly SubagentModelChoiceGroup[];
  /** A pin that is no longer configured, kept selectable so an edit cannot drop it. */
  orphanPin: string | null;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(value);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const rows = useMemo<ModelMenuRow[]>(() => {
    const list: ModelMenuRow[] = [
      {
        id: "",
        label: t("extensions.subagents.modelInherit"),
        groupName: "",
        startsGroup: false,
        divided: false,
      },
    ];
    groups.forEach((group, groupIndex) => {
      group.choices.forEach((choice, index) => {
        list.push({
          id: choice.value,
          label: choice.modelId,
          groupName: group.providerName,
          startsGroup: index === 0,
          divided: groupIndex > 0 && index === 0,
        });
      });
    });
    if (orphanPin) {
      list.push({
        id: orphanPin,
        label: orphanPin,
        groupName: "",
        startsGroup: false,
        divided: false,
      });
    }
    return list;
  }, [groups, orphanPin, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    // The provider name is part of the haystack so "opencode" narrows to that
    // provider's models without the user knowing a model id.
    return rows.filter((row) =>
      `${row.groupName} ${row.label}`.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const visibleIds = useMemo(() => visible.map((row) => row.id), [visible]);

  useEffect(() => {
    setActiveId((current) =>
      visibleIds.includes(current) ? current : (visibleIds[0] ?? ""),
    );
  }, [visibleIds]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (id: string) => {
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

  const selected = rows.find((row) => row.id === value) ?? null;
  const triggerLabel = selected?.label ?? value;

  return (
    <AnchoredMenu
      className="provider-service-anchor"
      open={open}
      onClose={close}
      menuClassName="provider-service-menu"
      label={t("extensions.subagents.model")}
      initialFocus="input"
      trigger={(ref) => (
        <button
          ref={ref}
          type="button"
          className="field-select provider-service-trigger"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t("extensions.subagents.model")}
          onClick={() => {
            setQuery("");
            setActiveId(value);
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
          placeholder={t("extensions.subagents.modelSearch")}
          aria-label={t("extensions.subagents.modelSearch")}
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
              // The empty string is a real option (inherit), so this cannot be
              // a truthiness test.
              if (visibleIds.includes(activeId)) choose(activeId);
            }
          }}
        />
      </div>
      <div className="provider-service-results" role="presentation">
        {visible.length === 0 ? (
          <div className="provider-service-no-results">
            {t("extensions.subagents.modelNoMatches")}
          </div>
        ) : null}
        <ul className="provider-service-list">
          {visible.map((row) => {
            const isCurrent = row.id === value;
            const isActive = row.id === activeId;
            return (
              <li key={row.id || "__inherit__"}>
                {row.startsGroup ? (
                  <div
                    className={cx(
                      "provider-service-group",
                      row.divided && "has-divider",
                    )}
                  >
                    {row.groupName}
                  </div>
                ) : null}
                <button
                  ref={(node) => {
                    if (node) optionRefs.current.set(row.id, node);
                    else optionRefs.current.delete(row.id);
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
                  onMouseEnter={() => setActiveId(row.id)}
                  onClick={() => choose(row.id)}
                >
                  <span className="provider-service-option-check" aria-hidden>
                    {isCurrent ? <IconCheck size={12} /> : null}
                  </span>
                  <span className="provider-service-option-label font-mono">
                    {row.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </AnchoredMenu>
  );
}
