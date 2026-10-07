import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { ToolDetailBlocks } from "../../apps/desktop/src/components/ToolDetails";
import { MAX_RENDERED_TEXT_PAGE_CODE_UNITS } from "../../apps/desktop/src/lib/render-content-limits";

const LARGE_TOOL_RESULT = `${"tool-output-line\n".repeat(40_960)}tool-result-final-marker`;

type Probe = {
  activeSession: "session-a" | "session-b";
  collapsed: boolean;
  inputValue: string;
  nativeClicks: number;
  receivedSource: string;
  sequence: number;
  streaming: boolean;
};

const probe: Probe = {
  activeSession: "session-a",
  collapsed: false,
  inputValue: "",
  nativeClicks: 0,
  receivedSource: "",
  sequence: 0,
  streaming: false,
};
let pushNext: ((sequence: number, delta: string) => void) | undefined;
let setStreamingState: ((streaming: boolean) => void) | undefined;
let appendToolOutput: ((text: string) => void) | undefined;

declare global {
  interface Window {
  finishRendererStream: () => void;
  appendStreamingToolOutput: (text: string) => void;
    pushRendererDelta: (sequence: number, delta: string) => void;
    readRendererProbe: () => Probe;
    startRendererStream: () => void;
    verifyRendererSource: (expected: string) => boolean;
    verifyLargeToolOutput: () => boolean;
  }
}

function Fixture() {
  const [activeSession, setActiveSession] = useState<Probe["activeSession"]>("session-a");
  const [sources, setSources] = useState({ "session-a": "", "session-b": "" });
  const [streaming, setStreaming] = useState(false);
  const [streamingToolOutput, setStreamingToolOutput] = useState(LARGE_TOOL_RESULT);
  const [collapsed, setCollapsed] = useState(false);
  const [inputValue, setInputValue] = useState("");
  pushNext = (sequence, delta) => {
    if (sequence !== probe.sequence + 1) throw new Error(`out-of-order fixture delta ${sequence}`);
    probe.sequence = sequence;
    probe.receivedSource += delta;
    setSources((current) => ({ ...current, "session-a": current["session-a"] + delta }));
  };
  setStreamingState = (value) => {
    probe.streaming = value;
    setStreaming(value);
  };
  appendToolOutput = (text) => setStreamingToolOutput((current) => current + text);

  const toggleSession = () => {
    const next = activeSession === "session-a" ? "session-b" : "session-a";
    probe.activeSession = next;
    setActiveSession(next);
  };
  const toggleCollapsed = () => {
    const next = !collapsed;
    probe.collapsed = next;
    setCollapsed(next);
  };

  return (
    <main>
      <header>
        <button id="native-action" onClick={() => { probe.nativeClicks += 1; }}>Native action</button>
        <input
          id="native-input"
          aria-label="Draft"
          value={inputValue}
          onChange={(event) => {
            probe.inputValue = event.target.value;
            setInputValue(event.target.value);
          }}
        />
        <button id="switch-session" onClick={toggleSession}>Switch session</button>
        <button id="toggle-collapse" aria-expanded={!collapsed} onClick={toggleCollapsed}>
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </header>
      <p id="load-state" data-streaming={streaming} data-sequence={probe.sequence}>
        {streaming ? "Streaming" : "Complete"} {probe.sequence}
      </p>
      <section id="large-tool-result" aria-label="Large tool result">
        <ToolDetailBlocks
          blocks={[{
            kind: "code",
            role: "stdout",
            text: LARGE_TOOL_RESULT,
            lang: "",
            highlight: false,
          }]}
        />
      </section>
      <section id="streaming-tool-result" aria-label="Streaming tool result">
        <ToolDetailBlocks
          blocks={[{
            kind: "code",
            role: "stdout",
            text: streamingToolOutput,
            lang: "",
            highlight: false,
          }]}
          streaming
        />
      </section>
      <section id="scroll-area" aria-label="Transcript" tabIndex={0}>
        <div id="message" data-source-length={sources[activeSession].length}>
          {!collapsed && sources[activeSession] ? (
            <div className="prose-chat">
              <Markdown source={sources[activeSession]} streaming={streaming && activeSession === "session-a"} />
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

const i18n = createInstance();
void i18n.init({ lng: "en", resources: { en: { translation: en } } }).then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>,
  );

  window.startRendererStream = () => setStreamingState?.(true);
  window.finishRendererStream = () => setStreamingState?.(false);
  window.appendStreamingToolOutput = (text) => appendToolOutput?.(text);
  window.pushRendererDelta = (sequence, delta) => pushNext?.(sequence, delta);
  window.readRendererProbe = () => ({ ...probe });
  window.verifyRendererSource = (expected) =>
    probe.receivedSource === expected &&
    document.querySelector("#message")?.getAttribute("data-source-length") === String(expected.length);
  window.verifyLargeToolOutput = () => {
    const root = document.querySelector("#large-tool-result .large-text-preview");
    const page = root?.querySelector("pre");
    return root?.getAttribute("data-page-count") === String(Math.ceil(LARGE_TOOL_RESULT.length / MAX_RENDERED_TEXT_PAGE_CODE_UNITS)) &&
      root?.querySelectorAll("pre").length === 1 &&
      Boolean(page) && page!.textContent!.length <= MAX_RENDERED_TEXT_PAGE_CODE_UNITS + 1;
  };
});
