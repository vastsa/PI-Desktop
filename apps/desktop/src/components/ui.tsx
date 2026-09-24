import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import {
  portalToBody,
  visiblePortalContent,
} from "../lib/portal-visibility";

import { IconEye, IconEyeOff, IconHelp } from "./icons";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const OVERLAY_ROOT_ID = "pi-desktop-overlays";

function overlayRoot(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing instanceof HTMLElement) return existing;
  const root = document.createElement("div");
  root.id = OVERLAY_ROOT_ID;
  document.documentElement.appendChild(root);
  return root;
}

/** Mount a modal overlay on a viewport-fixed host so a transformed ancestor cannot trap `position: fixed`. */
export function portalOverlay(node: ReactNode) {
  return typeof document === "undefined"
    ? node
    : createPortal(visiblePortalContent(node), overlayRoot());
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}
// A detached anchor (a row that just left the list, a popover that closed)
// can never fire pointerleave, so the visible tooltip checks whether its
// anchor is still in the document and closes itself when it is not.
const ANCHOR_RECONNECT_GRACE_MS = 250;

// Only one themed tooltip may be on screen at once: a pointer moving between
// two adjacent buttons can otherwise paint both during the swap.
type TooltipSlot = {
  slotId: symbol;
  hide: () => void;
  anchor: HTMLElement | null;
  /* True only while the trigger is hovered, so a keyboard-revealed tooltip is
     never closed by an unrelated mouse movement. */
  hovered: boolean;
};

let visibleTooltip: TooltipSlot | null = null;

function claimTooltipSlot(slot: TooltipSlot) {
  if (visibleTooltip && visibleTooltip.slotId !== slot.slotId) {
    visibleTooltip.hide();
  }
  visibleTooltip = slot;
}

function releaseTooltipSlot(slotId: symbol) {
  if (visibleTooltip?.slotId === slotId) visibleTooltip = null;
}

// Guards shared by every mounted tooltip: one listener set for the whole
// window instead of one per trigger. A hidden document only closes the
// tooltip, so the same watch turning visible again never keeps it up.
let installedTooltipGuards = false;

function ensureTooltipGuards() {
  if (installedTooltipGuards) return;
  installedTooltipGuards = true;
  window.addEventListener("blur", () => visibleTooltip?.hide());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) visibleTooltip?.hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") visibleTooltip?.hide();
  });
  document.addEventListener(
    "pointermove",
    (event) => {
      const tooltip = visibleTooltip;
      // A tooltip revealed by keyboard focus has no pointer to follow.
      if (!tooltip?.hovered || !tooltip.anchor) return;
      const anchor = tooltip.anchor;
      if (anchor.contains(event.target as Node)) return;
      // Chromium keeps :hover on the element under an idle pointer, so a
      // pointer that never left the window is not a leave event.
      if (anchor.matches(":hover")) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 4;
      const inside =
        event.clientX >= rect.left - margin &&
        event.clientX <= rect.right + margin &&
        event.clientY >= rect.top - margin &&
        event.clientY <= rect.bottom + margin;
      if (!inside) tooltip.hide();
    },
    true,
  );
}

type TooltipPosition = { left: number; top: number; bottom: number };

