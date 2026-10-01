import type { AskToolQuestion } from "@pi-desktop/shared";
import { askToolOptionLabel } from "@pi-desktop/shared";
import type { LiveWorkPendingQuestion, LiveWorkQuestionAnswer } from "@pi-desktop/host-runtime";

/**
 * What the voice surface may read out and what a spoken answer may select:
 * one open question, bounded, with the question's own options.
 *
 * A spoken answer is never free text. It either selects among the labels the
 * question already offers or it is refused, so a provider can never answer a
 * question with content the user was not asked about.
 */
export const MAX_ASK_QUESTIONS = 8;
export const MAX_ASK_OPTIONS = 8;
export const MAX_ASK_QUESTION_CHARS = 300;
export const MAX_ASK_OPTION_CHARS = 120;

/** One line, bounded: what is read out and what the answer is matched against. */
export function boundSpokenText(value: string | undefined, limit: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** The bounded question view, or `null` when there is nothing answerable. */
export function toPendingQuestion(
  open: { questions: readonly AskToolQuestion[] } | null | undefined,
): LiveWorkPendingQuestion | null {
  if (!open || open.questions.length === 0 || open.questions.length > MAX_ASK_QUESTIONS) return null;
  return {
    questions: open.questions.map((question) => ({
      question: boundSpokenText(question.question, MAX_ASK_QUESTION_CHARS),
      options: question.options
        .slice(0, MAX_ASK_OPTIONS)
        .map((option) => boundSpokenText(askToolOptionLabel(option), MAX_ASK_OPTION_CHARS)),
      multiSelect: question.multiSelect === true,
    })),
  };
}

/**
 * Map a spoken answer onto the open question's own options.
 *
 * Every question must be answered exactly once, and every chosen label must be
 * one of that question's own labels. Anything else returns `null` so the caller
 * rejects instead of half-answering: the runtime reads a missing answer as
 * "skipped", and the user never said that.
 */
export function buildSpokenAnswers(
  questions: readonly AskToolQuestion[],
  provided: readonly LiveWorkQuestionAnswer[],
): Array<string[] | null> | null {
  if (questions.length === 0 || provided.length !== questions.length) return null;
  const answers: Array<string[] | null> = questions.map(() => null);
  for (const answer of provided) {
    const question = questions[answer.questionIndex];
    if (!question) return null;
    const labels = question.options.map(askToolOptionLabel);
    if (answer.options.some((label) => !labels.includes(label))) return null;
    if (answer.options.length > 1 && question.multiSelect !== true) return null;
    answers[answer.questionIndex] = [...answer.options];
  }
  return answers.every((entry) => entry !== null) ? answers : null;
}

/** The live feedback channel accepts a bounded message; whole questions only. */
export const MAX_SPOKEN_QUESTION_BYTES = 1_100;

/**
 * What the voice surface has to say about an open question: the question, the
 * options the question itself offers, and the rule that a spoken answer may
 * only select among them. Truncated on question boundaries, so a long ask never
 * fails delivery, and `null` when there is nothing to answer.
 */
export function spokenQuestion(pendingQuestion?: LiveWorkPendingQuestion): string | null {
  const questions = pendingQuestion?.questions ?? [];
  if (questions.length === 0) return null;
  const header = "The work session is waiting for an answer. Read each question and its options to the user, then submit the user's answer through delegate_to_work_session using exactly those option labels. An answer can only select among these options and never invents one, and it is not approval for a permission, Plan, or Goal request.";
  const sections = questions.map((question, index) => {
    const options = question.options.map((option) => `- ${option}`).join("\n");
    const kind = question.multiSelect ? " (choose one or more)" : "";
    return `Question ${index + 1}${kind}: ${question.question}${options ? `\nOptions:\n${options}` : ""}`;
  });
  const encoder = new TextEncoder();
  let text = header;
  for (const section of sections) {
    const candidate = `${text}\n${section}`;
    if (encoder.encode(candidate).byteLength > MAX_SPOKEN_QUESTION_BYTES) break;
    text = candidate;
  }
  return text;
}
