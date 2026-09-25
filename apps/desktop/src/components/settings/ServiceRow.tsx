/**
 * One row of the AI service list (D625): an API service, a plugin-declared
 * service or a vendor subscription account.
 *
 * The row itself is the way in — a click or Enter opens its editor — so the
 * only controls left on it are the enable switch and one overflow menu. The
 * click lives on the row element rather than on a button so a card drag still
 * starts anywhere on the card, and the reorder hook's click capture swallows
 * the click a drag ends in.
 */
import { Fragment, useRef, useState, type HTMLAttributes, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPublic } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, SettingsToggle, cx } from "../ui";
import { CapabilityRowMenu, type CapabilityMenuItem } from "./AgentCapabilityLayout";
import { ServiceMonogram } from "./ServiceMonogram";
import {
  serviceRowBadges,
  serviceRowKind,
  serviceRowMeta,
  serviceRowTitle,
} from "./service-row-status";
import type { AccountEntry } from "./useVendorAccounts";

/** Presses on these act on their own and never open the row. */
const OWN_CONTROLS = "button, input, select, textarea, a, label, .model-provider-key-entry";

export type ServiceRowProps = {
  provider: ProviderPublic;
  entry: AccountEntry | null;
  isDefault: boolean;
  /** Mid-request (saving, testing, removing): the row starts nothing new. */
  busy: boolean;
  testing: boolean;
  dragging: boolean;
  menuItems: readonly CapabilityMenuItem[];
  menuOpen: boolean;
  /** Any row's menu, so the press that dismisses it does not also open a row. */
  anyMenuOpen: boolean;
  restoreMenuFocus: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Absent when there is nothing to open, e.g. a plugin service without a key. */
  onOpen?: () => void;
  onToggleEnabled: () => void;
  keyEntryOpen: boolean;
  onSaveKey: (value: string) => void;
  onCloseKeyEntry: () => void;
  rowRef: Ref<HTMLLIElement>;
  reorderEvents: HTMLAttributes<HTMLLIElement>;
};

export function ServiceRow({
  provider,
  entry,
  isDefault,
  busy,
  testing,
  dragging,
  menuItems,
  menuOpen,
  anyMenuOpen,
  restoreMenuFocus,
  onMenuOpenChange,
  onOpen,
  onToggleEnabled,
  keyEntryOpen,
  onSaveKey,
  onCloseKeyEntry,
  rowRef,
  reorderEvents,
}: ServiceRowProps) {
  const { t } = useTranslation();
  const kind = serviceRowKind(provider);
  const title = serviceRowTitle(provider, entry, t);
  const badges = serviceRowBadges(provider, { isDefault, entry }, t);
  const meta = serviceRowMeta(provider, t);
  // Read at pointerdown, before the outside press has closed the menu.
  const menuWasOpen = useRef(false);
  const { onPointerDown, onClickCapture, onKeyDown, ...reorderAttributes } = reorderEvents;

  return (
    <li
      {...reorderAttributes}
      ref={rowRef}
      className={cx(
        "model-provider-row",
        !provider.enabled && "is-disabled",
        dragging && "is-dragging",
        menuOpen && "menu-open",
        onOpen && "is-openable",
      )}
      data-provider-id={provider.id}
      aria-label={t(onOpen ? "settings.serviceRowLabel" : "settings.reorderProvider", {
        name: title.label,
      })}
      tabIndex={onOpen ? 0 : reorderAttributes.tabIndex}
      aria-disabled={onOpen ? busy : reorderAttributes["aria-disabled"]}
      onPointerDown={(event) => {
        // The menu is portaled, but its React events still bubble through here.
        if (!event.currentTarget.contains(event.target as Node)) return;
        menuWasOpen.current = anyMenuOpen;
        if ((event.target as Element).closest(".model-provider-key-entry")) return;
        onPointerDown?.(event);
      }}
      onClickCapture={(event) => {
        if (event.currentTarget.contains(event.target as Node)) onClickCapture?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter") return;
        if (event.target !== event.currentTarget || !onOpen || busy) return;
        event.preventDefault();
        onOpen();
      }}
      onClick={(event) => {
        const dismissedMenu = menuWasOpen.current;
        menuWasOpen.current = false;
        if (!onOpen || busy || dismissedMenu) return;
        const target = event.target as Element;
        if (!event.currentTarget.contains(target)) return;
        const control = target.closest(OWN_CONTROLS);
        if (control && event.currentTarget.contains(control)) return;
        onOpen();
      }}
    >
      <ServiceMonogram name={title.name} />
      <div className="model-provider-row-copy">
        <div className="model-provider-row-title">
          <span className="model-provider-row-name">{title.name}</span>
          {title.account ? (
            <>
              <span className="model-provider-meta-dot" aria-hidden>
                ·
              </span>
              <span className="model-provider-row-account">{title.account}</span>
            </>
          ) : null}
          {badges.map((badge) =>
            badge.title ? (
              <span key={badge.key} title={badge.title}>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </span>
            ) : (
              <Badge key={badge.key} tone={badge.tone}>
                {badge.label}
              </Badge>
            ),
          )}
          {testing ? (
            <span className="model-provider-row-testing" role="status">
              {t("settings.testing")}
            </span>
          ) : null}
        </div>
        <div className="model-provider-row-meta">
          {meta.map((part, index) => (
            <Fragment key={index}>
              {index > 0 ? (
                <span className="model-provider-meta-dot" aria-hidden>
                  ·
                </span>
              ) : null}
              <span>{part}</span>
            </Fragment>
          ))}
        </div>
      </div>

      <div className="model-provider-row-actions">
        {/* A plugin refreshes its row from its manifest on every load, so the
            switch is not the user's to flip; an account has none at all. */}
        {kind !== "account" ? (
          <SettingsToggle
            checked={provider.enabled}
            label={t("settings.enabledToggle")}
            disabled={busy || kind === "plugin"}
            onChange={onToggleEnabled}
          />
        ) : null}
        <CapabilityRowMenu
          label={t("settings.serviceRowActions", { name: title.label })}
          items={menuItems}
          open={menuOpen}
          disabled={busy}
          restoreFocus={restoreMenuFocus}
          onOpenChange={onMenuOpenChange}
        />
      </div>

      {keyEntryOpen ? (
        <PluginKeyEntry
          hasSecret={provider.hasSecret}
          busy={busy}
          onSave={onSaveKey}
          onCancel={onCloseKeyEntry}
        />
      ) : null}
    </li>
  );
}

/**
 * The key a plugin-declared service asks for. The plugin owns every other
 * field, so this is the one credential the user supplies.
 */
function PluginKeyEntry({
  hasSecret,
  busy,
  onSave,
  onCancel,
}: {
  hasSecret: boolean;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  // Saving an empty value removes the stored key, which only the explicit
  // button may do; Enter in an empty field does nothing.
  const canSave = !busy && value.trim() !== "";
  return (
    <div className="model-provider-key-entry">
      <Field label={t("settings.pluginProviderKey")} hint={t("settings.pluginProviderKeyHint")}>
        <Input
          type="password"
          autoFocus
          value={value}
          placeholder={hasSecret ? t("settings.apiKeyKeepHint") : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
            if (event.key === "Enter" && canSave) onSave(value);
          }}
        />
      </Field>
      <div className="model-provider-key-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("settings.cancel")}
        </Button>
        {hasSecret ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave("")}>
            {t("settings.pluginProviderKeyRemove")}
          </Button>
        ) : null}
        <Button size="sm" disabled={!canSave} onClick={() => onSave(value)}>
          {t("settings.save")}
        </Button>
      </div>
    </div>
  );
}
