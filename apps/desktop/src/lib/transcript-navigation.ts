import type { SessionDetail } from "@pi-desktop/shared";
import type { SessionHistoryReadOptions } from "./api";

export type TranscriptSearchTarget = {
  sessionId: string;
  messageId: string;
  query: string;
  requestId: number;
};

type NavigationState = {
  target: TranscriptSearchTarget | null;
  window: SessionDetail | null;
  loading: boolean;
  error?: string;
};

const PAGE_SIZE = 60;

/** A reading window belongs to the pane, never to the live/model cache. */
export class TranscriptNavigationController {
  private generation = 0;
  private listeners = new Set<() => void>();
  private state: NavigationState = { target: null, window: null, loading: false };
  private read: (id: string, options: SessionHistoryReadOptions) => Promise<{ session: SessionDetail | null }>;
  constructor(read: (id: string, options: SessionHistoryReadOptions) => Promise<{ session: SessionDetail | null }>) { this.read = read; }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: NavigationState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  clear = () => {
    this.generation += 1;
    this.publish({ target: null, window: null, loading: false });
  };
  async navigate(target: TranscriptSearchTarget) {
    const generation = ++this.generation;
    this.publish({ target, window: null, loading: true });
    try {
      const { session } = await this.read(target.sessionId, {
        messageAround: target.messageId, messageLimit: PAGE_SIZE, contentLimit: 64 * 1024,
      });
      if (generation !== this.generation) return;
      if (!session?.messages.some((message) => message.id === target.messageId))
        throw new Error("Message no longer exists in this conversation.");
      this.publish({ target, window: session, loading: false });
    } catch (error) {
      if (generation === this.generation)
        this.publish({ target: null, window: null, loading: false, error: String(error) });
    }
  }
  async page(direction: "before" | "after") {
    const { window, target, loading } = this.state;
    if (!window || !target || loading) return;
    if (!(direction === "before" ? window.hasMoreBefore : window.hasMoreAfter)) return;
    const generation = this.generation;
    this.publish({ ...this.state, loading: true, error: undefined });
    try {
      const { session } = await this.read(target.sessionId, {
        messageBefore: direction === "before" ? window.messageStart : (window.messageEnd ?? 0) + PAGE_SIZE,
        messageLimit: PAGE_SIZE, contentLimit: 64 * 1024,
      });
      if (generation !== this.generation) return;
      if (!session) throw new Error("Conversation no longer exists.");
      const ordered = direction === "before"
        ? [...session.messages, ...window.messages] : [...window.messages, ...session.messages];
      const messages = [...new Map(ordered.map((message) => [message.id, message])).values()];
      // An overlapping page must not truncate the explicitly focused text.
      const focused = window.messages.find((message) => message.id === target.messageId);
      if (focused) messages[messages.findIndex((message) => message.id === focused.id)] = focused;
      this.publish({ target, loading: false, window: {
        ...session, messages,
        messageStart: Math.min(window.messageStart ?? 0, session.messageStart ?? 0),
        messageEnd: Math.max(window.messageEnd ?? 0, session.messageEnd ?? 0),
        hasMoreBefore: direction === "before" ? session.hasMoreBefore : window.hasMoreBefore,
        hasMoreAfter: direction === "after" ? session.hasMoreAfter : window.hasMoreAfter,
      } });
    } catch (error) {
      if (generation === this.generation)
        this.publish({ ...this.state, loading: false, error: String(error) });
    }
  }
}