function useTooltip<T extends HTMLElement>(
  label: string,
  disabled: boolean,
  delayMs: number,
  showWhenDisabled: boolean,
  hideDelayMs: number,
) {
  const anchorRef = useRef<T>(null);
  // Stable identity for the single-visible-tooltip registry, so a render that
  // re-creates the hide callback still owns the same slot.
  const slotIdRef = useRef<symbol | null>(null);
  if (slotIdRef.current === null) slotIdRef.current = Symbol("ui-tooltip");
  const slotId = slotIdRef.current;
  const showTimerRef = useRef<number | null>(null);

  const hideTimerRef = useRef<number | null>(null);
  const visibleRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  // Mirrors `hovered` for the shared pointer guard, which runs outside React.
  const hoveredRef = useRef(false);
  const setHoveredState = (next: boolean) => {
    hoveredRef.current = next;
    setHovered(next);
  };
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const active =
    Boolean(label) &&
    (hovered || focused) &&
    !dismissed &&
    (showWhenDisabled || !disabled);

  const hide = () => {
    // A hide from any source - leaving the trigger, Escape, a window blur -
    // also cancels a show that has not painted yet, so nothing appears after.
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    releaseTooltipSlot(slotId);
    setTooltipVisible(false);
  };

  const setTooltipVisible = (next: boolean) => {
    if (next === visibleRef.current) return;
    visibleRef.current = next;
    if (next) {
      claimTooltipSlot({
        slotId,
        hide,
        anchor: anchorRef.current,
        hovered: hoveredRef.current,
      });
    } else {
      releaseTooltipSlot(slotId);
    }
    setVisible(next);
  };

  const dismiss = () => {
    setDismissed(true);
    if (visibleRef.current) setTooltipVisible(false);
  };


  // Hover/focus arms the show timer; leaving disarms it and hides a painted
  // tooltip after the short grace window so a pass-between-children does not
  // blink it.
  useEffect(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    if (active) {
      if (!visibleRef.current) {
        showTimerRef.current = window.setTimeout(() => {
          showTimerRef.current = null;
          setTooltipVisible(true);
        }, Math.max(0, delayMs));
      }
    } else if (visibleRef.current) {
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setTooltipVisible(false);
      }, Math.max(0, hideDelayMs));
    }

    return () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [active, delayMs, hideDelayMs]);

  // Tooltips must not outlive their trigger: drop any pending show/hide timer,
  // release the shared slot, and never leave a painted tooltip behind. The
  // shared guards (window blur, a hidden document, Escape, a pointer that left
  // its trigger) are installed once and close whatever is on screen.
  useEffect(() => {
    ensureTooltipGuards();
    return () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      visibleRef.current = false;
      releaseTooltipSlot(slotId);
    };
  }, []);

  // A disabled trigger drops its hover/focus state instead of keeping a
  // tooltip latched on a control the pointer can no longer enter.
  useEffect(() => {
    if (!disabled) return;
    setHoveredState(false);
    setFocused(false);
    if (visibleRef.current) setTooltipVisible(false);
  }, [disabled]);


  // Keep the painted tooltip attached to a live anchor. A detached anchor
  // closes it unless the same node is re-inserted within the grace window
  // (list re-orders remount rows without the pointer ever moving).
  useEffect(() => {
    if (!visible) return;
    const anchor = anchorRef.current;
    if (!anchor) {
      setTooltipVisible(false);
      return;
    }
    let wasConnected = anchor.isConnected;
    let disconnectedAt = wasConnected ? 0 : performance.now();
    if (!wasConnected) setTooltipVisible(false);
    const interval = window.setInterval(() => {
      const connected = anchor.isConnected;
      if (connected === wasConnected) return;
      wasConnected = connected;
      if (connected) {
        if (performance.now() - disconnectedAt <= ANCHOR_RECONNECT_GRACE_MS) {
          setTooltipVisible(true);
        }
        return;
      }
      disconnectedAt = performance.now();
      setTooltipVisible(false);
    }, 200);
    return () => {
      window.clearInterval(interval);
    };
  }, [visible]);


  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
        bottom: rect.bottom + 8,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [visible]);

  return {
    anchorRef,
    open: visible,
    position,
    onPointerEnter: () => {
      setDismissed(false);
      setHoveredState(true);
    },
    onPointerLeave: () => setHoveredState(false),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    dismiss,
  };
}

