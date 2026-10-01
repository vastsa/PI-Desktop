/**
 * Full-stack feedback loop for #929.
 *
 * `composer-ime-slash-menu.tsx` drives `useComposerAutocomplete` directly and
 * stays green, so the defect is not in that hook's trigger state. This fixture
 * mounts the pieces Composer actually wires together — `useComposerDraft` +
 * `useComposerCompletions` + `ComposerInput` — and drives the contenteditable
 * with the native event sequence a Windows Chinese IME produces, so the caret
 * restore, the ideographic-comma rewrite and the completion controller all take
 * part.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance, type TFunction } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { useComposerDraft } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import { api } from "../../apps/desktop/src/lib/api";
import { setEditorCaret } from "../../apps/desktop/src/features/chat/composer/editor";

declare global {
  var composerImeStackProbe: () => Promise<unknown>;
}

api.composerCommands = async () => ({
  commands: [
    { name: "review", title: "review", kind: "skill" },
    { name: "rewrite", title: "rewrite", kind: "skill" },
  ],
});

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;
const i18n = createInstance();

let acState: { open: boolean; hasItems: boolean; mode: string | null } = {
  open: false,
  hasItems: false,
  mode: null,
};
let draftValue = "";
let draftComposing = false;

function Fixture() {
  const draft = useComposerDraft({
    variant: "docked",
    activeSessionId: "s1",
    workspacePath: "/ws",
    sessions: [{ id: "s1" }],
    composerPrefill: null,
    clearComposerPrefill: noop,
    t,
    invalidatePromptEnhancement: noop,
    inputBlocked: false,
  });
  const completions = useComposerCompletions({
    value: draft.value,
    cursor: draft.cursor,
    composing: draft.composing,
    enabled: true,
    referenceSessionId: null,
    fileReferencesRef: draft.fileReferencesRef,
    applyEditorDraft: noop,
    handleInput: draft.handleInput,
    invalidatePromptEnhancement: noop,
  });
  draftValue = draft.value;
  draftComposing = draft.composing;
  acState = {
    open: completions.ac.open,
    hasItems: completions.ac.hasItems,
    mode: completions.ac.mode ?? null,
  };
  return (
    <I18nextProvider i18n={i18n}>
      <ComposerInput
        inputRef={draft.ref}
        value={draft.value}
        placeholderText=""
        placeholderKey="fixture"
        inputBlocked={false}
        pasting={false}
        enterToSend={false}
        runActive={false}
        composerAc={completions.ac}
        onPaste={noop}
        onAcceptCompletion={completions.acceptCompletion}
        onSubmit={noop}
        onInsertNewline={noop}
        onHistoryNavigate={() => false}
        onInput={(source, caret) => completions.handleInput(source, caret)}
        onCompositionStart={() => draft.setComposing(true)}
        onCompositionEnd={() => draft.setComposing(false)}
        onSettledInput={() => draft.setComposing(false)}
        onFocus={noop}
        onBlur={noop}
      />
      <ComposerAutocomplete
        anchorRef={draft.ref as React.RefObject<HTMLDivElement>}
        ac={completions.ac}
        onAccept={completions.acceptCompletion}
      />
    </I18nextProvider>
  );
}

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

const editor = () => document.querySelector<HTMLElement>(".composer-input")!;

/**
 * Replace the editor text and fire the events an IME fires.
 * `endComposition: false` models an IME that never reports the end.
 */
const type = async (text: string, opts: { composing?: boolean; endComposition?: boolean } = {}) => {
  const el = editor();
  el.textContent = text;
  setEditorCaret(el, text.length);
  // Let the controlled editor repaint to the previous value before the event,
  // so the input we dispatch is the one React actually sees.
  await settle();
  if (opts.composing) {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  }
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
      isComposing: opts.composing === true,
    }),
  );
  if (opts.composing && opts.endComposition !== false) {
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }
  await settle();
};

globalThis.composerImeStackProbe = async () => {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
  flushSync(() => root.render(<Fixture />));
  await settle();
  editor().focus();

  const trace: Array<Record<string, unknown>> = [];
  const snap = (label: string) => {
    trace.push({ label, draftValue, composing: draftComposing, ...acState });
    return acState.open;
  };

  // --- The ordinary path must keep working -------------------------------
  snap("mounted");
  await type("/、", { composing: true });
  snap("IME /、");
  await type("", { composing: true });
  snap("deleted (composing)");
  await type("", { composing: false });
  snap("empty, settled");
  await type("/", { composing: false });
  const normal = snap("typed /");
  await type("/re", { composing: false });
  const normalQuery = snap("typed /re");

  // --- A compositionend that never arrives -------------------------------
  // A Windows Chinese IME can drop compositionend when the composing text is
  // deleted. `composing` is component state in useComposerDraft, so a flag
  // stuck true freezes the trigger and only an unmount clears it — which is
  // the "a new conversation is the only escape" half of the report.
  await type("", { composing: false });
  await type("/、", { composing: true, endComposition: false });
  snap("compositionend dropped");
  // The browser's own composition is over, so what follows is ordinary input
  // with isComposing false even though the app never heard about it.
  await type("", { composing: false });
  snap("deleted after dropped compositionend");
  await type("/", { composing: false });
  const recovered = snap("typed / after dropped compositionend");

  return {
    ok: normal === true && normalQuery === true && recovered === true,
    normal,
    normalQuery,
    recovered,
    trace,
  };
};
