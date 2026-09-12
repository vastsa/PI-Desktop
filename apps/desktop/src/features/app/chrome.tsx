import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "i18next";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { IconNewSession, IconSidebar } from "../../components/icons";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crash", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-primary">
          <div className="max-w-lg rounded-lg-plus border border-border-default bg-bg-secondary p-5">
            <div className="mb-2 text-base-plus font-semibold">{i18n.t("app.uiCrashed")}</div>
            <pre className="whitespace-pre-wrap text-sm-plus text-error">
              {this.state.error.message}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function CollapsedTitlebarActions({
  onToggleSidebar,
  onNewTask,
  sidebarToggleShortcut,
}: {
  onToggleSidebar: () => void;
  onNewTask: () => void;
  sidebarToggleShortcut: string;
}) {
  const { t } = useTranslation();
  const toggleLabel = t("nav.expandSidebar");
  return (
    <div className="titlebar-nav no-drag">
      <TooltipButton
        className="title-nav-btn"
        tooltip={
          sidebarToggleShortcut
            ? `${toggleLabel} (${sidebarToggleShortcut})`
            : toggleLabel
        }
        ariaLabel={toggleLabel}
        aria-expanded={false}
        data-nav="toggle-sidebar"
        onClick={onToggleSidebar}
      >
        <IconSidebar size={13} />
      </TooltipButton>
      <TooltipButton
        className="title-nav-btn"
        tooltip={t("nav.newTask")}
        ariaLabel={t("nav.newTask")}
        data-nav="new-task"
        onClick={onNewTask}
      >
        <IconNewSession size={13} />
      </TooltipButton>
    </div>
  );
}

export function RoutePending() {
  const { t } = useTranslation();
  return (
    <div className="route-pending" role="status" aria-label={t("app.loadingView")}>
      <span className="route-pending-indicator" aria-hidden />
    </div>
  );
}
