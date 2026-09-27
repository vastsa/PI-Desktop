import { useTranslation } from "react-i18next";
import {
  IconArrowUpRight,
  IconFolder,
  IconSearch,
  IconSparkles,
} from "./icons";

type HomeQuickActionsProps = {
  hasWorkspace: boolean;
  onPrefill: (prompt: string) => void;
  onOpenProject: () => void;
};

type PromptAction = {
  id: "inspect" | "improve" | "continue" | "plan" | "ask";
  labelKey: string;
  promptKey: string;
  icon: typeof IconSearch;
};

const workspaceActions: PromptAction[] = [
  {
    id: "inspect",
    labelKey: "chat.quickActionInspect",
    promptKey: "chat.quickActionInspectPrompt",
    icon: IconSearch,
  },
  {
    id: "improve",
    labelKey: "chat.quickActionImprove",
    promptKey: "chat.quickActionImprovePrompt",
    icon: IconSparkles,
  },
  {
    id: "continue",
    labelKey: "chat.quickActionContinue",
    promptKey: "chat.quickActionContinuePrompt",
    icon: IconArrowUpRight,
  },
];

const standaloneActions: PromptAction[] = [
  {
    id: "plan",
    labelKey: "chat.quickActionPlan",
    promptKey: "chat.quickActionPlanPrompt",
    icon: IconSparkles,
  },
  {
    id: "ask",
    labelKey: "chat.quickActionAsk",
    promptKey: "chat.quickActionAskPrompt",
    icon: IconArrowUpRight,
  },
];

export function HomeQuickActions({
  hasWorkspace,
  onPrefill,
  onOpenProject,
}: HomeQuickActionsProps) {
  const { t } = useTranslation();
  const actions = hasWorkspace ? workspaceActions : standaloneActions;

  return (
    <div
      className="home-quick-actions"
      data-testid="home-quick-actions"
      role="group"
      aria-label={t("chat.quickActionsTitle")}
    >
      <div className="home-quick-actions-list">
        {!hasWorkspace ? (
          <button
            type="button"
            className="home-quick-action"
            data-action="open-project"
            onClick={onOpenProject}
          >
            <span className="home-quick-action-icon" aria-hidden>
              <IconFolder size={15} />
            </span>
            <span className="home-quick-action-label">
              {t("chat.quickActionOpenProject")}
            </span>
            <IconArrowUpRight className="home-quick-action-arrow" size={14} aria-hidden />
          </button>
        ) : null}
        {actions.map((action) => {
          const ActionIcon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              className="home-quick-action"
              data-action={action.id}
              onClick={() => onPrefill(t(action.promptKey))}
            >
              <span className="home-quick-action-icon" aria-hidden>
                <ActionIcon size={15} />
              </span>
              <span className="home-quick-action-label">{t(action.labelKey)}</span>
              <IconArrowUpRight className="home-quick-action-arrow" size={14} aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
