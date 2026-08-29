import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ModelInfo } from "@pi-desktop/shared";
import { IconCheck, IconChevronDown, IconImage, IconSearch } from "../icons";
import { cx } from "../ui";

type MenuPosition = { top: number; left: number; width: number };

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;

function compactContextWindow(value?: number): string | null {
  if (!value) return null;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function ModelMultiSelect({
  models,
  selectedIds,
  customModelIds,
  loading = false,
  placeholder,
  selectedLabel,
  searchPlaceholder,
  noMatchesHint,
  emptyHint,
  fetchingLabel,
  customLabel,
  reasoningLabel,
  visionLabel,
  attachmentsLabel,
  toolsLabel,
  structuredOutputLabel,
  temperatureLabel,
  onToggle,
}: {
  models: ModelInfo[];
  selectedIds: string[];
  customModelIds: string[];
  loading?: boolean;
  placeholder: string;
  selectedLabel: (count: number) => string;
  searchPlaceholder: string;
  noMatchesHint: string;
  emptyHint: string;
  fetchingLabel: string;
  customLabel: string;
  reasoningLabel: string;
  visionLabel: string;
  attachmentsLabel: string;
  toolsLabel: string;
  structuredOutputLabel: string;
  temperatureLabel: string;
  onToggle: (model: ModelInfo) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selected = new Set(selectedIds);
  const custom = new Set(customModelIds);
  const filtered = models.filter((model) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      model.modelId.toLowerCase().includes(needle) ||
      model.displayName.toLowerCase().includes(needle)
    );
  });

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    setQuery("");
  }, []);
  const closeAndRestoreFocus = useCallback(() => {
    close();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [close]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - menu.getBoundingClientRect().height - VIEWPORT_MARGIN,
    );
    const below = rect.bottom + MENU_GAP;
    const above = rect.top - menu.getBoundingClientRect().height - MENU_GAP;
    const top =
      below <= maxTop
        ? below
        : above >= VIEWPORT_MARGIN
          ? above
          : Math.min(Math.max(VIEWPORT_MARGIN, below), maxTop);
    setPosition({ top, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeAndRestoreFocus();
      }
    };
    const onScroll = (event: Event) => {
      // The option list is scrollable inside the portaled menu. Keep the
      // picker open while that list moves; dismiss only when an outside
      // container scrolls and the trigger would otherwise be left behind.
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [close, closeAndRestoreFocus, open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [filtered.length, open, updatePosition]);

  const menu = open ? (
    <div
      ref={menuRef}
      className={cx("provider-model-multi-menu", position && "is-open")}
      style={
        position
          ? {
              top: `${position.top}px`,
              left: `${position.left}px`,
              width: `${position.width}px`,
            }
          : undefined
      }
    >
      <div className="provider-model-search-wrap">
        <IconSearch size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          className="provider-model-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          aria-autocomplete="list"
          aria-controls={listId}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div
        className="provider-model-multi-list"
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        aria-label={selected.size > 0 ? selectedLabel(selected.size) : placeholder}
      >
        {loading ? (
          <div className="provider-model-empty">{fetchingLabel}</div>
        ) : filtered.length === 0 ? (
          <div className="provider-model-empty">
            {models.length === 0 ? emptyHint : noMatchesHint}
          </div>
        ) : (
          filtered.map((model) => {
            const isSelected = selected.has(model.modelId);
            const isCustom = custom.has(model.modelId) || model.source === "user";
            const context = compactContextWindow(model.contextWindow);
            const modalitySummary = model.modalities
              ? `${model.modalities.input.join(",")} → ${model.modalities.output.join(",")}`
              : null;
            const supportsVision = model.capabilities.includes("vision");
            const capabilitySummary = [
              model.reasoning ? reasoningLabel : undefined,
              model.capabilities.includes("attachments") ? attachmentsLabel : undefined,
              model.capabilities.includes("tools") ? toolsLabel : undefined,
              model.capabilities.includes("json") ? structuredOutputLabel : undefined,
              model.capabilities.includes("temperature") ? temperatureLabel : undefined,
            ].filter(Boolean).join(" · ");
            return (
              <button
                key={model.modelId}
                type="button"
                role="option"
                aria-selected={isSelected}
                title={model.modelId}
                className={cx("provider-model-multi-option", isSelected && "selected")}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onToggle(model);
                }}
              >
                <span className={cx("provider-model-check", isSelected && "checked")}>
                  {isSelected ? <IconCheck size={12} /> : null}
                </span>
                <span className="provider-model-multi-id font-mono">{model.modelId}</span>
                {isCustom ? <span className="provider-model-custom-badge">{customLabel}</span> : null}
                <span className="provider-model-multi-meta">
                  {context ? `${context} · ` : ""}
                  {modalitySummary ? `${modalitySummary} · ` : ""}
                  {capabilitySummary}
                </span>
                {supportsVision ? (
                  <span className="provider-model-capability-badge" title={visionLabel}>
                    <IconImage size={12} aria-hidden="true" />
                    <span className="sr-only">{visionLabel}</span>
                  </span>
                ) : null}
                {model.modalities?.input.includes("pdf") ? (
                  <span className="provider-model-capability-badge" title="PDF">
                    <span aria-hidden="true">PDF</span>
                    <span className="sr-only">PDF</span>
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="provider-model-multi" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={cx("provider-model-multi-trigger", open && "is-open")}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cx("provider-model-multi-trigger-copy", selected.size === 0 && "placeholder") }>
          {selected.size > 0 ? selectedLabel(selected.size) : placeholder}
        </span>
        {selected.size > 0 ? <span className="provider-model-count">{selected.size}</span> : null}
        <IconChevronDown size={14} aria-hidden="true" />
      </button>
      {typeof document !== "undefined" && menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
