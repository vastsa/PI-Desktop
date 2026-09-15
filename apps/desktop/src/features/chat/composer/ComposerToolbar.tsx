import { useState, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type ThinkingLevel,
  type ThinkingLevelMode,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { ModeIcon } from "./ComposerModeIcon";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  MODE_LABEL_KEYS,
  PERMISSION_MODE_I18N_KEYS,
  MODE_CYCLE,
} from "./model";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  thinkingLevelMode: ThinkingLevelMode;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  enhancementDraft: string;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  clearEnhancementError: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
};

/** Composer controls: mode, permission, model, enhancement, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  thinkingLevelMode,
  composerPermissionMode,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  contextUsage,
  enhancementDraft,
  value,
  modelReady,
  sendBlocked,
  enhancingPrompt,
  enhancementUndoText,
  enhancePrompt,
  undoPromptEnhancement,
  clearEnhancementError,
  runActive,
  hasDraftContent,
  abort,
  submit,
}: ComposerToolbarProps) {
  const [modeOpen, setModeOpen] = useState(false);
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting}
            onClick={() => {
              setModeOpen(false);
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <AnchoredMenu
          className="composer-mode"
          open={modeOpen}
          onClose={() => setModeOpen(false)}
          menuClassName="composer-mode-menu"
          label={t("settings.mode")}
          role="menu"
          align="start"
          side="top"
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn mode-chip composer-mode-chip ${modeOpen ? "active" : ""}`}
              data-mode={mode}
              data-planning={planningLive ? "true" : undefined}
              tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
              ariaLabel={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
              aria-haspopup="menu"
              aria-expanded={modeOpen}
              disabled={controlsBlocked}
              onClick={() => {
                modelMenu.setOpen(false);
                setPermissionOpen(false);
                setModeOpen((open) => !open);
              }}
            >
              <span className="composer-mode-chip-face" key={mode}>
                <ModeIcon mode={mode} />
                <span className="composer-mode-chip-label text-sm">
                  {t(MODE_LABEL_KEYS[mode])}
                </span>
              </span>
            </TooltipButton>
          )}
        >
          {MODE_CYCLE.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={mode === candidate}
              disabled={controlsBlocked}
              className={`composer-plus-item ${mode === candidate ? "active" : ""}`}
              onClick={async () => {
                setModeOpen(false);
                try {
                  await configureActiveSession({
                    mode: candidate,
                    providerId,
                    modelId,
                    thinkingLevel,
                    // Preserve the session-layer auto mode (ADR 0257).
                    ...(thinkingLevelMode === "auto"
                      ? { thinkingLevelMode: "auto" as const }
                      : {}),
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
              }}
            >
              <ModeIcon mode={candidate} />
              <span className="flex-1 text-left">
                {t(MODE_LABEL_KEYS[candidate])}
              </span>
              {mode === candidate ? <IconCheck size={13} /> : null}
            </button>
          ))}
        </AnchoredMenu>
        <AnchoredMenu
          className="composer-permission"
          open={permissionOpen && mode !== "goal"}
          onClose={() => setPermissionOpen(false)}
          menuClassName="composer-permission-menu"
          label={t("chat.permissionMode")}
          role="menu"
          align="start"
          side="top"
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn mode-chip ${permissionOpen ? "active" : ""}`}
              tooltip={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                    : t("chat.permissionMode")
              }
              ariaLabel={
                mode === "goal"
                  ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                  : mode === "plan" && composerPermissionMode === "auto"
                    ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                    : t("chat.permissionMode")
              }
              aria-haspopup={mode === "goal" ? undefined : "menu"}
              aria-expanded={mode === "goal" ? false : permissionOpen}
              disabled={controlsBlocked || mode === "goal"}
              onClick={() => {
                setModeOpen(false);
                modelMenu.setOpen(false);
                setPermissionOpen((open) => !open);
              }}
            >
              <span className="text-sm">
                {t(PERMISSION_MODE_I18N_KEYS[composerPermissionMode])}
              </span>
              <IconChevronDown size={12} />
            </TooltipButton>
          )}
        >
          {(["ask", "accept-edits", "auto"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={composerPermissionMode === candidate}
              disabled={controlsBlocked}
              className={`composer-plus-item ${composerPermissionMode === candidate ? "active" : ""}`}
              onClick={async () => {
                setPermissionOpen(false);
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                    // Preserve the session-layer auto mode (ADR 0257).
                    ...(thinkingLevelMode === "auto"
                      ? { thinkingLevelMode: "auto" as const }
                      : {}),
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
              }}
            >
              <span className="flex-1 text-left">
                {t(PERMISSION_MODE_I18N_KEYS[candidate])}
              </span>
              {composerPermissionMode === candidate ? <IconCheck size={13} /> : null}
            </button>
          ))}
        </AnchoredMenu>
      </div>

      <div className="composer-right">
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          thinkingLevelMode={thinkingLevelMode}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            setModeOpen(false);
            setPermissionOpen(false);
          }}
        />
        <TooltipButton
          type="button"
          className={`icon-btn composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
          tooltip={t("chat.enhancePrompt")}
          ariaLabel={enhancingPrompt ? t("chat.enhancingPrompt") : t("chat.enhancePrompt")}
          aria-busy={enhancingPrompt}
          disabled={
            !enhancementDraft.trim() ||
            enhancementDraft.trim().startsWith("/") ||
            !modelReady ||
            sendBlocked ||
            enhancingPrompt
          }
          onClick={() => void enhancePrompt()}
        >
          {enhancingPrompt ? (
            <>
              <span className="tool-spinner" aria-hidden="true" />
              <span>{t("chat.enhancingPrompt")}</span>
            </>
          ) : (
            <IconSparkles size={15} aria-hidden="true" />
          )}
        </TooltipButton>
        {enhancementUndoText !== null ? (
          <TooltipButton
            type="button"
            className="icon-btn composer-enhance-undo"
            tooltip={t("chat.undoEnhancement")}
            ariaLabel={t("chat.undoEnhancement")}
            disabled={controlsBlocked}
            onClick={undoPromptEnhancement}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
