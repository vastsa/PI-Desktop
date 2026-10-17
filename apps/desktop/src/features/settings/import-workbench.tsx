import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, HelpIcon, cx } from "../../components/ui";
import { IconChevronLeft, IconDownload } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";

/**
 * The only action row on a kind: both counts behind the select-all control,
 * kind options and the two actions on the right. `found` is the kind's own
 * localized sentence, so the row never needs a per-kind copy of itself.
 */
export function ImportToolbar({
  found,
  selectedCount,
  allSelected,
  selectAllLabel,
  onToggleAll,
  scanning,
  importing,
  onScan,
  onImport,
  options,
}: {
  found: string;
  selectedCount: number;
  allSelected: boolean;
  selectAllLabel: string;
  onToggleAll: (on: boolean) => void;
  scanning: boolean;
  importing: boolean;
  onScan: () => void;
  onImport: () => void;
  /** Kind-specific control in front of the actions, e.g. grouping or mode. */
  options?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="import-toolbar">
      <Checkbox
        className="import-select-all"
        checked={allSelected}
        indeterminate={selectedCount > 0 && !allSelected}
        aria-label={selectAllLabel}
        onChange={(event) => onToggleAll(event.target.checked)}
        label={
          <span className="import-count">
            <span className="import-count-found">{found}</span>
            {selectedCount > 0 ? (
              <span className="import-count-selected">
                {t("settings.importSelectedCount", { count: selectedCount })}
              </span>
            ) : null}
          </span>
        }
      />
      <div className="import-toolbar-actions">
        {options}
        <Button
          variant="secondary"
          disabled={scanning}
          aria-busy={scanning || undefined}
          onClick={onScan}
        >
          {scanning ? t("settings.importScanning") : t("settings.importScan")}
        </Button>
        <Button
          variant="primary"
          disabled={importing || selectedCount === 0}
          aria-busy={importing || undefined}
          onClick={onImport}
        >
          {importing
            ? t("settings.importing")
            : t("settings.importSelected", { count: selectedCount })}
        </Button>
      </div>
    </div>
  );
}

/** A labelled menu select inside the toolbar, for grouping or import mode. */
export function ImportOption({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  /** Explains the choice from the label's help icon. */
  hint?: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="import-option">
      <span className="import-option-label">
        {label}
        {hint ? <HelpIcon label={hint} /> : null}
      </span>
      <SettingsMenuSelect
        className="import-option-select"
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </label>
  );
}

/** One group: a quiet label line that also discloses its rows. */
export function ImportGroup({
  bodyId,
  name,
  path,
  count,
  countLabel,
  expanded,
  onToggle,
  selection,
  children,
}: {
  bodyId: string;
  name: string;
  /** Exact project path, or the resolved config path, when the group has one. */
  path?: string | null;
  count: number;
  countLabel: string;
  expanded: boolean;
  onToggle: () => void;
  /** Kinds whose groups are selectable render the leading checkbox. */
  selection?: {
    label: string;
    checked: boolean;
    indeterminate: boolean;
    onChange: (on: boolean) => void;
  };
  children: ReactNode;
}) {
  return (
    <section className="import-group">
      <div className="import-group-header">
        {selection ? (
          <Checkbox
            className="import-group-checkbox"
            checked={selection.checked}
            indeterminate={selection.indeterminate}
            aria-label={selection.label}
            onChange={(event) => selection.onChange(event.target.checked)}
            label=""
          />
        ) : null}
        <button
          type="button"
          className="import-group-toggle"
          aria-controls={bodyId}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span
            className={cx("import-group-chevron", !expanded && "collapsed")}
            aria-hidden
          >
            <IconChevronLeft size={13} />
          </span>
          <span className="import-group-name">{name}</span>
          {path ? (
            <code className="import-group-path" title={path}>
              {path}
            </code>
          ) : null}
          <span className="import-group-count" title={countLabel}>
            {count}
          </span>
        </button>
      </div>
      {expanded ? (
        <div id={bodyId} className="import-group-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One candidate. The checkbox, the identity, and the row's own badge are the
 * whole anatomy, so every kind reads the same way.
 */
export function ImportRow({
  title,
  meta,
  checked,
  onChange,
  badge,
}: {
  title: string;
  meta: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  badge?: ReactNode;
}) {
  return (
    <Checkbox
      className="import-row"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      label={
        <>
          <span className="import-row-main">
            <span className="import-row-title">{title}</span>
            <span className="import-row-meta">{meta}</span>
          </span>
          {badge}
        </>
      }
    />
  );
}

/**
 * Pre-scan state: what the scan will look at, and the action that starts it.
 * Keep the explanation visible so users do not have to discover it in a tooltip.
 */
export function ImportIdle({
  description,
  note,
  onScan,
  scanning,
}: {
  description?: string;
  note?: string;
  onScan: () => void;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  const copy = [description, note].filter(Boolean).join(" · ");
  return (
    <div className="settings-panel import-panel">
      <div className="import-idle">
        <span className="import-idle-glyph" aria-hidden>
          <IconDownload size={20} />
        </span>
        {copy ? <p className="import-idle-description">{copy}</p> : null}
        <Button variant="secondary" disabled={scanning} onClick={onScan}>
          {scanning ? t("settings.importScanning") : t("settings.importScan")}
        </Button>
      </div>
    </div>
  );
}

/** The result surface: rows when a scan found something, a line when it did not. */
export function ImportResults({ message, children }: { message?: string; children?: ReactNode }) {
  return (
    <div className="settings-panel import-panel">
      {message ? <p className="import-empty">{message}</p> : children}
    </div>
  );
}

/**
 * Clears a selection when the underlying candidate set is replaced.
 * `keyOf` stays with the caller so every kind keeps its own identity rule.
 */
export function toggleKey(previous: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(previous);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}


/**
 * Group disclosure. Groups start expanded — the found candidates are the
 * answer to a scan — and every kind's label line discloses its own rows, so all
 * three read the same way.
 */
export function useGroupDisclosure() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return {
    isExpanded: (id: string) => !collapsed.has(id),
    toggle: (id: string) =>
      setCollapsed((previous) =>
        previous.has(id)
          ? new Set([...previous].filter((entry) => entry !== id))
          : new Set([...previous, id]),
      ),
    reset: () => setCollapsed(new Set()),
  };
}

export function groupBySource<C extends { source: string }>(
  candidates: C[],
): Array<{ id: string; items: C[] }> {
  const map = new Map<string, C[]>();
  for (const candidate of candidates) {
    const bucket = map.get(candidate.source);
    if (bucket) bucket.push(candidate);
    else map.set(candidate.source, [candidate]);
  }
  return Array.from(map.entries()).map(([id, items]) => ({ id, items }));
}



export function ImportToggleButton({
  open,
  controls,
  label,
  disabled,
  onClick,
}: {
  open: boolean;
  controls: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="secondary"
      aria-expanded={open}
      aria-controls={controls}
      disabled={disabled}
      onClick={onClick}
    >
      <IconDownload size={14} />
      {label}
    </Button>
  );
}
