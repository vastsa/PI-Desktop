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

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
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
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const visibleRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const active =
    Boolean(label) &&
    (hovered || focused) &&
    !dismissed &&
    (showWhenDisabled || !disabled);

  const setTooltipVisible = (next: boolean) => {
    visibleRef.current = next;
    setVisible(next);
  };
  const dismiss = () => {
    setDismissed(true);
    if (visibleRef.current) setTooltipVisible(false);
  };

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

  useEffect(() => {
    if (!disabled) return;
    setHovered(false);
    setFocused(false);
    if (visibleRef.current) setTooltipVisible(false);
  }, [disabled]);


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
      setHovered(true);
    },
    onPointerLeave: () => setHovered(false),
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

  return createPortal(
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
    document.body,
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
      <div className="text-sm text-text-secondary">{label}</div>
      {children}
      {hint ? <div className="text-xs text-text-muted">{hint}</div> : null}
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

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "error" | "warning";
  className?: string;
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
    >
      {children}
    </span>
  );
}
