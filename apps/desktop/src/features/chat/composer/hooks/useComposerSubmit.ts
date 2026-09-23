import { useRef, useState } from "react";
import type { TFunction } from "i18next";
import {
  canonicalThinkingLevel,
  restoreInlineComposerFileReferenceTokens,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
  stripInlineComposerFileReferenceTokens,
} from "@pi-desktop/shared";
import type { AppState } from "../../../../stores/app-store";
import { useAppStore } from "../../../../stores/app-store";
import type { ComposerDraftSnapshot } from "../../../../lib/composer-smart-stop";
import { api } from "../../../../lib/api";
import { draftKeyForSession } from "../../../../lib/composer-draft-cache";
import { runExtensionCommand, runPaletteCommand } from "../../../../lib/commands";
import { resolveComposerCommand } from "../../../../hooks/use-composer-autocomplete";
import {
  parseSlashSubmission,
  resolveSlashDispatch,
} from "../slash-dispatch";
import { readEditorValue, setEditorCaret, type ComposerFileReference } from "../editor";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerSubmitOptions = {
  value: string;
  draftKey: string;
  activeSessionId: string | null | undefined;
  providerId?: string;
  modelId?: string;
  thinkingLevel: Parameters<AppState["configureActiveSession"]>[0]["thinkingLevel"];
  modelReady: boolean;
  sendBlocked: boolean;
  pasting: boolean;
  activeFileReferences: ComposerFileReference[];
  t: TFunction;
  sendPrompt: AppState["sendPrompt"];
  steerPrompt: AppState["steerPrompt"];
  showToast: AppState["showToast"];
  draft: Pick<
    ComposerDraftController,
    | "ref"
    | "draftSnapshot"
    | "draftRevision"
    | "clearDraftForKey"
    | "restoreDraftForKey"
    | "setValue"
    | "setCursor"
  >;
};

export type ComposerSubmitController = {
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancementError: { message: string; code: string } | null;
  clearEnhancementError: () => void;
  invalidatePromptEnhancement: () => void;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  submit: (steering?: boolean) => Promise<void>;
};

/**
 * Own prompt enhancement and send orchestration. It deliberately receives the
 * draft controller as a narrow dependency so command dispatch and optimistic
 * draft clearing remain independent from editor rendering.
 */
