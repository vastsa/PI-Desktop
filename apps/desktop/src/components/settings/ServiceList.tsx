/**
 * The AI service list (D625): API services, plugin-declared services and
 * vendor subscription accounts in one card list with one drag order.
 *
 * The list owns only transient row state — which row's menu or key entry is
 * open and which delete is armed — and hands every write back to the page.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPublic } from "@pi-desktop/shared";
import { IconCopy, IconKey, IconPencil, IconPlug, IconTrash } from "../icons";
import { useArmedDelete, type CapabilityMenuItem } from "./AgentCapabilityLayout";
import { ServiceRow } from "./ServiceRow";
import { serviceRowKind } from "./service-row-status";
import { useProviderReorder } from "./useProviderReorder";
import type { AccountEntry } from "./useVendorAccounts";

export type ServiceListProps = {
  providers: ProviderPublic[];
  accountFor: (providerId: string) => AccountEntry | null;
  /** A page-level write or dialog is in flight; card order is locked meanwhile. */
  busy: boolean;
  isRowBusy: (providerId: string) => boolean;
  isTesting: (providerId: string) => boolean;
  onEdit: (provider: ProviderPublic) => void;
  onTest: (provider: ProviderPublic) => void;
  onCopy: (provider: ProviderPublic) => void;
  onToggleEnabled: (provider: ProviderPublic) => void;
  onRemove: (provider: ProviderPublic) => void;
  /** Resolves true once the key is stored, so its entry can close. */
  onSaveKey: (provider: ProviderPublic, value: string) => Promise<boolean>;
};

export function ServiceList({
  providers,
  accountFor,
  busy,
  isRowBusy,
  isTesting,
  onEdit,
  onTest,
  onCopy,
  onToggleEnabled,
  onRemove,
  onSaveKey,
}: ServiceListProps) {
  const { t } = useTranslation();
  const reorder = useProviderReorder(providers, busy);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // False while the chosen item opens something that takes focus itself.
  const [restoreMenuFocus, setRestoreMenuFocus] = useState(true);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const { armed, setArmed } = useArmedDelete();
  // A row that went away with its menu open must not keep swallowing clicks.
  const openMenuId = reorder.providers.some((provider) => provider.id === menuFor)
    ? menuFor
    : null;

  const closeMenu = (restoreFocus: boolean) => {
    setRestoreMenuFocus(restoreFocus);
    setMenuFor(null);
    setArmed(null);
  };

  const toggleKeyEntry = (provider: ProviderPublic) =>
    setKeyFor((current) => (current === provider.id ? null : provider.id));

  const saveKey = async (provider: ProviderPublic, value: string) => {
    if (await onSaveKey(provider, value)) {
      setKeyFor((current) => (current === provider.id ? null : current));
    }
  };

  const menuItems = (provider: ProviderPublic): CapabilityMenuItem[] => {
    const kind = serviceRowKind(provider);
    const pluginOAuth = kind === "account" && !!provider.ownerPluginId;
    const items: CapabilityMenuItem[] = [];
    // A plugin owns its row's fields and lifetime; only its key is the user's.
    if (kind !== "plugin" && !pluginOAuth) {
      items.push({
        key: "edit",
        label: t(kind === "account" ? "settings.editVendorAccount" : "settings.editProvider"),
        icon: <IconPencil size={14} />,
        onSelect: () => {
          closeMenu(false);
          onEdit(provider);
        },
      });
    }
    items.push({
      key: "test",
      label: t("settings.testConnection"),
      icon: <IconPlug size={14} />,
      onSelect: () => {
        closeMenu(true);
        onTest(provider);
      },
    });
    if (kind === "api") {
      items.push({
        key: "copy",
        label: t("settings.copyProvider"),
        icon: <IconCopy size={14} />,
        onSelect: () => {
          closeMenu(false);
          onCopy(provider);
        },
      });
    }
    if (kind === "plugin" && provider.authKind === "api_key") {
      items.push({
        key: "key",
        label: t("settings.pluginProviderKey"),
        icon: <IconKey size={14} />,
        onSelect: () => {
          closeMenu(false);
          toggleKeyEntry(provider);
        },
      });
    }
    if (kind !== "plugin") {
      const isArmed = armed === provider.id;
      items.push({
        key: "remove",
        label: isArmed
          ? t("settings.capabilityRemoveConfirm")
          : t(pluginOAuth
              ? "settings.vendorSignOut"
              : kind === "account" ? "settings.vendorRemoveAccount" : "settings.delete"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (!isArmed) {
            setArmed(provider.id);
            return;
          }
          closeMenu(true);
          onRemove(provider);
        },
      });
    }
    return items;
  };

  return (
    <ul className="model-provider-list" aria-busy={reorder.saving}>
      {reorder.providers.map((provider) => {
        const kind = serviceRowKind(provider);
        const rowBusy = reorder.saving || isRowBusy(provider.id);
        const onOpen =
          kind === "account" && provider.ownerPluginId
            ? undefined
            : kind !== "plugin"
            ? () => onEdit(provider)
            : provider.authKind === "api_key"
              ? () => toggleKeyEntry(provider)
              : undefined;
        return (
          <ServiceRow
            key={provider.id}
            provider={provider}
            entry={accountFor(provider.id)}
            busy={rowBusy}
            testing={isTesting(provider.id)}
            dragging={reorder.draggingId === provider.id}
            menuItems={menuItems(provider)}
            menuOpen={openMenuId === provider.id}
            anyMenuOpen={openMenuId !== null}
            restoreMenuFocus={restoreMenuFocus}
            onMenuOpenChange={(open) => {
              if (open) setRestoreMenuFocus(true);
              setMenuFor(open ? provider.id : null);
              setArmed(null);
            }}
            onOpen={onOpen}
            onToggleEnabled={() => onToggleEnabled(provider)}
            keyEntryOpen={keyFor === provider.id}
            onSaveKey={(value) => void saveKey(provider, value)}
            onCloseKeyEntry={() => setKeyFor(null)}
            rowRef={reorder.rowRef(provider.id)}
            reorderEvents={reorder.rowEvents(provider.id)}
          />
        );
      })}
    </ul>
  );
}
