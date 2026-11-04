import { useTranslation } from "react-i18next";

import { IconArrowUp } from "../../../components/icons";

/**
 * Pinned latest prompt.
 *
 * While the answer to the newest prompt scrolls, the prompt itself leaves the
 * top of the transcript; this strip keeps one line of it in view so the user can
 * always see what they last asked, and clicking it jumps back to that row.
 * It renders nothing until the row is actually gone, so it never competes with
 * the row in view.
 */
export function PinnedPrompt({
  text,
  attachmentCount,
  visible,
  onJump,
}: {
  text: string;
  attachmentCount: number;
  visible: boolean;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  const label = t("chat.pinnedPromptJump");
  return (
    <div className="transcript-pinned-prompt" data-pinned-prompt="true">
      <button
        type="button"
        className="transcript-pinned-prompt-button"
        onClick={onJump}
        title={label}
        aria-label={label}
      >
        <IconArrowUp size={13} aria-hidden />
        <span className="transcript-pinned-prompt-text">
          {text || t("chat.pinnedPromptAttachments", { count: attachmentCount })}
        </span>
      </button>
    </div>
  );
}