function PortalTooltip({
  label,
  position,
  className,
}: {
  label: string;
  position: TooltipPosition;
  className?: string;
}) {
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState({ left: position.left, below: false });

  useLayoutEffect(() => {
    const rect = tooltipRef.current?.getBoundingClientRect();
    if (!rect) return;
    const halfWidth = rect.width / 2;
    const minLeft = halfWidth + 8;
    const maxLeft = window.innerWidth - halfWidth - 8;
    setLayout({
      left: Math.min(Math.max(position.left, minLeft), Math.max(minLeft, maxLeft)),
      below: position.top - rect.height < 8,
    });
  }, [className, label, position.left, position.top]);

  return portalToBody(
    <span
      ref={tooltipRef}
      className={cx("ui-tooltip", className)}
      role="tooltip"
      style={{
        left: layout.left,
        top: layout.below ? position.bottom : position.top,
        transform: layout.below ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
    >
      {label}
    </span>,
  );
}

export function Tooltip({
  label,
  children,
  className,
  ariaLabel,
  disabled = false,
  delayMs = 300,
  hideDelayMs = 100,
  tooltipClassName,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  delayMs?: number;
  hideDelayMs?: number;
  tooltipClassName?: string;
}) {
  const tooltip = useTooltip<HTMLSpanElement>(
    label,
    disabled,
    delayMs,
    false,
    hideDelayMs,
  );
  return (
    <>
      <span
        ref={tooltip.anchorRef}
        className={className}
        tabIndex={0}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerLeave={tooltip.onPointerLeave}
        onFocus={tooltip.onFocus}
        onBlur={tooltip.onBlur}
      >
        {children}
      </span>
      {tooltip.open && tooltip.position ? (
        <PortalTooltip
          label={label}
          position={tooltip.position}
          className={tooltipClassName}
        />
      ) : null}
    </>
  );
}

export type TooltipButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children" | "title"
> & {
  tooltip: string;
  children?: ReactNode;
  ariaLabel?: string;
  tooltipDelayMs?: number;
  tooltipHideDelayMs?: number;
  tooltipClassName?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function TooltipButton({
  tooltip: label,
  ariaLabel,
  children,
  className,
  disabled = false,
  tooltipDelayMs = 300,
  tooltipHideDelayMs = 100,
  tooltipClassName,
  ref,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  onClick,
  ...buttonProps
}: TooltipButtonProps) {
  const tooltip = useTooltip<HTMLButtonElement>(
    label,
    disabled,
    tooltipDelayMs,
    true,
    tooltipHideDelayMs,
  );
  return (
    <>
      <button
        {...buttonProps}
        ref={(node) => {
          tooltip.anchorRef.current = node;
          setRef(ref, node);
        }}
        className={className}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onPointerEnter={(event) => {
          tooltip.onPointerEnter();
          onPointerEnter?.(event);
        }}
        onPointerLeave={(event) => {
          tooltip.onPointerLeave();
          onPointerLeave?.(event);
        }}
        onPointerDown={(event) => {
          tooltip.dismiss();
          onPointerDown?.(event);
        }}
        onFocus={(event) => {
          tooltip.onFocus();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          tooltip.onBlur();
          onBlur?.(event);
        }}
        onClick={(event) => {
          tooltip.dismiss();
          onClick?.(event);
        }}
      >
        {children}
      </button>
      {tooltip.open && tooltip.position ? (
        <PortalTooltip
          label={label}
          position={tooltip.position}
          className={tooltipClassName}
        />
      ) : null}
    </>
  );
}

/**
 * The one affordance for "there is an explanation here": the sentence itself
 * lives in the tooltip, and this icon is the only trace of it left in the
 * layout (D601). It is a real button, so a keyboard reaches the same text a
 * pointer hovers, and its accessible name is that sentence.
 */
export function HelpIcon({
  label,
  className,
}: {
  /** The explanation, revealed on hover/focus and used as the name. */
  label: string;
  className?: string;
}) {
  return (
    <TooltipButton
      type="button"
      className={cx("ui-help-icon", className)}
      tooltip={label}
      tooltipClassName="ui-tooltip-help"
      ariaLabel={label}
    >
      <IconHelp size={13} />
    </TooltipButton>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  /* React 19 passes ref as a plain prop; an anchored menu needs the element. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      className={cx(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "secondary" && "btn-secondary",
        variant === "ghost" && "btn-ghost",
        size === "sm" && "px-2.5 py-1 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  spellCheck = false,
  autoCorrect = "off",
  autoCapitalize = "off",
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cx("field-input", className)}
      spellCheck={spellCheck}
      autoCorrect={autoCorrect}
      autoCapitalize={autoCapitalize}
      {...props}
    />
  );
}

export function PasswordInput({
  showLabel,
  hideLabel,
  className,
  disabled,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  /** Localized `aria-label` for the reveal control; the caller passes `t(...)`. */
  showLabel: string;
  hideLabel: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="password-input">
      <Input
        {...props}
        className={className}
        disabled={disabled}
        type={revealed ? "text" : "password"}
      />
      <button
        type="button"
        className="password-input-toggle"
        aria-label={revealed ? hideLabel : showLabel}
        aria-pressed={revealed}
        disabled={disabled}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <IconEyeOff /> : <IconEye />}
      </button>
    </span>
  );
}

export function Textarea({ className, spellCheck = false, autoCorrect = "off", autoCapitalize = "off", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx("field-textarea", className)}
      spellCheck={spellCheck}
      autoCorrect={autoCorrect}
      autoCapitalize={autoCapitalize}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("field-select", className)} {...props} />;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <div className="text-sm text-text-secondary">
        {label}
        {hint ? <HelpIcon label={hint} /> : null}
      </div>
      {children}
    </label>
  );
}

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("panel-card", className)}>{children}</div>;
}

