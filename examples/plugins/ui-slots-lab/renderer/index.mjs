/**
 * UI Slots Lab — renderer entry (`lab.ui-slots`).
 *
 * One visible sample in every renderer slot, each able to exercise the parts
 * of the contract a person or the Electron E2E has to see working: dispatch
 * round trips and their error codes, a crash the host contains, the host's
 * size clamps, self-drawn layers over the app, the `#` trigger, and the
 * draft and attachment words. A plain ES module with
 * no build step; `react` and `react-dom` resolve to the host's through the
 * window's import map.
 */
import { bindLab } from "./lab.mjs";
import { ChartBlock, ProbeCard } from "./blocks.mjs";
import { ComposerControl, ComposerCrash, ComposerDraft, issueItems } from "./composer.mjs";
import { LayerLauncher } from "./layers.mjs";
import {
  AssistantAction,
  AssistantCrash,
  AssistantFolded,
  AssistantRefuse,
  EntryNotes,
  EntryPanel,
  UserAction,
} from "./messages.mjs";
import { LAB_CSS } from "./styles.mjs";

export function onLoad(pi) {
  bindLab(pi);
  pi.ui.injectStyle(LAB_CSS);

  pi.slots.register({ slot: "userAction", component: UserAction });

  pi.slots.register({ slot: "assistantAction", component: AssistantAction });
  pi.slots.register({ slot: "assistantAction", component: AssistantRefuse, positions: ["right"] });
  pi.slots.register({ slot: "assistantAction", component: AssistantCrash, positions: ["right"] });
  pi.slots.register({ slot: "assistantAction", component: AssistantFolded, positions: ["right"] });

  pi.slots.register({ slot: "entryExtra", component: EntryPanel });
  pi.slots.register({ slot: "entryExtra", component: EntryNotes });

  pi.slots.register({ slot: "toolCard", toolName: "lab_probe", component: ProbeCard });
  pi.slots.register({ slot: "blockRenderer", language: `${pi.plugin.id}:chart`, component: ChartBlock });

  pi.slots.register({ slot: "composerControl", component: ComposerControl });
  pi.slots.register({ slot: "composerControl", component: ComposerDraft, positions: ["left"] });
  pi.slots.register({ slot: "composerControl", component: ComposerCrash, positions: ["right"] });
  pi.slots.register({ slot: "composerControl", component: LayerLauncher, positions: ["right"] });
  pi.slots.register({ slot: "composerTrigger", trigger: "#", items: issueItems });
}
