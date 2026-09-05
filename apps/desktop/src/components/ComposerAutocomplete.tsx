import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerCommand } from "@pi-desktop/shared";
import type { AutocompleteItem, useComposerAutocomplete } from "../hooks/use-composer-autocomplete";
import {
  IconFileText,
  IconFolder,
  IconPlug,
  IconSlash,
  IconSparkles,
} from "./icons";

/**
 * Composer autocomplete panel (D123–D125, spec 08 §11.8): full composer
 * width above the input, focus stays in the textarea — rows accept on
 * mousedown so the caret never leaves the draft.
 */

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<span key={`t${at}`}>{text.slice(at, start)}</span>);
    parts.push(
      <span key={`h${start}`} className="composer-ac-hl">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

const GROUP_KEYS: Record<ComposerCommand["kind"], string> = {
  template: "chat.slashGroupTemplates",
  builtin: "chat.slashGroupApp",
  plugin: "chat.slashGroupPlugins",
};

function CommandIcon({ kind }: { kind: ComposerCommand["kind"] }) {
  if (kind === "template") return <IconSlash size={14} />;
  if (kind === "plugin") return <IconPlug size={14} />;
  return <IconSparkles size={14} />;
}

export function ComposerAutocomplete({
  ac,
  onAccept,
}: {
  ac: ReturnType<typeof useComposerAutocomplete>;
  onAccept: (index: number) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ac.open) return;
    listRef.current
      ?.querySelector(`[data-ac-index="${ac.highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [ac.open, ac.highlight]);

  if (!ac.open) return null;

  const renderRow = (item: AutocompleteItem, index: number) => {
    const active = index === ac.highlight;
    const rowClass = `composer-plus-item composer-ac-item ${active ? "kb-active" : ""}`;
    const commonProps = {
      key:
        item.kind === "command"
          ? `c:${item.command.kind}:${item.command.name}`
          : `p:${item.entry.path}`,
      type: "button" as const,
      role: "option" as const,
      "aria-selected": active,
      "data-ac-index": index,
      className: rowClass,
      // Mousedown keeps focus in the textarea (input-retained overlay).
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        onAccept(index);
      },
      onMouseMove: () => ac.setHighlight(index),
    };
    if (item.kind === "command") {
      return (
        <button {...commonProps}>
          <span className="composer-ac-icon">
            <CommandIcon kind={item.command.kind} />
          </span>
          <span className="composer-ac-name">
            /<Highlighted text={item.command.name} ranges={item.match.ranges} />
          </span>
          {item.command.argumentHint ? (
            <span className="composer-ac-hint">{item.command.argumentHint}</span>
          ) : null}
          {item.command.description ? (
            <span className="composer-ac-desc">{item.command.description}</span>
          ) : null}
        </button>
      );
    }
    const isDir = item.entry.kind === "dir";
    const name = item.entry.path.split("/").pop() ?? item.entry.path;
    const displayName = `${name}${isDir ? "/" : ""}`;
    return (
      <button
        {...commonProps}
        aria-label={`${displayName} — ${item.entry.path}`}
        title={item.entry.path}
      >
        <span className="composer-ac-icon">
          {isDir ? <IconFolder size={14} /> : <IconFileText size={14} />}
        </span>
        <span className="composer-ac-name">{displayName}</span>
      </button>
    );
  };

  const rows: React.ReactNode[] = [];
  let lastGroup: string | null = null;
  ac.items.forEach((item, index) => {
    if (item.kind === "command") {
      const group = item.command.kind;
      if (group !== lastGroup) {
        lastGroup = group;
        rows.push(
          <div key={`g:${group}`} className="composer-model-group-label">
            {t(GROUP_KEYS[group])}
          </div>,
        );
      }
    }
    rows.push(renderRow(item, index));
  });

  const emptyKey =
    ac.mode === "file"
      ? ac.noWorkspace
        ? "chat.fileNoWorkspace"
        : "chat.fileEmpty"
      : "chat.slashEmpty";

  return (
    <div
      className="composer-autocomplete"
      role="listbox"
      aria-label={t(ac.mode === "file" ? "chat.fileMenu" : "chat.slashMenu")}
    >
      <div className="composer-ac-list" ref={listRef}>
        {rows.length > 0 ? (
          rows
        ) : (
          <div className="composer-model-empty">{t(emptyKey)}</div>
        )}
      </div>
      <div className="composer-ac-footer">
        <span>{t("chat.acHint")}</span>
        {ac.truncated ? (
          <span className="composer-ac-truncated">{t("chat.fileTruncated")}</span>
        ) : null}
      </div>
    </div>
  );
}
