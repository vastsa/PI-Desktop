import type { TFunction } from "i18next";
import {
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
} from "@pi-desktop/shared";
import type { AppState } from "../../../../stores/app-store";
import { api } from "../../../../lib/api";
import { runExtensionCommand, runPaletteCommand } from "../../../../lib/commands";
import { resolveComposerCommand } from "../../../../hooks/use-composer-autocomplete";
import {
  parseSlashSubmission,
  resolveSlashDispatch,
} from "../slash-dispatch";
import { readEditorValue, type ComposerFileReference } from "../editor";
import type { ComposerDraftSnapshot } from "../../../../lib/composer-smart-stop";
import type { ComposerDraftController } from "./useComposerDraft";

type UseComposerSubmitOptions = {
  value: string;
  draftKey: string;
  activeSessionId: string | null | undefined;
  modelReady: boolean;
  sendBlocked: boolean;
  invalidateComposerTransforms: () => void;
  pasting: boolean;
  activeFileReferences: ComposerFileReference[];
  t: TFunction;
  sendPrompt: AppState["sendPrompt"];
  steerPrompt: AppState["steerPrompt"];
  showToast: AppState["showToast"];
  /** Record an accepted submission for ArrowUp recall. */
  recordHistory?: (snapshot: ComposerDraftSnapshot, sessionId: string) => void;
  draft: Pick<
    ComposerDraftController,
    | "ref"
    | "draftSnapshot"
    | "draftRevision"
    | "clearDraftForKey"
    | "restoreDraftForKey"
  >;
};

export type ComposerSubmitController = { submit: (steering?: boolean) => Promise<void> };

/**
 * Own send orchestration. It receives the draft controller as a narrow
 * dependency so command dispatch and optimistic draft clearing remain
 * independent from editor rendering.
 */
export function useComposerSubmit({
  value,
  draftKey,
  activeSessionId,
  modelReady,
  sendBlocked,
  invalidateComposerTransforms,
  pasting,
  activeFileReferences,
  t,
  sendPrompt,
  steerPrompt,
  showToast,
  recordHistory,
  draft,
}: UseComposerSubmitOptions): ComposerSubmitController {
  const submit = async (steering = false) => {
    const rawText = draft.ref.current ? readEditorValue(draft.ref.current) : value;
    // An image chip keeps its place in the prompt: main resolves the `@path` it
    // serializes to against the attachment it prepared, so the image block
    // arrives where the user put it instead of trailing the text.
    const inlineContent = serializeInlineComposerFileReferences(rawText, activeFileReferences);
    const serializedContent = serializeComposerFileReferences(rawText, activeFileReferences);
    if (!serializedContent) return;
    if (sendBlocked) {
      if (pasting) showToast(t("chat.pasteInProgress"), { variant: "info" });
      return;
    }
    invalidateComposerTransforms();
    const submittedDraftKey = draftKey;
    const submittedDraftRevision = draft.draftRevision(submittedDraftKey);
    const submittedDraft = draft.draftSnapshot(rawText);
    // Recall keeps what the user typed, in the conversation that submitted it.
    // For a mode command that is the whole `/agent …` text rather than its body,
    // so re-submitting re-runs it; every other recorded path stores exactly the
    // accepted payload. A send from the empty home has no session yet, so the id
    // is resolved after the submission materialized it.
    let acceptedSessionId = activeSessionId ?? undefined;
    const remember = () => {
      if (acceptedSessionId) recordHistory?.(submittedDraft, acceptedSessionId);
    };
    const captureAcceptedSession = (sessionId: string) => {
      acceptedSessionId = sessionId;
    };
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
            const visibleDraft = rawText.trim();
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
              activeSessionId ?? undefined,
              captureAcceptedSession,
            );
            if (accepted) draft.clearDraftForKey(submittedDraftKey, submittedDraftRevision, submittedDraft);
            if (accepted) remember();
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
            remember();
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
            remember();
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
      : await sendPrompt(
          inlineContent,
          submittedDraft,
          activeSessionId ?? undefined,
          captureAcceptedSession,
        );
    if (!accepted) draft.restoreDraftForKey(submittedDraftKey, submittedDraft);
    else remember();
  };

  return { submit };
}
