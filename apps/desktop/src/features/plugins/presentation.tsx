import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton, cx } from "../../components/ui";
import { IconChevronDown, IconSearch, IconX } from "../../components/icons";
import type {
  PluginAgentExtensionStatus,
  PluginCapability,
  PluginFsPolicy,
  PluginServiceStatus,
  PluginSummary,
} from "@pi-desktop/shared";
import {
  CAPABILITY_ORDER,
  FS_MODES,
  INLINE_PERMISSION_LIMIT,
  LEGACY_FS_PERMISSIONS,
  permissionLabel,
  permissionRisk,
  orderPermissions,
} from "./model";

export function PermissionChips({
  permissions,
  limit = INLINE_PERMISSION_LIMIT,
}: {
  permissions: readonly string[] | undefined;
  limit?: number;
}) {
  const { t } = useTranslation();
  const ordered = orderPermissions(permissions);
  if (ordered.length === 0) {
    return <span className="plugins-perm-none">{t("plugins.noPermissions")}</span>;
  }
  const shown = ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;
  return (
    <span className="plugins-perm-chips">
      {shown.map((permission) => (
        <span
          key={permission}
          className={cx("plugins-perm-chip", `risk-${permissionRisk(permission)}`)}
          title={t(`plugins.permissionHelp.${permission}`, { defaultValue: permission })}
        >
          {permissionLabel(permission, t)}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          className="plugins-perm-chip is-more"
          title={ordered
            .slice(limit)
            .map((permission) => permissionLabel(permission, t))
            .join(" · ")}
        >
          {t("plugins.permsMore", { count: hidden })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * `manifest.fs` read back to the user. A permission says the plugin may touch
 * files; this says which ones, and it is the only place that distinction is
 * visible outside the manifest.
 */
export function FsScopeChips({ policy }: { policy: PluginFsPolicy | undefined }) {
  const { t } = useTranslation();
  const chips = FS_MODES.flatMap((mode) => {
    const rule = policy?.[mode];
    if (!rule) return [];
    const parts: string[] = [];
    if (rule.root === "userSelected") parts.push(t("plugins.fsRootPicked"));
    if (rule.scope?.length) parts.push(rule.scope.join(" · "));
    if (rule.own) parts.push(t("plugins.fsOwnFiles"));
    // No standing reach at all: every access stops at a confirmation.
    if (!parts.length) parts.push(t("plugins.fsAsksEachTime"));
    return [{ mode, text: `${t(`plugins.fsMode.${mode}`)} · ${parts.join(" · ")}` }];
  });
  if (!chips.length) return null;
  return (
    <span className="plugins-perm-chips">
      {chips.map((chip) => (
        <span
          key={chip.mode}
          className={cx("plugins-perm-chip", `risk-${permissionRisk(`fs.${chip.mode}`)}`)}
          title={chip.text}
        >
          {chip.text}
        </span>
      ))}
    </span>
  );
}

/** What the plugin contributes, in a fixed order so rows stay comparable. */
export function CapabilityChips({ capabilities }: { capabilities: readonly PluginCapability[] | undefined }) {
  const { t } = useTranslation();
  const ordered = CAPABILITY_ORDER.filter((cap) => capabilities?.includes(cap));
  if (ordered.length === 0) return null;
  return (
    <span className="plugins-cap-chips">
      {ordered.map((cap) => (
        <span key={cap} className="plugins-cap-chip">
          {t(`plugins.capabilities.${cap}`, { defaultValue: cap })}
        </span>
      ))}
    </span>
  );
}

/**
 * Supervision state of the plugin's resident services. Restart counts are shown
 * because a service that keeps coming back is a different problem from one that
 * is simply running.
 */
export function ServiceChips({ statuses }: { statuses: readonly PluginServiceStatus[] | undefined }) {
  const { t } = useTranslation();
  if (!statuses?.length) return null;
  return (
    <span className="plugins-service-chips">
      {statuses.map((status) => (
        <span
          key={status.serviceId}
          className={cx("plugins-service-chip", `is-${status.state}`)}
          title={status.message || undefined}
        >
          <span className="plugins-service-dot" aria-hidden />
          <span className="plugins-service-name">{status.label}</span>
          <span className="plugins-service-state">
            {t(`plugins.serviceState.${status.state}`)}
          </span>
          {status.restarts > 0 ? (
            <span className="plugins-service-restarts">
              {t("plugins.serviceRestarts", { count: status.restarts })}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** Live state of a plugin's ExtensionAPI modules (spec 07-plugins/16 §11). */
export function AgentExtensionDetails({ status }: { status: PluginAgentExtensionStatus }) {
  const { t } = useTranslation();
  const names = [...status.toolNames, ...status.commandNames.map((name) => `/${name}`)];
  return (
    <div className="plugins-agent-extension">
      <span
        className={cx(
          "agent-capability-badge",
          status.state === "loaded" && "is-ready",
          status.state === "error" && "is-failed",
          status.state === "enabled" && "is-level",
        )}
      >
        {t(`plugins.agentExtension.state.${status.state}`)}
      </span>
      {names.length ? <code className="plugins-agent-extension-names">{names.join(" · ")}</code> : null}
      {status.diagnostics.length ? (
        <ul className="agent-extension-diagnostics" aria-label={t("plugins.agentExtension.diagnostics")}>
          {status.diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.kind}:${diagnostic.member ?? ""}`}
              className={cx(
                "agent-extension-diagnostic",
                (diagnostic.kind === "load_error" ||
                  diagnostic.kind === "factory_error" ||
                  diagnostic.kind === "handler_error" ||
                  diagnostic.kind === "handler_timeout") &&
                  "is-error",
              )}
            >
              <span className="agent-extension-diagnostic-kind">
                {t(`plugins.agentExtension.kinds.${diagnostic.kind}`)}
              </span>
              {diagnostic.member ? (
                <code className="agent-extension-diagnostic-member">{diagnostic.member}</code>
              ) : null}
              <span className="agent-extension-diagnostic-message" title={diagnostic.stack}>
                {diagnostic.message}
              </span>
              {diagnostic.count > 1 ? (
                <span className="agent-capability-badge">×{diagnostic.count}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Keep the installed row calm while retaining the full capability readout on demand. */
export function PluginRowDetails({
  plugin,
  services,
}: {
  plugin: PluginSummary;
  services: readonly PluginServiceStatus[] | undefined;
}) {
  const { t } = useTranslation();
  const hasCapabilities = (plugin.capabilities?.length ?? 0) > 0;
  const hasServices = (services?.length ?? 0) > 0;
  const hasPermissions = (plugin.permissions?.length ?? 0) > 0;
  const hasAgentExtension = plugin.agentExtension !== undefined;
  const hasFsScope = FS_MODES.some((mode) => plugin.fs?.[mode]);
  const legacyFs = (plugin.permissions ?? []).filter((permission) =>
    LEGACY_FS_PERMISSIONS.includes(permission),
  );

  if (!hasCapabilities && !hasServices && !hasPermissions && !hasAgentExtension) return null;

  return (
    <details className="plugins-row-details">
      <summary
        className="plugins-row-details-toggle"
        aria-label={t("plugins.viewDetailsOf", { name: plugin.name })}
      >
        <IconChevronDown size={13} aria-hidden="true" />
        <span>{t("plugins.details")}</span>
      </summary>
      <div className="plugins-row-details-body">
        {hasCapabilities ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">
              {t("plugins.capabilitiesTitle")}
            </span>
            <CapabilityChips capabilities={plugin.capabilities} />
          </div>
        ) : null}
        {hasServices ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">{t("plugins.servicesTitle")}</span>
            <ServiceChips statuses={services} />
          </div>
        ) : null}
        {hasAgentExtension && plugin.agentExtension ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">
              {t("plugins.agentExtension.title")}
            </span>
            <AgentExtensionDetails status={plugin.agentExtension} />
          </div>
        ) : null}
        {hasPermissions ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">
              {t("plugins.permissionsTitle")}
            </span>
            <PermissionChips permissions={plugin.permissions} />
          </div>
        ) : null}
        {hasFsScope ? (
          <div className="plugins-row-detail">
            <span className="plugins-row-detail-label">{t("plugins.fileAccessTitle")}</span>
            <FsScopeChips policy={plugin.fs} />
          </div>
        ) : null}
        {legacyFs.length ? (
          // The plugin still loads, with less reach than its author expected.
          // Saying so is the difference between "broken" and "needs an update".
          <p className="plugins-row-detail-note">{t("plugins.legacyFsDowngraded")}</p>
        ) : null}
      </div>
    </details>
  );
}

/** Pill search field with a leading icon and a clear affordance. */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="plugins-search-wrap">
      <IconSearch size={14} />
      <input
        ref={inputRef}
        className="plugins-search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {value ? (
        <TooltipButton
          type="button"
          className="plugins-search-clear"
          ariaLabel={t("plugins.clearSearch")}
          tooltip={t("plugins.clearSearch")}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <IconX size={12} />
        </TooltipButton>
      ) : null}
    </div>
  );
}
