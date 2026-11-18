import { ChatContextChips } from "../../components/ChatContextChips";
import { splitChatContextContent } from "../../lib/chat-context-format";

export function SideQuestionUserText({ content }: { content: string }) {
  return splitChatContextContent(content).map(part => part.kind === "context"
    ? <ChatContextChips key={part.start} chips={part.chips} />
    : <span key={part.start}>{part.text}</span>);
}
