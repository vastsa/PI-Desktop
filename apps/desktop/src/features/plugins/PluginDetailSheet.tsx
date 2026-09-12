import { Button, TooltipButton, cx } from "../../components/ui";
import {
  IconCheck,
  IconLink,
  IconShield,
  IconTriangleAlert,
  IconX,
} from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import {
  formatBytes,
  formatDate,
  monogram,
  permissionLabel,
  permissionRisk,
  RISK_LABEL_KEYS,
  shortSha,
  showsVerifiedBadge,
  versionInstallable,
  versionWithdrawn,
} from "./model";
import type { PluginsPageModel } from "./usePluginsPage";

export function PluginDetailSheet({
  t,
  locale,
  selectedId,
  closeDetail,
  detail,
  detailLoading,
  activeVersion,
  installTarget,
  detailWithdrawn,
  detailPackagePending,
  detailUpToDate,
  detailPermissions,
  installedDetail,
  busyId,
  queueInstall,
  openUrlInWorkPanel,
  setSelectedVersion,
}: PluginsPageModel) {
  return (
    selectedId ? (
        <div className="plugins-sheet-layer">
          <button
            type="button"
            className="plugins-sheet-scrim"
            aria-label={t("plugins.closeDetail")}
            onClick={closeDetail}
          />
          <aside
            className="plugins-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.detailTitle")}
          >
            <header className="plugins-sheet-head">
              <span className="plugins-card-glyph is-large" aria-hidden>
                {monogram(detail?.name || selectedId)}
              </span>
              <div className="plugins-sheet-ident">
                <h2 className="plugins-sheet-title">
                  {detail?.name || selectedId}
                  {showsVerifiedBadge(detail) ? (
                    <span
                      className="plugins-verified"
                      title={t("plugins.verified")}
                      aria-label={t("plugins.verified")}
                    >
                      <IconShield size={12} />
                    </span>
                  ) : null}
                </h2>
                <div className="plugins-sheet-meta">
                  <span className="plugins-row-id">{detail?.id || selectedId}</span>
                  {detail?.author ? (
                    <>
                      <span className="plugins-dot" aria-hidden>
                        ·
                      </span>
                      <span>{detail.author}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <TooltipButton
                type="button"
                className="plugins-icon-btn"
                ariaLabel={t("plugins.closeDetail")}
                tooltip={t("plugins.closeDetail")}
                onClick={closeDetail}
              >
                <IconX size={15} />
              </TooltipButton>
            </header>

            {detailLoading ? (
              <div className="plugins-sheet-state">{t("plugins.detailLoading")}</div>
            ) : !detail ? (
              <div className="plugins-sheet-state">{t("plugins.detailFailed")}</div>
            ) : (
              <>
                <div className="plugins-sheet-cta">
                  <div className="plugins-sheet-cta-copy">
                    <span className="plugins-sheet-cta-version">v{installTarget}</span>
                    <span className="plugins-sheet-cta-meta">
                      {detailWithdrawn
                        ? t("plugins.withdrawnHint", { version: installTarget })
                        : detailPackagePending
                        ? t("plugins.packagePendingHint", { version: installTarget })
                        : (
                            <>
                              {formatDate(activeVersion?.publishedAt, locale)}
                              {activeVersion?.sizeBytes ? (
                                <>
                                  <span className="plugins-dot" aria-hidden>
                                    ·
                                  </span>
                                  {formatBytes(activeVersion.sizeBytes)}
                                </>
                              ) : null}
                            </>
                          )}
                    </span>
                  </div>
                  {detailUpToDate ? (
                    <span className="plugins-installed-mark">
                      <IconCheck size={13} />
                      {t("plugins.installedLabel")}
                    </span>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={busyId === detail.id || detailPackagePending}
                      onClick={() =>
                        queueInstall({
                          id: detail.id,
                          name: detail.name,
                          version: installTarget,
                          permissions: detailPermissions,
                        })
                      }
                    >
                      {detailWithdrawn
                        ? t("plugins.withdrawn")
                        : detailPackagePending
                        ? t("plugins.packagePending")
                        : busyId === detail.id
                          ? t("plugins.installing")
                          : installedDetail
                            ? t("plugins.updateNow")
                            : t("plugins.installVersion", { version: installTarget })}
                    </Button>
                  )}
                </div>

                <div className="plugins-sheet-body">
                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.aboutTitle")}
                    </h3>
                    <p className="plugins-sheet-desc">{detail.description}</p>
                    {detail.repository || detail.homepage ? (
                      <div className="plugins-sheet-links">
                        {[
                          { key: "repository", url: detail.repository },
                          { key: "homepage", url: detail.homepage },
                        ]
                          .filter((link): link is { key: string; url: string } => !!link.url)
                          .map((link) => (
                            <button
                              key={link.key}
                              type="button"
                              className="plugins-sheet-link"
                              onClick={() => openUrlInWorkPanel(link.url)}
                            >
                              <IconLink size={13} />
                              <span className="plugins-sheet-link-label">
                                {t(`plugins.${link.key}`)}
                              </span>
                              <span className="plugins-sheet-link-url">{link.url}</span>
                            </button>
                          ))}
                      </div>
                    ) : null}
                  </section>

                  {activeVersion?.provenance?.sourceRepository ? (
                    <section className="plugins-sheet-section">
                      <h3 className="plugins-sheet-section-title">
                        {t("plugins.sourceTitle")}
                      </h3>
                      <div className="plugins-sheet-links">
                        <button
                          type="button"
                          className="plugins-sheet-link"
                          onClick={() =>
                            openUrlInWorkPanel(activeVersion.provenance!.sourceRepository)
                          }
                        >
                          <IconLink size={13} />
                          <span className="plugins-sheet-link-label">
                            {t("plugins.repository")}
                          </span>
                          <span className="plugins-sheet-link-url">
                            {activeVersion.provenance.sourceRepository}
                          </span>
                        </button>
                      </div>
                      <dl className="plugins-provenance">
                        {activeVersion.provenance.sourceCommit ? (
                          <div className="plugins-provenance-row">
                            <dt>{t("plugins.sourceCommit")}</dt>
                            <dd>
                              <code title={activeVersion.provenance.sourceCommit}>
                                {shortSha(activeVersion.provenance.sourceCommit)}
                              </code>
                            </dd>
                          </div>
                        ) : null}
                        {activeVersion.provenance.builder ? (
                          <div className="plugins-provenance-row">
                            <dt>{t("plugins.sourceBuiltBy")}</dt>
                            <dd>{activeVersion.provenance.builder}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </section>
                  ) : null}

                  {detail.safetyNotes ? (
                    <section className="plugins-callout">
                      <span className="plugins-callout-icon" aria-hidden>
                        <IconTriangleAlert size={15} />
                      </span>
                      <div>
                        <h3 className="plugins-callout-title">{t("plugins.safetyNotes")}</h3>
                        <p className="plugins-callout-body">{detail.safetyNotes}</p>
                      </div>
                    </section>
                  ) : null}

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.permissionsTitle")}
                    </h3>
                    {detailPermissions.length === 0 ? (
                      <p className="plugins-sheet-desc">{t("plugins.noPermissions")}</p>
                    ) : (
                      <ul className="plugins-perm-list">
                        {detailPermissions.map((permission) => {
                          const risk = permissionRisk(permission);
                          return (
                            <li key={permission} className={`risk-${risk}`}>
                              <span className="plugins-perm-risk">
                                {t(RISK_LABEL_KEYS[risk])}
                              </span>
                              <span className="plugins-perm-copy">
                                <strong>{permissionLabel(permission, t)}</strong>
                                <span>
                                  {t(`plugins.permissionHelp.${permission}`, {
                                    defaultValue: permission,
                                  })}
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">
                      {t("plugins.versions")}
                      <span className="plugins-sheet-section-hint">
                        {t("plugins.selectVersion")}
                      </span>
                    </h3>
                    <div className="plugins-version-list">
                      {(detail.versions ?? []).map((version) => {
                        const active = activeVersion?.version === version.version;
                        const withdrawn = versionWithdrawn(version);
                        const pending = !withdrawn && !versionInstallable(version);
                        return (
                          <button
                            key={version.version}
                            type="button"
                            className={cx(
                              "plugins-version",
                              active && "active",
                              withdrawn && "withdrawn",
                            )}
                            aria-pressed={active}
                            onClick={() => setSelectedVersion(version.version)}
                          >
                            <span className="plugins-version-mark" aria-hidden>
                              {active ? <IconCheck size={12} /> : null}
                            </span>
                            <span className="plugins-version-copy">
                              <span className="plugins-version-top">
                                <strong>v{version.version}</strong>
                                <span>{formatDate(version.publishedAt, locale)}</span>
                              </span>
                              <span className="plugins-version-meta">
                                {withdrawn ? (
                                  <span className="plugins-version-withdrawn">
                                    {t("plugins.withdrawn")}
                                  </span>
                                ) : pending ? (
                                  <span className="plugins-version-pending">
                                    {t("plugins.packagePending")}
                                  </span>
                                ) : (
                                  <>
                                    {formatBytes(version.sizeBytes)}
                                    <span className="plugins-dot" aria-hidden>
                                      ·
                                    </span>
                                    <code title={version.shasum}>
                                      {shortSha(version.shasum)}
                                    </code>
                                  </>
                                )}
                              </span>
                              {withdrawn && version.yankedReason ? (
                                <span className="plugins-version-changelog">
                                  {t("plugins.withdrawnReason", {
                                    reason: version.yankedReason,
                                  })}
                                </span>
                              ) : version.changelog ? (
                                <span className="plugins-version-changelog">
                                  {version.changelog}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="plugins-sheet-section">
                    <h3 className="plugins-sheet-section-title">{t("plugins.readme")}</h3>
                    {detail.readmeMarkdown ? (
                      <div className="plugins-readme">
                        <Markdown source={detail.readmeMarkdown} />
                      </div>
                    ) : (
                      <p className="plugins-sheet-desc">{t("plugins.readmeEmpty")}</p>
                    )}
                  </section>
                </div>
              </>
            )}
          </aside>
        </div>

    ) : null
  );
}
