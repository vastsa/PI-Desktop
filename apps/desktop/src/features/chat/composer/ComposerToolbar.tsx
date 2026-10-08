import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
  type PluginComposerTransformMeta,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { ModeIcon } from "./ComposerModeIcon";
import { LiveVoiceControls } from "../../voice/live/LiveVoiceControls";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  MODE_LABEL_KEYS,
  nextMode,
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
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
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
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  composerTransforms: PluginComposerTransformMeta[];
  activeTransformKey: string | null;
  undoTransform: PluginComposerTransformMeta | null;
  runComposerTransform: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoComposerTransform: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
  workSessionId?: string;
  workSessionLabel?: string;
};

/** Composer controls: mode, permission, model, plugin actions, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
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
  value,
  modelReady,
  sendBlocked,
  composerTransforms,
  activeTransformKey,
  undoTransform,
  runComposerTransform,
  undoComposerTransform,
  runActive,
  hasDraftContent,
  abort,
  submit,
  workSessionId,
  workSessionLabel,
}: ComposerToolbarProps) {
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting}
            onClick={() => {
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <LiveVoiceControls t={t} workSessionId={workSessionId} />
        <TooltipButton
          type="button"
          className="icon-btn mode-chip composer-mode-chip"
          data-mode={mode}
          data-planning={planningLive ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          disabled={controlsBlocked}
          onClick={async () => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
            const next: Mode = nextMode(mode);
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
        >
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
            <span className="composer-mode-chip-label text-sm">
              {t(MODE_LABEL_KEYS[mode])}
            </span>
          </span>
        </TooltipButton>
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked} onCloseOtherMenus={() => modelMenu.setOpen(false)}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} />
        <ComposerControlSlots side="left" />
      </div>

      <div className="composer-right">
        <ComposerControlSlots side="right" />
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => setPermissionOpen(false)}
        />
        {composerTransforms.map((transform) => {
          const key = `${transform.pluginId}/${transform.id}`;
          const isActive = activeTransformKey === key;
          return (
          <TooltipButton
            key={key}
            type="button"
            className={`icon-btn icon-btn-square composer-plugin-transform-btn${isActive ? " is-loading" : ""}`}
            tooltip={transform.title}
            ariaLabel={transform.title}
            aria-busy={isActive}
            disabled={
              !value.trim() ||
              value.trim().startsWith("/") ||
              controlsBlocked ||
              sendBlocked ||
              pasting ||
              activeTransformKey !== null
            }
            onClick={() => void runComposerTransform(transform)}
          >
            {isActive ? <span className="tool-spinner" aria-hidden="true" /> : <IconSparkles size={15} aria-hidden="true" />}
          </TooltipButton>
          );
        })}
        {undoTransform ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-plugin-transform-undo"
            tooltip={undoTransform.undoTitle}
            ariaLabel={undoTransform.undoTitle}
            disabled={controlsBlocked}
            onClick={undoComposerTransform}
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
