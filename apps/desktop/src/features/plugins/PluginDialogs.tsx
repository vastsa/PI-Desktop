import { Button, cx } from "../../components/ui";
import { IconCheck, IconShield, IconSparkles, IconTriangleAlert } from "../../components/icons";
import { PluginSettingsSheet } from "../../components/plugins/PluginSettingsSheet";
import { useAppStore } from "../../stores/app-store";
import {
  RISK_LABEL_KEYS,
  RISK_TIERS,
  TEMPLATE_IDS,
  permissionLabel,
  permissionRisk,
} from "./model";
import type { PluginsPageModel } from "./usePluginsPage";

export function PluginDialogs({
  t,
  pendingInstall,
  setPendingInstall,
  autoUpdate,
  setAutoUpdate,
  busyId,
  confirmInstall,
  settingsPlugin,
  setSettingsPlugin,
  refreshPlugins,
  templatePick,
  creating,
  setTemplatePick,
  createFromTemplate,
}: PluginsPageModel) {
  return (
    <>
    {pendingInstall ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.permissionReviewTitle", { name: pendingInstall.name })}
                </h2>
                {pendingInstall.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingInstall.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.permissionReviewBody")}</p>
              {pendingInstall.permissions.length === 0 ? (
                <p className="plugins-modal-lede">{t("plugins.noPermissions")}</p>
              ) : (
                RISK_TIERS.map((tier) => {
                  const scoped = pendingInstall.permissions.filter(
                    (permission) => permissionRisk(permission) === tier,
                  );
                  if (!scoped.length) return null;
                  return (
                    <div key={tier} className={cx("plugins-risk-group", `risk-${tier}`)}>
                      <div className="plugins-risk-head">
                        {tier === "high" ? (
                          <IconTriangleAlert size={13} />
                        ) : (
                          <IconShield size={13} />
                        )}
                        {t(RISK_LABEL_KEYS[tier])}
                        <span className="plugins-risk-count">{scoped.length}</span>
                      </div>
                      <ul className="plugins-perm-list is-plain">
                        {scoped.map((permission) => (
                          <li key={permission}>
                            <span className="plugins-perm-copy">
                              <strong>
                                {permissionLabel(permission, t)}
                                {pendingInstall.newPermissions.includes(permission) ? (
                                  <span className="plugins-tag is-update">
                                    {t("plugins.newPermission")}
                                  </span>
                                ) : null}
                              </strong>
                              <span>
                                {t(`plugins.permissionHelp.${permission}`, {
                                  defaultValue: permission,
                                })}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>

            <div className="plugins-switch-row">
              <span className="plugins-switch-label">
                {t("plugins.enableAutoUpdateOnInstall")}
              </span>
              <button
                type="button"
                className={cx("settings-toggle", autoUpdate && "on")}
                role="switch"
                aria-checked={autoUpdate}
                aria-label={t("plugins.enableAutoUpdateOnInstall")}
                onClick={() => setAutoUpdate((on) => !on)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingInstall(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busyId === pendingInstall.id}
                onClick={() => void confirmInstall()}
              >
                {busyId === pendingInstall.id
                  ? t("plugins.installing")
                  : t("plugins.acceptInstall")}
              </Button>
            </div>
          </div>
        </div>
    ) : null}
      {settingsPlugin ? (
        <PluginSettingsSheet
          plugin={settingsPlugin}
          platform={(window.piDesktop?.platform ?? "darwin") as "darwin" | "win32" | "linux"}
          onClose={() => setSettingsPlugin(null)}
          onSaved={async () => {
            await refreshPlugins();
            const updated = useAppStore
              .getState()
              .plugins.find((plugin) => plugin.id === settingsPlugin.id);
            if (updated) setSettingsPlugin(updated);
          }}
        />
      ) : null}
      {templatePick ? (
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.newFromTemplateTitle")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconSparkles size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.newFromTemplateTitle")}
                </h2>
                <p className="plugins-modal-subtitle">
                  {t("plugins.newFromTemplateHint")}
                </p>
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.newFromTemplateBody")}</p>
              <div
                className="plugins-template-list"
                role="radiogroup"
                aria-label={t("plugins.newFromTemplateTitle")}
              >
                {TEMPLATE_IDS.map((template) => {
                  const active = templatePick === template;
                  return (
                    <button
                      key={template}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cx("plugins-template", active && "active")}
                      onClick={() => setTemplatePick(template)}
                    >
                      <span className="plugins-template-mark" aria-hidden>
                        {active ? <IconCheck size={13} /> : null}
                      </span>
                      <span className="plugins-template-copy">
                        <strong className="plugins-template-name">
                          {t(`plugins.templateName.${template}`)}
                        </strong>
                        <span className="plugins-template-body">
                          {t(`plugins.templateBody.${template}`)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="plugins-modal-actions">
              <Button
                variant="secondary"
                disabled={creating}
                onClick={() => setTemplatePick(null)}
              >
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={creating}
                onClick={() => void createFromTemplate(templatePick)}
              >
                {creating
                  ? t("plugins.newFromTemplateCreating")
                  : t("plugins.newFromTemplateCreate")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
