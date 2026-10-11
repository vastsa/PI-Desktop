/**
 * A user message's text run. User messages are plain text, not Markdown, but
 * a fence whose `<pluginId>:lang` language a plugin claims through the
 * `blockRenderer` slot (`docs/plugin-plan/ui/block-renderer/`) is drawn by
 * that plugin, as it would be in an answer; every other fence, and any fence
 * whose plugin is off or fails, stays the text it was. The message content
 * itself is untouched: copy, edit and export still use the full text.
 */
import { useMemo } from "react";
import type { MessageAttachment } from "@pi-desktop/shared";
import { PluginBlockRenderer } from "../../../components/PluginBlockRenderer";
import { blockRendererCandidate, splitPluginFences } from "../../../lib/block-renderer";
import { useSlotEntryForKey } from "../../../plugins/renderer-slots/use-slots";
import { LinkifiedText } from "./shared";

type TextProps = {
  text: string;
  attachments?: readonly MessageAttachment[];
  /** Where this run starts in the message content, so offsets stay absolute. */
  sourceOffset?: number;
};

function ClaimedFence({
  raw,
  language,
  source,
  start,
  attachments,
}: {
  raw: string;
  language: string;
  source: string;
  start: number;
  attachments?: readonly MessageAttachment[];
}) {
  const entry = useSlotEntryForKey("blockRenderer", blockRendererCandidate(language));
  const text = <LinkifiedText text={raw} attachments={attachments} sourceOffset={start} />;
  if (!entry) return text;
  return (
    <PluginBlockRenderer
      key={entry.id}
      entry={entry}
      language={language}
      source={source}
      sourcePosition={{ "data-source-start": start, "data-source-end": start + raw.length }}
      fallback={text}
    />
  );
}

export function UserMessageText({ text, attachments, sourceOffset = 0 }: TextProps) {
  const runs = useMemo(() => splitPluginFences(text), [text]);
  return (
    <>
      {runs.map((run) =>
        run.kind === "text" ? (
          <LinkifiedText
            key={run.start}
            text={run.text}
            attachments={attachments}
            sourceOffset={sourceOffset + run.start}
          />
        ) : (
          <ClaimedFence
            key={run.start}
            raw={run.raw}
            language={run.language}
            source={run.source}
            start={sourceOffset + run.start}
            attachments={attachments}
          />
        ),
      )}
    </>
  );
}
