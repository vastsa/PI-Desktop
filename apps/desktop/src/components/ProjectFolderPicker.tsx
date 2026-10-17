import { useTranslation } from "react-i18next";
import { folderNameFromPath } from "../lib/project-name";
import { Button, TooltipButton } from "./ui";
import { IconFolder, IconMonitor, IconNewProject, IconStar, IconX } from "./icons";

function folderParent(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? `…/${parts.slice(-2, -1)[0]}` : path;
}

export function ProjectFolderPicker({ folders, busy, pickerBusy, onAdd, onRemove }: {
  folders: string[]; busy: boolean; pickerBusy: boolean;
  onAdd: () => void; onRemove: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
              <section
                className="project-create-dialog-section project-create-dialog-folders"
                aria-labelledby="project-create-folders-heading"
              >
                <div className="project-create-dialog-section-head">
                  <h3 id="project-create-folders-heading" className="project-create-dialog-section-title">
                    {t("project.createFoldersLabel")}
                    {folders.length > 0 ? (
                      <span className="project-create-dialog-count">{folders.length}</span>
                    ) : null}
                  </h3>
                  <span className="project-create-dialog-source" data-project-source="local">
                    <IconMonitor size={15} aria-hidden />
                    {t("project.createComputer")}
                  </span>
                </div>

                {folders.length > 0 ? (
                  <div className="project-create-dialog-folder-list" role="list">
                    {folders.map((path, index) => (
                      <div
                        className={`project-create-folder-row${index === 0 ? " is-primary" : ""}`}
                        key={path}
                        role="listitem"
                      >
                        <span className="project-create-folder-icon" aria-hidden>
                          <IconFolder size={17} />
                        </span>
                        <span className="project-create-folder-copy" title={path}>
                          <span className="project-create-folder-name">{folderNameFromPath(path)}</span>
                          <span className="project-create-folder-path">{folderParent(path)}</span>
                        </span>
                        {index === 0 ? (
                          <span className="project-create-primary-tag">
                            <IconStar size={11} fill="currentColor" aria-hidden />
                            {t("project.createPrimary")}
                          </span>
                        ) : null}
                        <TooltipButton
                          type="button"
                          className="project-create-folder-remove"
                          tooltip={t("project.createRemoveFolder")}
                          ariaLabel={`${t("project.createRemoveFolder")}: ${folderNameFromPath(path)}`}
                          disabled={busy}
                          onClick={() => onRemove(path)}
                        >
                          <IconX size={15} />
                        </TooltipButton>
                      </div>
                    ))}
                  </div>
                ) : null}

                <Button
                  type="button"
                  aria-label={t("project.createAddFolder")}
                  className={`project-create-add-folder${folders.length === 0 ? " is-empty" : ""}`}
                  onClick={() => onAdd()}
                  disabled={busy || pickerBusy}
                >
                  <span className="project-create-add-folder-icon" aria-hidden>
                    <IconNewProject size={18} />
                  </span>
                  <span className="project-create-add-folder-copy">
                    <span className="project-create-add-folder-title">
                      {t("project.createAddFolder")}
                    </span>
                  </span>
                </Button>
              </section>
  );
}