export function useComposerSubmit({
  value,
  draftKey,
  activeSessionId,
  providerId,
  modelId,
  thinkingLevel,
  modelReady,
  sendBlocked,
  pasting,
  activeFileReferences,
  t,
  sendPrompt,
  steerPrompt,
  showToast,
  draft,
}: UseComposerSubmitOptions): ComposerSubmitController {
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [enhancementUndoText, setEnhancementUndoText] = useState<string | null>(null);
  const [enhancementError, setEnhancementError] = useState<{
    message: string;
    code: string;
  } | null>(null);
  const enhancementVersionRef = useRef(0);
  const enhancementRequestRef = useRef<symbol | null>(null);

  const invalidatePromptEnhancement = () => {
    enhancementVersionRef.current += 1;
    setEnhancementUndoText(null);
    setEnhancementError(null);
  };

  const enhancePrompt = async () => {
    const sourceText = value;
    const textToEnhance = stripInlineComposerFileReferenceTokens(
      sourceText,
      activeFileReferences,
    );
    const sourceKey = draftKey;
    const sourceVersion = enhancementVersionRef.current;
    if (
      !textToEnhance.trim() ||
      textToEnhance.trim().startsWith("/") ||
      !modelReady ||
      sendBlocked ||
      enhancingPrompt
    ) {
      return;
    }

    const requestToken = Symbol("prompt-enhancement");
    enhancementRequestRef.current = requestToken;
    setEnhancingPrompt(true);
    setEnhancementUndoText(null);
    setEnhancementError(null);
    try {
      const result = await api.enhancePrompt({
        sessionId: activeSessionId,
        draft: textToEnhance,
        providerId,
        modelId,
        thinkingLevel: canonicalThinkingLevel(thinkingLevel),
      });
      const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
      if (
        enhancementRequestRef.current !== requestToken ||
        currentKey !== sourceKey ||
        enhancementVersionRef.current !== sourceVersion
      ) {
        return;
      }
      const modelDraft = result.enhancedDraft.trim();
      if (
        !modelDraft ||
        !stripInlineComposerFileReferenceTokens(modelDraft, activeFileReferences).trim()
      ) {
        throw Object.assign(new Error("The model returned an empty enhanced draft."), {
          code: "PROMPT_ENHANCEMENT_EMPTY",
        });
      }
      const enhancedDraft = restoreInlineComposerFileReferenceTokens(
        sourceText,
        modelDraft,
        activeFileReferences,
      );
      enhancementVersionRef.current += 1;
      draft.setValue(enhancedDraft);
      draft.setCursor(enhancedDraft.length);
      setEnhancementUndoText(sourceText);
      requestAnimationFrame(() => {
        const element = draft.ref.current;
        if (!element) return;
        element.focus();
        setEditorCaret(element, enhancedDraft.length);
      });
    } catch (error) {
      const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
      if (
        enhancementRequestRef.current !== requestToken ||
        currentKey !== sourceKey ||
        enhancementVersionRef.current !== sourceVersion
      ) {
        return;
      }
      const typed = error as Error & { code?: string };
      setEnhancementError({
        message:
          typed.code === "TIMEOUT"
            ? t("chat.enhancementTimeout")
            : typed.message || t("chat.enhancementFailed"),
        code: typed.code || "PROMPT_ENHANCEMENT_FAILED",
      });
    } finally {
      if (enhancementRequestRef.current === requestToken) setEnhancingPrompt(false);
    }
  };

  const undoPromptEnhancement = () => {
    if (enhancementUndoText === null) return;
    invalidatePromptEnhancement();
    draft.setValue(enhancementUndoText);
    draft.setCursor(enhancementUndoText.length);
    requestAnimationFrame(() => {
      const element = draft.ref.current;
      if (!element) return;
      element.focus();
      setEditorCaret(element, enhancementUndoText.length);
    });
  };

  const submit = async (steering = false) => {
    const text = draft.ref.current ? readEditorValue(draft.ref.current) : value;
    const inlineContent = serializeInlineComposerFileReferences(
      text,
      activeFileReferences,
    );
    const serializedContent = serializeComposerFileReferences(text, activeFileReferences);
    if (!serializedContent) return;
    if (sendBlocked) {
      if (pasting) showToast(t("chat.pasteInProgress"), { variant: "info" });
      return;
    }
    invalidatePromptEnhancement();
    const submittedDraftKey = draftKey;
    const submittedDraftRevision = draft.draftRevision(submittedDraftKey);
    const submittedDraft = draft.draftSnapshot(text);
    // Slash dispatch stays local for builtin and extension commands, while
    // templates, skills, and unknown aliases continue as normal prompt text. A
    // command source that cannot be read is a third case: the composer cannot
    // prove `/compact` is not a builtin, so it refuses the submission and keeps
    // the text out of the model's input (issue #795).
    if (!steering) {
      const slashSubmission = parseSlashSubmission(serializedContent);
      const resolution = slashSubmission
        ? await resolveComposerCommand(slashSubmission.name)
        : null;
      const dispatch = resolveSlashDispatch(slashSubmission, resolution);
      if (dispatch.action === "blocked") {
        showToast(t("chat.slashCommandSourceUnavailable"), {
          variant: "error",
        });
        return;
      }
      if (dispatch.action === "dispatch") {
        const command = dispatch.command;
        const commandBody = dispatch.body;
        const isModeCommand =
          command.id === "builtin.mode.agent" ||
          command.id === "builtin.mode.plan" ||
          command.id === "builtin.mode.goal";
        if (isModeCommand && commandBody) {
          try {
            await runPaletteCommand(command.id);
            const visibleDraft = text.trim();
            const visibleCommandEnd = visibleDraft.search(/\s/);
            const visibleCommandBody =
              visibleCommandEnd === -1
                ? ""
                : visibleDraft.slice(visibleCommandEnd).trim();
            const accepted = await sendPrompt(
              serializeInlineComposerFileReferences(
                visibleCommandBody,
                activeFileReferences,
              ),
              draft.draftSnapshot(visibleCommandBody),
            );
            if (accepted) draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
        if (command.kind === "extension") {
          try {
            await runExtensionCommand(command.name, commandBody);
            draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
        if (!commandBody) {
          try {
            if (command.kind === "builtin") await runPaletteCommand(command.id);
            else await api.executeCommand(command.id);
            draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            });
          }
          return;
        }
      }
    }
    if (!steering && !modelReady) {
      showToast(t("errors.MODEL_NOT_CONFIGURED"), { variant: "error" });
      return;
    }
    draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
    const accepted = steering
      ? await steerPrompt(inlineContent, submittedDraft)
      : await sendPrompt(inlineContent, submittedDraft);
    if (!accepted) draft.restoreDraftForKey(submittedDraftKey, submittedDraft);
  };

  return {
    enhancingPrompt,
    enhancementUndoText,
    enhancementError,
    clearEnhancementError: () => setEnhancementError(null),
    invalidatePromptEnhancement,
    enhancePrompt,
    undoPromptEnhancement,
    submit,
  };
}
