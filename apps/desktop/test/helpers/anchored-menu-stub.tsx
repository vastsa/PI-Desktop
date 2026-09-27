/**
 * Test double for `AnchoredMenu` (see `components/settings/AnchoredMenu.tsx`).
 *
 * The real component renders its content through a portal, which a static
 * render cannot see. This keeps every prop the panel actually uses — the listbox
 * role, the label, and the rows themselves — while dropping the positioning,
 * focus and outside-click behavior, none of which is what these tests assert.
 */
import type { ReactNode } from "react";

export function AnchoredMenu({
  open,
  children,
  menuClassName,
  label,
  role = "listbox",
  className,
}: {
  open: boolean;
  children?: ReactNode;
  menuClassName?: string;
  label?: string;
  role?: string;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div className={className}>
      <div className={menuClassName} role={role} aria-label={label}>
        {children}
      </div>
    </div>
  );
}
