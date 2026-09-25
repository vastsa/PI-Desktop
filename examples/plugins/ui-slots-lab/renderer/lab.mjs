/**
 * What every lab sample shares: the running load's `pi`, a dispatch hook
 * that shows how a call ended, a crash switch, and the session tag.
 *
 * Every sample carries `data-lab="<slot>[:<side>]"`, and every result or
 * error code lands in a `data-lab-result` output, so a person reads the
 * outcome at a glance and the E2E reads it off the DOM.
 */
import { createElement as h, useState } from "react";

let labPi = null;

/** Keep the `pi` of the current load; the host hands a new one per load. */
export function bindLab(pi) {
  labPi = pi;
}

/**
 * One dispatch at a time, and what came of it: `idle`, `pending`, the text
 * `describe` made of the answer, or the error's `code`.
 */
export function useDispatch() {
  const [outcome, setOutcome] = useState({ status: "idle", text: "" });
  const run = (action, payload, describe = (value) => JSON.stringify(value)) => {
    setOutcome({ status: "pending", text: "…" });
    labPi.dispatch(action, payload).then(
      (value) => setOutcome({ status: "ok", text: describe(value) }),
      (error) => setOutcome({ status: "error", text: String(error?.code ?? "ERROR") }),
    );
  };
  return [outcome, run];
}

/** The outcome of `useDispatch`, as its sample shows it. */
export function Outcome({ outcome }) {
  return h(
    "output",
    { className: "lab-result", "data-lab-result": outcome.status },
    outcome.text,
  );
}

/**
 * A crash switch: `crash()` makes the next render of the calling component
 * throw, which the host has to contain.
 */
export function useCrash(where) {
  const [crashed, setCrashed] = useState(false);
  if (crashed) throw new Error(`lab: ${where} crashed on request`);
  return () => setCrashed(true);
}

/** The session a sample was mounted for, shortened for the eye. */
export function SessionTag({ sessionId }) {
  return h(
    "span",
    { className: "lab-session", "data-lab-session": sessionId, title: `session ${sessionId}` },
    sessionId ? sessionId.slice(0, 8) : "no session",
  );
}

export function Button({ lab, onClick, children, title }) {
  return h("button", { type: "button", className: "lab-btn", "data-lab-button": lab, title, onClick }, children);
}