export function SettingsToggle({
  checked,
  label,
  busy,
  disabled,
  className,
  onChange,
}: {
  checked: boolean;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className={cx("settings-toggle", checked && "on", busy && "is-busy", className)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onChange}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  role = "radiogroup",
  className,
  itemClassName,
  itemIdPrefix,
  itemAriaControls,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly {
    readonly value: T;
    readonly label: ReactNode;
    readonly id?: string;
    readonly controls?: string;
  }[];
  label: string;
  role?: "group" | "radiogroup" | "tablist";
  className?: string;
  itemClassName?: string;
  /** Stable prefix for tab item ids when the control owns tab panels. */
  itemIdPrefix?: string;
  /** Optional panel relationship for tab items. */
  itemAriaControls?: (value: T) => string | undefined;
  disabled?: boolean;
}) {
  const itemRole = role === "tablist" ? "tab" : role === "radiogroup" ? "radio" : undefined;
  return (
    <div
      className={cx("settings-segment", className)}
      role={role}
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...(itemRole === "tab"
            ? {
                role: "tab",
                id: option.id ?? `${itemIdPrefix ?? label}-tab-${option.value}`,
                "aria-controls": option.controls ?? itemAriaControls?.(option.value),
                "aria-selected": value === option.value,
              }
            : itemRole === "radio"
              ? { role: "radio", "aria-checked": value === option.value }
              : { "aria-pressed": value === option.value })}
          className={cx(
            "settings-segment-item",
            value === option.value && "active",
            itemClassName,
          )}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}


export function Checkbox({
  label,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
}) {
  return (
    <label className={cx("ui-checkbox", className)}>
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}


export function CheckboxGroup<T extends string>({
  values,
  onChange,
  options,
  label,
  disabled,
  className,
  itemClassName,
  minSelected = 0,
}: {
  /** Currently selected values. */
  values: readonly T[];
  /** Called with the full updated selection. */
  onChange: (values: T[]) => void;
  options: readonly { readonly value: T; readonly label: ReactNode }[];
  /** Accessible group label. */
  label: string;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
  /** Prevent unchecking below this count (default 0 = no minimum). */
  minSelected?: number;
}) {
  const toggle = (value: T) => {
    const on = !values.includes(value);
    const next = on
      ? [...values, value]
      : values.filter((v) => v !== value);
    if (next.length < minSelected) return;
    onChange(next);
  };

  return (
    <div
      className={cx("settings-segment", className)}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const selected = values.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            className={cx(
              "settings-segment-item",
              selected && "active",
              itemClassName,
            )}
            disabled={disabled}
            onClick={() => toggle(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  style,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "error" | "warning";
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cx(
        "badge",
        tone === "neutral" && "badge-neutral",
        tone === "success" && "badge-success",
        tone === "error" && "badge-error",
        tone === "warning" && "badge-warning",
        className,
      )}
      style={style}
    >
      {children}
    </span>
  );
}
