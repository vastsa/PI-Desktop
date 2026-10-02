/**
 * Real React/Chromium regression for the compact AskTool card.
 *
 * The compact layout moved the skip / next / submit buttons from a bottom
 * action row into the card header, which changed DOM order and therefore the
 * keyboard Tab sequence. This probe mounts the production `AskToolCard`
 * against the real store slice with a stubbed `api.resolveAskTool` and walks
 * the user-visible paths: the new header action order, select → next →
 * submit, skip → submit, decline-all, and a custom answer.
 *
 * Scenario: E2E-ASKTOOL-compact-card-interaction.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const SESSION_ID = "asktool-card";

declare global {
  var asktoolCardProbe: () => Promise<unknown>;
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`AskTool card: ${label}`);
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`AskTool card never settled: ${label}`);
}

type FixtureQuestion = {
  question: string;
  options: Array<{ label: string; description: string }>;
};

function askRequest(requestId: string, questions: FixtureQuestion[]) {
  return {
    sessionId: SESSION_ID,
    requestId,
    toolCallId: `tool-${requestId}`,
    questions,
  };
}

const QUESTIONS: FixtureQuestion[] = [
  {
    question: "Which upgrade path?",
    options: [
      { label: "alpha", description: "First choice" },
      { label: "beta", description: "Second choice" },
    ],
  },
  {
    question: "Allow rollback?",
    options: [{ label: "gamma", description: "Third choice" }],
  },
];

export async function asktoolCardProbe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const originalResolve = api.resolveAskTool;
  const resolutions: Array<{ requestId: string; answers: unknown }> = [];
  api.resolveAskTool = (async (resolution: {
    requestId: string;
    answers: unknown;
  }) => {
    resolutions.push(resolution);
    return { ok: true };
  }) as typeof api.resolveAskTool;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:auto;background:#141414";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  const element = <T extends HTMLElement = HTMLElement>(
    selector: string,
  ): T => {
    const found = host.querySelector<T>(selector);
    assert(found, `missing ${selector}`);
    return found as T;
  };
  const options = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".asktool-option")].filter(
      (button) => !button.classList.contains("asktool-custom-option"),
    );
  const headerButtons = () => ({
    decline: element<HTMLButtonElement>(".asktool-decline"),
    skip: element<HTMLButtonElement>(
      ".asktool-card-header-actions .btn-ghost",
    ),
    primary: element<HTMLButtonElement>(
      ".asktool-card-header-actions .btn-primary",
    ),
  });
  // Fixture question bodies (not translated strings) identify the current
  // question independent of the active locale.
  const questionText = () =>
    element(".asktool-question").textContent ?? "";
  const mount = (requestId: string) => {
    const request = askRequest(requestId, QUESTIONS);
    useAppStore.setState({
      pendingAsks: { [SESSION_ID]: [request] },
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <AskToolCard key={requestId} request={request} />
        </I18nextProvider>,
      ),
    );
    return request;
  };
  try {
    mount("ask-dom");
    await until(
      () => options().length === QUESTIONS[0]!.options.length,
      "first question options mount",
    );

    // The header carries every confirmation affordance now that the bottom
    // action row is gone, so Tab reaches them in this exact DOM order.
    assert(
      host.querySelector(".asktool-card-actions") === null,
      "the legacy bottom action row is gone",
    );
    const tabbables = [...host.querySelectorAll("button")];
    const orderOf = (selector: string) =>
      tabbables.findIndex((node) => node.matches(selector));
    const declineAt = orderOf(".asktool-decline");
    const skipAt = orderOf(
      ".asktool-card-header-actions .btn-ghost",
    );
    const primaryAt = orderOf(
      ".asktool-card-header-actions .btn-primary",
    );
    const firstOptionAt = orderOf(
      ".asktool-options .asktool-option",
    );
    assert(
      declineAt !== -1 && skipAt !== -1 && primaryAt !== -1,
      "header actions mount",
    );
    assert(
      declineAt < skipAt && skipAt < primaryAt,
      `header Tab order is decline, skip, next (saw ${declineAt}, ${skipAt}, ${primaryAt})`,
    );
    assert(
      primaryAt < firstOptionAt,
      "header actions tab before the options",
    );

    // Flow A: select → next → answer → submit.
    flushSync(() => options()[0]!.click());
    assert(
      options()[0]!.classList.contains("selected"),
      "the clicked option is selected",
    );
    assert(
      questionText().includes("Which upgrade path?"),
      "the card starts on question 1",
    );
    flushSync(() => headerButtons().primary.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "next advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 1, "submit resolves the ask");
    assert(
      resolutions[0]!.requestId === "ask-dom",
      "the resolution carries the request id",
    );
    assert(
      JSON.stringify(resolutions[0]!.answers) ===
        JSON.stringify([["alpha"], ["gamma"]]),
      `select/next/submit answers survive, saw ${JSON.stringify(resolutions[0]!.answers)}`,
    );

    // Flow B: skip the first question, answer the second, submit.
    mount("ask-skip");
    await until(() => options().length > 0, "skip flow mounts");
    flushSync(() => headerButtons().skip.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "skip advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 2, "skip flow resolves");
    assert(
      JSON.stringify(resolutions[1]!.answers) ===
        JSON.stringify([null, ["gamma"]]),
      `skip records a null answer, saw ${JSON.stringify(resolutions[1]!.answers)}`,
    );

    // Flow C: decline everything from the header.
    mount("ask-decline");
    await until(() => options().length > 0, "decline flow mounts");
    flushSync(() => headerButtons().decline.click());
    await until(() => resolutions.length === 3, "decline resolves");
    assert(
      JSON.stringify(resolutions[2]!.answers) ===
        JSON.stringify([null, null]),
      `decline-all nulls every answer, saw ${JSON.stringify(resolutions[2]!.answers)}`,
    );

    // Flow D: a custom answer still flows through the header submit.
    mount("ask-custom");
    await until(() => options().length > 0, "custom flow mounts");
    flushSync(() =>
      element(".asktool-custom-option").click(),
    );
    const input = element<HTMLInputElement>(".asktool-custom-input");
    // Bypass React's instance value tracker: a plain assignment updates the
    // tracker too, so the input event would read as unchanged and onChange
    // would never fire. The prototype setter leaves the tracker behind.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    nativeValueSetter.call(input, "my reason");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    flushSync(() => headerButtons().primary.click());
    await until(
      () => questionText().includes("Allow rollback?"),
      "custom answer advances to question 2",
    );
    flushSync(() => options()[0]!.click());
    flushSync(() => headerButtons().primary.click());
    await until(() => resolutions.length === 4, "custom flow resolves");
    assert(
      JSON.stringify(resolutions[3]!.answers) ===
        JSON.stringify([["my reason"], ["gamma"]]),
      `custom text survives, saw ${JSON.stringify(resolutions[3]!.answers)}`,
    );

    assert(errors.length === 0, `render errors: ${errors.map(String)}`);
    return { ok: true, resolutions: resolutions.length };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.resolveAskTool = originalResolve;
    useAppStore.setState({
      pendingAsks: initial.pendingAsks,
      activeSessionId: initial.activeSessionId,
    });
  }
}

globalThis.asktoolCardProbe = asktoolCardProbe;
