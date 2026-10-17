import type { DetailsHTMLAttributes, ReactNode } from "react";
import { cx } from "../ui";
import { IconChevronDown } from "../icons";

/** Native disclosure: keyboard semantics and hidden-content focus stay browser-owned. */
export function SettingsDisclosure({
  title,
  className,
  children,
  ...props
}: Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "title"> & {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className={cx("settings-disclosure", className)} {...props}>
      <summary>
        <span>{title}</span>
        <IconChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  );
}
