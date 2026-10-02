import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduledTaskRun, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/**
 * Bounded read of a run's transcript. The page never loads a whole session:
 * 60 newest messages with a 20k character ceiling per field keeps a run that
 * printed a huge tool result from freezing the Scheduled workspace.
 */
const TRANSCRIPT_MESSAGE_LIMIT = 60;
const TRANSCRIPT_CONTENT_LIMIT = 20_000;
/** A run that is still in flight keeps writing; follow it at the poll's pace. */
const LIVE_REFRESH_INTERVAL_MS = 5_000;

type Reading = {
  status: "idle" | "loading" | "ready" | "error";
  messages: UiMessage[];
  truncated: boolean;
};

const EMPTY_READING: Reading = { status: "idle", messages: [], truncated: false };

function roleLabelKey(role: UiMessage["role"]): string {
  switch (role) {
    case "user":
      return "chat.speakerYou";
    case "assistant":
      return "chat.speakerAssistant";
    case "tool":
      return "chat.toolCall";
    default:
      return "scheduled.roleSystem";
  }
}

function TranscriptMessage({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const text = message.content.trim();
  // A step with no text of its own adds nothing a reader can use here.
  if (!text) return null;
  return (
    <li className={`scheduled-message scheduled-message-${message.role}`}>
      <span className="scheduled-message-role">
        {message.role === "tool" && message.toolName
          ? message.toolName
          : t(roleLabelKey(message.role))}
      </span>
      <p className="scheduled-message-text" data-status={message.status ?? "complete"}>
        {text}
      </p>
    </li>
  );
}

/**
 * Read-only view of one run's transcript — the steps it took and the answer it
 * produced — rendered inside the Scheduled page so reviewing an automation
 * result never costs a conversation switch. The conversation itself stays one
 * explicit action away.
 */
export function ScheduledRunTranscript({ run }: { run: ScheduledTaskRun }) {
  const { t } = useTranslation();
  const sessionId = run.sessionId;
  const [reading, setReading] = useState<Reading>(EMPTY_READING);
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);

  const read = useCallback(async () => {
    const request = ++revision.current;
    if (!sessionId) {
      if (mounted.current) setReading(EMPTY_READING);
      return;
    }
    setReading((previous) => ({
      status: "loading",
      messages: previous.messages,
      truncated: previous.truncated,
    }));
    try {
      const result = await api.getSession(sessionId, {
        messageLimit: TRANSCRIPT_MESSAGE_LIMIT,
        contentLimit: TRANSCRIPT_CONTENT_LIMIT,
      });
      if (!mounted.current || request !== revision.current) return;
      const session = result.session;
      setReading({
        status: "ready",
        messages: session?.messages ?? [],
        truncated: session?.hasMoreBefore === true,
      });
    } catch {
      if (mounted.current && request === revision.current) {
        setReading({ ...EMPTY_READING, status: "error" });
      }
    }
  }, [sessionId]);

  // A run that finished after this card opened still carries the answer the
  // reader came for, so the read follows the run's own state, not just its id.
  useEffect(() => {
    void read();
  }, [read, run.status, run.endedAt]);

  useEffect(() => {
    if (run.status !== "running" || !sessionId) return;
    const timer = setInterval(() => void read(), LIVE_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [read, run.status, sessionId, run.endedAt]);

  if (!sessionId) {
    return <p className="scheduled-hint">{t("scheduled.runContentUnavailable")}</p>;
  }
  if (reading.status === "error") {
    return (
      <p className="scheduled-hint" role="alert">
        {t("scheduled.runContentError")}
      </p>
    );
  }
  if (reading.messages.length === 0) {
    return (
      <p className="scheduled-hint" role={reading.status === "loading" ? "status" : undefined}>
        {t(
          reading.status === "loading"
            ? "scheduled.runContentLoading"
            : "scheduled.runContentUnavailable",
        )}
      </p>
    );
  }
  return (
    <ol className="scheduled-transcript" aria-label={t("scheduled.runContent")}>
      {reading.truncated && (
        <li className="scheduled-hint scheduled-transcript-more">
          {t("scheduled.transcriptTruncated")}
        </li>
      )}
      {reading.messages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
    </ol>
  );
}
