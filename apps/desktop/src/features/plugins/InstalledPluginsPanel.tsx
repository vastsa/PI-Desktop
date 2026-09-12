import { Button, TooltipButton, cx } from "../../components/ui";
import {
  IconCircleAlert,
  IconCloudDown,
  IconMore,
  IconPanel,
  IconPlug,
  IconReview,
  IconSearch,
  IconSettings,
  IconTrash,
} from "../../components/icons";
import { ScopeControl } from "../../components/extensions/ScopeControl";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import type { ActivationScope } from "@pi-desktop/shared";
import { GROUP_LABEL_KEYS, TEMPLATE_IDS } from "./model";
import { PluginRowDetails } from "./presentation";
import type { PluginsPageModel } from "./usePluginsPage";
import { api } from "../../lib/api";

export function InstalledPluginsPanel({
  t,
  plugins,
  setTab,
  loadDev,
  setTemplatePick,
  installedGroups,
  filteredInstalled,
  installedQuery,
  setInstalledQuery,
  rowMenu,
  setRowMenu,
  busyId,
  queueInstall,
  projects,
  currentProjectPath,
  run,
  refreshPlugins,
  reloadingId,
  reloadPlugin,
  setSettingsPlugin,
  servicesByPlugin,
}: PluginsPageModel) {
  return (
          <div
            id="plugins-panel-installed"
            role="tabpanel"
            aria-labelledby="plugins-tab-installed"
            className="plugins-panel"
          >
            {plugins.length === 0 ? (
              <div className="plugins-empty">
                <span className="plugins-empty-icon" aria-hidden>
                  <IconPlug size={18} />
                </span>
                <p className="plugins-empty-title">{t("plugins.empty")}</p>
                <div className="plugins-empty-actions">
                  <Button variant="primary" onClick={() => setTab("market")}>
                    {t("plugins.browseMarket")}
                  </Button>
                  <Button variant="secondary" onClick={() => void loadDev()}>
                    {t("plugins.loadDev")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setTemplatePick(TEMPLATE_IDS[0])}
                  >
                    {t("plugins.newFromTemplate")}
                  </Button>
                </div>
              </div>
            ) : installedGroups.length === 0 ? (
              <div className="plugins-empty">
                <span className="plugins-empty-icon" aria-hidden>
                  <IconSearch size={18} />
                </span>
                <p className="plugins-empty-title">{t("plugins.noMatches")}</p>
                <div className="plugins-empty-actions">
                  <Button variant="secondary" onClick={() => setInstalledQuery("")}>
                    {t("plugins.clearSearch")}
                  </Button>
                </div>
              </div>
            ) : (
              installedGroups.map((group) => (
                <section key={group.id} className="plugins-group">
                  <header className="plugins-group-head">
                    <h2 className="plugins-group-label">{t(GROUP_LABEL_KEYS[group.id])}</h2>
                    <span className="plugins-group-count">{group.rows.length}</span>
                  </header>
                  <div
                    className="plugins-list"
                    role="list"
                    aria-label={t(GROUP_LABEL_KEYS[group.id])}
                  >
                    {group.rows.map((plugin) => {
                      const broken = group.id === "attention";
                      const menuOpen = rowMenu === plugin.id;
                      const update = plugin.updateAvailable;
                      return (
                        <div
                          key={plugin.id}
                          role="listitem"
                          className={cx(
                            "plugins-row",
                            !plugin.enabled && "off",
                            broken && "broken",
                            menuOpen && "menu-open",
                          )}
                        >
                          <span className="plugins-glyph" aria-hidden>
                            {broken ? (
                              <IconCircleAlert size={15} />
                            ) : (
                              <IconPlug size={15} />
                            )}
                          </span>
                          <div className="plugins-row-copy">
                            <div className="plugins-row-title">
                              <span className="plugins-row-name">{plugin.name}</span>
                              {plugin.source === "dev" ? (
                                <span className="plugins-tag">{t("plugins.tagLocal")}</span>
                              ) : null}
                            </div>
                            <div className="plugins-row-meta">
                              <span className="plugins-row-id">{plugin.id}</span>
                              <span className="plugins-dot" aria-hidden>
                                ·
                              </span>
                              <span>v{plugin.version}</span>
                            </div>
                            {plugin.errorMessage ? (
                              <p className="plugins-row-error">{plugin.errorMessage}</p>
                            ) : null}
                            <PluginRowDetails
                              plugin={plugin}
                              services={servicesByPlugin.get(plugin.id)}
                            />
                          </div>
                          <div className="plugins-row-controls">
                            {update ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busyId === plugin.id}
                                onClick={() =>
                                  queueInstall({
                                    id: plugin.id,
                                    name: plugin.name,
                                    version: update.version,
                                    permissions: plugin.permissions ?? [],
                                    newPermissions: update.permissionDiff ?? [],
                                  })
                                }
                              >
                                {busyId === plugin.id
                                  ? t("plugins.updating")
                                  : t("plugins.updateNow")}
                              </Button>
                            ) : null}
                            <ScopeControl
                              target={plugin}
                              label={plugin.name}
                              compact
                              projects={projects}
                              currentProjectPath={currentProjectPath}
                              onSetEnabled={(enabled) =>
                                run(async () => {
                                  if (enabled) await api.enablePlugin(plugin.id);
                                  else await api.disablePlugin(plugin.id);
                                  await refreshPlugins();
                                })
                              }
                              onSetScope={(scope: ActivationScope) =>
                                run(async () => {
                                  await api.setPluginScope(plugin.id, scope);
                                  await refreshPlugins();
                                })
                              }
                            />
                            <div className="plugins-row-actions">
                              {plugin.ui?.panel ? (
                                <TooltipButton
                                  type="button"
                                  className="plugins-icon-btn"
                                  tooltip={t("plugins.openPanel")}
                                  ariaLabel={t("plugins.openPanel")}
                                  onClick={() =>
                                    void run(() => api.openPluginPanel(plugin.id))
                                  }
                                >
                                  <IconPanel size={15} />
                                </TooltipButton>
                              ) : null}
                              {plugin.enabled && plugin.settings?.length ? (
                                <TooltipButton
                                  type="button"
                                  className="plugins-icon-btn"
                                  tooltip={t("plugins.openSettings")}
                                  ariaLabel={t("plugins.openSettings")}
                                  onClick={() => setSettingsPlugin(plugin)}
                                >
                                  <IconSettings size={15} />
                                </TooltipButton>
                              ) : null}
                              <AnchoredMenu
                                className="plugins-menu-wrap"
                                open={menuOpen}
                                onClose={() => setRowMenu(null)}
                                menuClassName="plugins-menu is-end"
                                label={t("plugins.rowActions", { name: plugin.name })}
                                role="menu"
                                align="end"
                                trigger={(ref) => (
                                  <TooltipButton
                                    ref={ref}
                                    type="button"
                                    className="plugins-icon-btn"
                                    tooltip={t("plugins.rowActions", { name: plugin.name })}
                                    ariaLabel={t("plugins.rowActions", { name: plugin.name })}
                                    aria-haspopup="menu"
                                    aria-expanded={menuOpen}
                                    onClick={() =>
                                      setRowMenu((cur) =>
                                        cur === plugin.id ? null : plugin.id,
                                      )
                                    }
                                  >
                                    <IconMore size={15} />
                                  </TooltipButton>
                                )}
                              >
                                    {plugin.source === "dev" ? (
                                      <button
                                        type="button"
                                        role="menuitem"
                                        disabled={
                                          busyId === plugin.id ||
                                          reloadingId === plugin.id
                                        }
                                        onClick={() => {
                                          setRowMenu(null);
                                          void reloadPlugin(plugin.id);
                                        }}
                                      >
                                        <IconReview size={14} />
                                        {t("plugins.reload")}
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setRowMenu(null);
                                        void run(async () => {
                                          await api.setPluginAutoUpdate(
                                            plugin.id,
                                            !plugin.autoUpdate,
                                          );
                                          await refreshPlugins();
                                        });
                                      }}
                                    >
                                      <IconCloudDown size={14} />
                                      {plugin.autoUpdate
                                        ? t("plugins.disableAutoUpdate")
                                        : t("plugins.enableAutoUpdate")}
                                    </button>
                                    <div className="plugins-menu-sep" />
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="danger"
                                      onClick={() => {
                                        setRowMenu(null);
                                        void run(async () => {
                                          await api.uninstallPlugin(plugin.id);
                                          await refreshPlugins();
                                        });
                                      }}
                                    >
                                      <IconTrash size={14} />
                                      {t("plugins.uninstall")}
                                    </button>
                              </AnchoredMenu>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
);
}
