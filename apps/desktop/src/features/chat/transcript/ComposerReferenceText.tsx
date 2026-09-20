import { parseComposerPromptDisplay } from "@pi-desktop/shared";
import { LinkifiedText } from "./shared";

/** Persisted labels remain readable after their producing plugin is removed. */
export function ComposerReferenceText({ display, fallback }: { display: unknown; fallback: string }) {
  const value = parseComposerPromptDisplay(display);
  if (!value) return <LinkifiedText text={fallback} />;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const reference of value.references) {
    if (reference.start > at) parts.push(<LinkifiedText key={`text:${at}`} text={value.content.slice(at, reference.start)} />);
    parts.push(<span className="composer-chip chat-file-chip" key={`ref:${reference.start}`} title={reference.pluginId}>
      <span className="composer-chip-name">{reference.label}</span>
    </span>);
    at = reference.end;
  }
  if (at < value.content.length) parts.push(<LinkifiedText key={`text:${at}`} text={value.content.slice(at)} />);
  return <>{parts}</>;
}
