// Drives the UI Slots Lab through the real app: prompts go through the MCP
// control plane, and every assertion reads the renderer DOM the host slots
// draw into, by the lab's `data-lab="<slot>[:<side>]"` markers.
import { driveComposerDraft } from "./composer-draft.mjs";
import { PROBE_TOOL } from "./stub-model.mjs";

const LAB = "lab.ui-slots";
/** The host's block clamp (`BLOCK_RENDERER_MAX_HEIGHT_PX`). */
const BLOCK_MAX_PX = 4_000;
/** The entryExtra collapsed height (`ENTRY_EXTRA_COLLAPSED_MAX_HEIGHT`). */
const ENTRY_COLLAPSED_PX = 320;

/*
 * A fresh profile opens the one-time Mid-Autumn launch overlay over the shell,
 * which traps focus and restores its own on close. Its seen flag
 * (`lib/mid-autumn-egg-preferences.ts`) keeps it shut for the whole run.
 */
function markLaunchEggSeen() {
  localStorage.setItem("pi.desktop.midAutumnEggSeen.v2", "1");
  return true;
}

/* Page-side helpers, installed into every document of the window. */
function installPageHelpers() {
  const turns = () => [...document.querySelectorAll(".message-row.assistant-turn")];
  // Every read names its root; a missing turn reads as empty, never as the page.
  const one = (root, lab) => root?.querySelector(`[data-lab="${lab}"]`) ?? null;
  window.__labE2E = {
    turn: (index) => turns().at(index) ?? null,
    userRow: (index) => [...document.querySelectorAll('.message-row[data-row-role="user"]')].at(index) ?? null,
    labs: (root) => [...(root?.querySelectorAll("[data-lab]") ?? [])].map((node) => node.getAttribute("data-lab")),
    sessions: (root) => [
      ...new Set([...(root?.querySelectorAll("[data-lab-session]") ?? [])].map((node) => node.getAttribute("data-lab-session"))),
    ],
    one,
    click(root, lab, button) {
      const target = one(root, lab)?.querySelector(`[data-lab-button="${button}"]`);
      target?.click();
      return Boolean(target);
    },
    result(root, lab) {
      const out = one(root, lab)?.querySelector("[data-lab-result]");
      return out ? { status: out.getAttribute("data-lab-result"), text: out.textContent } : null;
    },
    /** The right-side ⋯ menu of the first reply. */
    menu() {
      const turn = turns()[0];
      const root = turn?.querySelector('.pi-action-overflow[data-side="right"]');
      const button = root?.querySelector(".pi-action-overflow-btn");
      return {
        found: Boolean(root),
        expanded: button?.getAttribute("aria-expanded") ?? null,
        folded: Boolean(one(turn, "assistantAction:folded")),
        focused: Boolean(button) && document.activeElement === button,
        active: document.activeElement?.className || document.activeElement?.tagName || null,
        hasFocus: document.hasFocus(),
      };
    },
    composerText() {
      const input = document.querySelector(".composer-input");
      return input ? (input.value ?? input.textContent) : null;
    },
    /** The lab's self-drawn layers, and what the pointer meets over them. */
    layers() {
      const root = document.getElementById("pi-plugin-layers");
      const layerOf = (lab) => {
        const sample = one(document, lab);
        const layer = sample?.closest("[data-pi-layer]");
        if (!sample || !layer) return null;
        const box = (sample.querySelector(".p-dialog, .p-notice") ?? sample).getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          z: Number(layer.style.zIndex),
          readout: sample.querySelector("[data-lab-layer-z]")?.getAttribute("data-lab-layer-z") ?? null,
          plugin: layer.getAttribute("data-pi-plugin"),
          inRoot: layer.parentElement === root,
          onTop: Boolean(hit && sample.contains(hit)),
          step: sample.querySelector("[data-lab-step]")?.getAttribute("data-lab-step") ?? null,
        };
      };
      return {
        root: root ? { hidden: root.hidden, inert: root.inert, layers: root.children.length } : null,
        wizard: layerOf("layer:wizard"),
        notice: layerOf("layer:notice"),
      };
    },
  };
  return true;
}

export async function drive({ control, renderer, check, project }) {
  const page = renderer.run;
  const until = renderer.until;
  const prompt = async (sessionId, content) => {
    await control.tool("pi_agent_prompt", { sessionId, content });
    await control.waitForTurn(sessionId);
  };
  // A sample's dispatch outcome once it leaves `pending`.
  const settled = (turnIndex, lab, label, timeoutMs) =>
    until(
      ({ turnIndex, lab }) => {
        const root = turnIndex === null ? document : window.__labE2E.turn(turnIndex);
        const result = window.__labE2E.result(root, lab);
        return result && result.status !== "pending" && result.status !== "idle" ? result : null;
      },
      { turnIndex, lab },
      label,
      timeoutMs,
    );
  const clickIn = (turnIndex, lab, button) =>
    page(({ turnIndex, lab, button }) => {
      const root = turnIndex === null ? document : window.__labE2E.turn(turnIndex);
      return window.__labE2E.click(root, lab, button);
    }, { turnIndex, lab, button });

  await control.tool("pi_project_open", { path: project });
  const created = await control.tool("pi_session_create", { title: "ui slots lab", projectPath: project, mode: "agent" });
  const sessionId = created?.session?.id ?? created?.id;
  check("session created", Boolean(sessionId), sessionId);
  // The lab's tool is low risk; Auto keeps the run free of approval prompts.
  await control.tool("pi_session_configure", { id: sessionId, mode: "agent", permissionMode: "auto", confirm: true });

  await renderer.install(markLaunchEggSeen);
  await renderer.install(installPageHelpers);
  // The reload drops a launch overlay that opened before the flag was set.
  await renderer.reload();
  // The shell is up once its boot splash is gone: until then it is mounted but
  // hidden, and selecting before it races the startup navigation.
  await until(
    () =>
      typeof window.__PI_DESKTOP__?.selectSession === "function" &&
      Boolean(document.querySelector(".app-shell:not(.is-booting) .composer-input")),
    null,
    "app shell",
    90_000,
  );
  await until((id) => window.__PI_DESKTOP__.selectSession(id).then(() => true), sessionId, "session selected");
  await until(() => Boolean(document.querySelector('[data-lab="composerControl:left"]')), null, "lab composer controls", 30_000);
  check("the lab's renderer entry loaded into the open window", true);

  // --- one turn fills every transcript slot -------------------------------
  await prompt(sessionId, "lab: probe ok");
  await until(() => Boolean(window.__labE2E.one(window.__labE2E.turn(0), "entryExtra")), null, "entryExtra under the reply");

  const layout = await page(() => {
    const e2e = window.__labE2E;
    const turn = e2e.turn(0);
    return {
      user: e2e.labs(e2e.userRow(0)),
      turn: e2e.labs(turn),
      toolbar: e2e.labs(document).filter((lab) => lab.startsWith("composerControl")),
      sessions: e2e.sessions(document),
      mounts: [...new Set([...document.querySelectorAll("[data-pi-plugin]")].map((node) => node.getAttribute("data-pi-plugin")))],
    };
  });
  check("userAction samples sit on both sides of the user bar", sameSet(layout.user, ["userAction:left", "userAction:right"]), layout.user.join(","));
  check(
    "the reply carries toolCard, blockRenderer, every visible assistantAction, and both entryExtra blocks",
    sameSet(layout.turn, [
      "toolCard",
      "blockRenderer",
      "assistantAction:left",
      "assistantAction:right",
      "assistantAction:refuse",
      "assistantAction:crash",
      "entryExtra",
      "entryExtra:notes",
    ]),
    layout.turn.join(","),
  );
  check(
    "composerControl samples sit on both toolbar sides",
    sameSet(layout.toolbar, [
      "composerControl:left",
      "composerControl:draft",
      "composerControl:right",
      "composerControl:crash",
      "composerControl:layers",
    ]),
    layout.toolbar.join(","),
  );
  check("every sample was mounted for the open session", layout.sessions.length === 1 && layout.sessions[0] === sessionId, layout.sessions.join(","));
  check("every mount belongs to the lab", layout.mounts.length === 1 && layout.mounts[0] === LAB, layout.mounts.join(","));

  const blocks = await page(() => {
    const turn = window.__labE2E.turn(0);
    const card = window.__labE2E.one(turn, "toolCard");
    const chart = window.__labE2E.one(turn, "blockRenderer");
    const clamp = chart?.closest(".pi-plugin-block-renderer");
    return {
      status: card?.getAttribute("data-lab-status"),
      output: card?.querySelector("[data-lab-output]")?.textContent ?? "",
      call: card?.querySelector("[data-lab-call]")?.getAttribute("data-lab-call") ?? "",
      language: chart?.getAttribute("data-lab-language"),
      bars: chart?.querySelectorAll(".lab-bar-row").length ?? 0,
      clampHeight: clamp?.scrollHeight ?? -1,
      hostBlocks: turn.querySelectorAll(".code-block").length,
    };
  });
  check("the toolCard draws the finished probe call", blocks.status === "success" && blocks.output.includes('"ok":true') && blocks.call.length > 0, JSON.stringify(blocks));
  check(
    "the blockRenderer draws the claimed fence inside the host clamp",
    blocks.language === `${LAB}:chart` && blocks.bars === 2 && blocks.clampHeight > 0 && blocks.clampHeight <= BLOCK_MAX_PX && blocks.hostBlocks === 0,
    JSON.stringify(blocks),
  );

  const styles = await page(() => {
    const sample = document.querySelector('[data-lab="entryExtra"]');
    const stray = document.createElement("div");
    stray.className = "lab-card";
    document.body.appendChild(stray);
    const outside = getComputedStyle(stray).borderTopStyle;
    stray.remove();
    return {
      inside: getComputedStyle(sample).borderTopStyle,
      outside,
      sheets: document.querySelectorAll('style[data-pi-plugin-style="lab.ui-slots"]').length,
    };
  });
  check("the lab's sheet styles its own mounts and nothing outside them", styles.inside === "dashed" && styles.outside !== "dashed" && styles.sheets === 1, JSON.stringify(styles));

  // --- the ⋯ menu -----------------------------------------------------------
  // Each step acts in one evaluation and waits for React's commit in the next.
  const menu = async (action, expanded) => {
    await page((action) => {
      const root = window.__labE2E.turn(0).querySelector('.pi-action-overflow[data-side="right"]');
      if (action === "toggle") root?.querySelector(".pi-action-overflow-btn")?.click();
      if (action === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (action === "outside") document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (action === "inside") {
        root?.querySelector('[data-lab="assistantAction:folded"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      }
      return true;
    }, action);
    // A step that should change nothing gets a moment to prove it.
    if (action === "inside") await new Promise((done) => setTimeout(done, 200));
    return until(
      (expanded) => {
        const state = window.__labE2E.menu();
        return state.expanded === expanded ? state : null;
      },
      expanded,
      `⋯ menu aria-expanded=${expanded} after ${action}`,
      5_000,
    ).catch((error) => ({ error: error.message }));
  };
  const closed = await page(() => window.__labE2E.menu());
  check("the fourth right item waits in a closed ⋯ menu", closed.found && closed.expanded === "false" && !closed.folded, JSON.stringify(closed));
  const opened = await menu("toggle", "true");
  check("⋯ opens onto the folded item", opened.folded === true, JSON.stringify(opened));
  const escaped = await menu("escape", "false");
  check("Escape closes ⋯ and hands focus back to its key", escaped.folded === false && escaped.focused, JSON.stringify(escaped));
  await menu("toggle", "true");
  const kept = await menu("inside", "true");
  check("a press inside the menu keeps it open", kept.folded === true, JSON.stringify(kept));
  const outside = await menu("outside", "false");
  check("a press outside closes ⋯", outside.folded === false, JSON.stringify(outside));
  await menu("toggle", "true");
  await clickIn(0, "assistantAction:folded", "folded");
  const folded = await settled(0, "assistantAction:folded", "folded item outcome");
  const afterFolded = await page(() => window.__labE2E.composerText());
  check("the folded item works from the menu", folded.text === "inserted" && afterFolded.includes("lab: sent from the ⋯ menu"), JSON.stringify([folded, afterFolded]));
  await menu("escape", "false");

  // --- dispatch round trips -------------------------------------------------
  await clickIn(0, "assistantAction:left", "echo");
  const echo = await settled(0, "assistantAction:left", "assistant echo");
  check("plugin.call round-trips to the headless entry", echo.status === "ok" && echo.text === "echo ✓", JSON.stringify(echo));
  await clickIn(0, "assistantAction:refuse", "refuse");
  const refused = await settled(0, "assistantAction:refuse", "refuse outcome");
  check("a plugin's own error code comes back unchanged", refused.status === "error" && refused.text === "LAB_REFUSED", JSON.stringify(refused));
  const stallStarted = Date.now();
  await clickIn(0, "entryExtra", "stall");
  const stalled = await settled(0, "entryExtra", "stall outcome", 10_000);
  const stallMs = Date.now() - stallStarted;
  check("a stalled call ends at the host's budget", stalled.text === "PLUGIN_CALL_TIMEOUT" && stallMs < 4_500, `${JSON.stringify(stalled)} after ${stallMs}ms`);

  const messageId = await page(() => window.__labE2E.one(window.__labE2E.turn(0), "entryExtra").querySelector("[data-lab-message]")?.getAttribute("data-lab-message") ?? "");
  await clickIn(0, "entryExtra", "insert");
  await settled(0, "entryExtra", "insert outcome");
  await page(() => window.__labE2E.click(window.__labE2E.userRow(0), "userAction:right", "quote"));
  await clickIn(null, "composerControl:left", "insert");
  await settled(null, "composerControl:left", "composer insert outcome");
  const draft = await until(
    () => {
      const text = window.__labE2E.composerText() ?? "";
      return text.includes("> lab: probe ok") ? text : null;
    },
    null,
    "quoted user message in the composer",
  );
  check(
    "composer.insertText lands in the draft from every slot",
    Boolean(messageId) && draft.includes(`lab: about ${messageId}`) && draft.includes("lab: hello from the composer"),
    JSON.stringify(draft),
  );
  await clickIn(null, "composerControl:right", "echo");
  const composerEcho = await settled(null, "composerControl:right", "composer echo");
  check("a composer control round-trips plugin.call", composerEcho.text === "✓", JSON.stringify(composerEcho));
  await driveComposerDraft({ renderer, check });

  // --- entryExtra height ------------------------------------------------------
  const entryBlock = (action) =>
    page((action) => {
      const panel = window.__labE2E.one(window.__labE2E.turn(0), "entryExtra");
      const block = panel?.closest(".pi-entry-extra-block");
      const toggle = block?.querySelector(".pi-entry-extra-toggle");
      if (action === "toggle") toggle?.click();
      const viewport = block?.querySelector(".pi-entry-extra-viewport");
      return {
        toggle: Boolean(toggle),
        expanded: toggle?.getAttribute("aria-expanded") ?? null,
        clipped: viewport?.getAttribute("data-clipped") ?? null,
        height: viewport?.clientHeight ?? -1,
        grown: Boolean(panel?.querySelector("[data-lab-grown]")),
      };
    }, action);
  const compact = await entryBlock("read");
  check("a short entryExtra block has no host toggle", !compact.toggle && compact.height <= ENTRY_COLLAPSED_PX, JSON.stringify(compact));
  await clickIn(0, "entryExtra", "grow");
  const clipped = await until(
    () => {
      const block = window.__labE2E.one(window.__labE2E.turn(0), "entryExtra")?.closest(".pi-entry-extra-block");
      const viewport = block?.querySelector(".pi-entry-extra-viewport");
      return block?.querySelector(".pi-entry-extra-toggle") ? { height: viewport.clientHeight, clipped: viewport.getAttribute("data-clipped") } : null;
    },
    null,
    "entryExtra toggle after Grow",
  );
  check("a grown block clamps at the collapsed height behind the host toggle", clipped.clipped === "true" && clipped.height <= ENTRY_COLLAPSED_PX, JSON.stringify(clipped));
  const expanded = await entryBlock("toggle");
  const expandedNow = await until(
    () => {
      const block = window.__labE2E.one(window.__labE2E.turn(0), "entryExtra")?.closest(".pi-entry-extra-block");
      const viewport = block?.querySelector(".pi-entry-extra-viewport");
      return viewport?.getAttribute("data-expanded") === "true" ? viewport.clientHeight : 0;
    },
    null,
    "expanded entryExtra",
  );
  check("the host toggle expands the block", expandedNow > ENTRY_COLLAPSED_PX, JSON.stringify({ ...expanded, height: expandedNow }));

  // --- crash isolation ------------------------------------------------------
  const crashCounts = () =>
    page(() => {
      const turn = window.__labE2E.turn(0);
      return {
        labs: window.__labE2E.labs(document),
        hostKeys: turn.querySelectorAll(".message-actions > .copy-btn, .message-actions > * > .copy-btn").length,
        entryBlocks: turn.querySelectorAll(".pi-entry-extra-block").length,
        composer: Boolean(document.querySelector(".composer-input")),
      };
    });
  const before = await crashCounts();
  await clickIn(0, "assistantAction:crash", "crash");
  await clickIn(0, "entryExtra", "crash");
  await clickIn(null, "composerControl:crash", "crash");
  await until(
    () => !document.querySelector('[data-lab="assistantAction:crash"], [data-lab="entryExtra"], [data-lab="composerControl:crash"]'),
    null,
    "crashed samples contained",
  );
  const after = await crashCounts();
  const survivors = [
    "assistantAction:left",
    "assistantAction:right",
    "assistantAction:refuse",
    "entryExtra:notes",
    "composerControl:left",
    "composerControl:draft",
    "composerControl:right",
    "composerControl:layers",
  ];
  check("a crashing action item leaves the bar alone", !after.labs.includes("assistantAction:crash") && after.hostKeys === before.hostKeys, JSON.stringify([before.hostKeys, after.hostKeys]));
  check("a crashing entryExtra block collapses alone", !after.labs.includes("entryExtra") && after.entryBlocks === before.entryBlocks - 1, JSON.stringify([before.entryBlocks, after.entryBlocks]));
  check("a crashing composer control leaves the composer", !after.labs.includes("composerControl:crash") && after.composer, after.labs.join(","));
  check("every other sample survives the crashes", survivors.every((lab) => after.labs.includes(lab)), after.labs.join(","));

  // --- toolCard failure, fallback and cadence -------------------------------
  await prompt(sessionId, "lab: probe fail");
  const failed = await until(
    () => {
      const card = window.__labE2E.one(window.__labE2E.turn(1), "toolCard");
      return card ? { status: card.getAttribute("data-lab-status"), error: card.querySelector("[data-lab-error]")?.textContent ?? "" } : null;
    },
    null,
    "failed probe card",
  );
  check("a failed call reaches the card as toolError", failed.status === "error" && failed.error.includes("lab_probe failed on request: fail"), JSON.stringify(failed));

  await prompt(sessionId, "lab: probe crash");
  const crashRow = (await control.messages(sessionId)).findLast((message) => message.role === "tool" && message.toolName === PROBE_TOOL);
  const fallback = await until(
    (id) => {
      const turn = window.__labE2E.turn(2);
      if (!turn || !window.__labE2E.one(turn, "entryExtra")) return null;
      return {
        card: Boolean(window.__labE2E.one(turn, "toolCard")),
        hostRow: Boolean(turn.querySelector(`.tool-row[data-message-id="${id}"]`)),
        mounts: turn.querySelectorAll('[data-pi-slot="toolCard"]').length,
      };
    },
    crashRow?.id,
    "crash turn",
  );
  check("a throwing toolCard hands the call back to the host card", crashRow?.toolArgs?.mode === "crash" && !fallback.card && fallback.hostRow && fallback.mounts === 0, JSON.stringify({ ...fallback, row: crashRow?.id }));

  // Record every committed status of the slow card, not just polled samples.
  await page(() => {
    const seen = [];
    const observer = new MutationObserver(() => {
      const status = window.__labE2E.one(window.__labE2E.turn(3), "toolCard")?.getAttribute("data-lab-status");
      if (status && status !== seen.at(-1)) seen.push(status);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-lab-status"] });
    window.__labE2E.slow = { seen, stop: () => observer.disconnect() };
    return true;
  });
  await prompt(sessionId, "lab: probe slow");
  const statuses = await until(
    () => {
      const { seen, stop } = window.__labE2E.slow;
      if (seen.at(-1) !== "success") return null;
      stop();
      return seen;
    },
    null,
    "slow card success",
  );
  check("a slow call's card goes from running to success", statuses[0] === "running" && statuses.at(-1) === "success", statuses.join(" → "));

  // --- blockRenderer contract failures --------------------------------------
  for (const [index, kind] of [[4, "crash"], [5, "tall"]]) {
    await prompt(sessionId, `lab: chart ${kind}`);
    const host = await until(
      (index) => {
        const turn = window.__labE2E.turn(index);
        const block = turn?.querySelector(".code-block");
        if (!block) return null;
        return {
          lang: block.querySelector(".code-block-lang")?.textContent,
          text: block.textContent,
          plugin: Boolean(window.__labE2E.one(turn, "blockRenderer")),
        };
      },
      index,
      `${kind} chart fallback`,
    );
    check(`a ${kind} chart falls back to the host code block`, host.lang === `${LAB}:chart` && host.text.includes(kind) && !host.plugin, JSON.stringify(host));
  }
  const firstChart = await page(() => Boolean(window.__labE2E.one(window.__labE2E.turn(0), "blockRenderer")));
  check("the healthy chart keeps its plugin block", firstChart);

  // --- self-drawn layers ----------------------------------------------------
  // The layer state once `accept(state)` holds; `accept` runs in the page.
  const layers = (label, accept) =>
    until(
      `() => { const state = window.__labE2E.layers(); return (${accept})(state) ? state : null; }`,
      null,
      label,
      5_000,
    ).catch((error) => ({ error: error.message }));
  const layerClick = (lab, button) => clickIn(null, lab, button);

  await layerClick("composerControl:layers", "wizard");
  const wizard = await layers("the wizard layer", (state) => state.wizard?.onTop);
  check(
    "a self-drawn dialog opens in its own layer at the bottom of the plugin band, over the app",
    wizard.wizard?.z === 600 && wizard.wizard.readout === "600" && wizard.wizard.plugin === LAB && wizard.wizard.inRoot &&
      wizard.root?.hidden === false && wizard.root.layers === 1,
    JSON.stringify(wizard),
  );
  const layerStyles = await page(() => {
    const look = (node) => {
      const style = getComputedStyle(node);
      return [style.borderTopStyle, style.paddingLeft, style.borderTopLeftRadius].join(" ");
    };
    const inLayer = document.querySelector('[data-lab="layer:wizard"] .lab-btn');
    const inSlot = document.querySelector('[data-lab="composerControl:layers"] .lab-btn');
    const stray = document.createElement("button");
    stray.className = "lab-btn";
    document.body.appendChild(stray);
    const outside = look(stray);
    stray.remove();
    return {
      inLayer: look(inLayer),
      inSlot: look(inSlot),
      outside,
      overlay: getComputedStyle(document.querySelector('[data-lab="layer:wizard"]')).position,
    };
  });
  check(
    "the plugin's scoped sheet and the host's dialog classes style the layer",
    layerStyles.inLayer === layerStyles.inSlot && layerStyles.inLayer !== layerStyles.outside && layerStyles.overlay === "fixed",
    JSON.stringify(layerStyles),
  );

  await layerClick("layer:wizard", "wizard-next");
  await layerClick("layer:wizard", "wizard-next");
  await layerClick("layer:wizard", "wizard-notice");
  const stacked = await layers("the notice over the wizard", (state) => state.notice?.onTop && state.wizard?.step === "3");
  check(
    "a layer opened later stacks above the earlier one",
    stacked.notice?.z === 601 && stacked.wizard?.z === 600 && stacked.root?.layers === 2,
    JSON.stringify(stacked),
  );

  await page(() => {
    const target = document.querySelector('[data-lab="layer:wizard"] [data-lab-button="wizard-next"]');
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  });
  await new Promise((done) => setTimeout(done, 300));
  const afterEscape = await page(() => window.__labE2E.layers());
  check("Escape closes no layer", afterEscape.wizard?.step === "3" && Boolean(afterEscape.notice), JSON.stringify(afterEscape));

  // A permission request in the open session: the layers step aside until
  // the user has answered it, and come back as they were.
  await control.tool("pi_session_configure", { id: sessionId, mode: "agent", permissionMode: "ask", confirm: true });
  await control.tool("pi_agent_prompt", { sessionId, content: "lab: gate" });
  const gated = await until(
    () => {
      const card = document.querySelector(".permission-card");
      if (!card) return null;
      const state = window.__labE2E.layers();
      const button = card.querySelector(".permission-card-actions button");
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { ...state, cardReachable: Boolean(hit && button.contains(hit)) };
    },
    null,
    "the permission card",
    30_000,
  ).catch((error) => ({ error: error.message }));
  check(
    "a pending permission hides every layer from sight and input, and leaves the card reachable",
    gated.root?.hidden === true && gated.root.inert === true && gated.root.layers === 2 && gated.cardReachable &&
      !gated.wizard?.onTop && !gated.notice?.onTop,
    JSON.stringify(gated),
  );
  await page(() => {
    document.querySelector(".permission-card .permission-card-actions button")?.click();
    return true;
  });
  await control.waitForTurn(sessionId);
  await control.tool("pi_session_configure", { id: sessionId, mode: "agent", permissionMode: "auto", confirm: true });
  const restored = await layers("the layers back", (state) => state.root?.hidden === false && state.notice?.onTop);
  check(
    "once answered, the layers come back unchanged",
    restored.root?.inert === false && restored.wizard?.step === "3" && restored.notice?.z === 601,
    JSON.stringify(restored),
  );

  await layerClick("layer:notice", "notice-dismiss");
  const dismissed = await layers("the notice closed", (state) => !state.notice && state.wizard?.onTop);
  check("a layer's own ✕ closes it and leaves the others", dismissed.root?.layers === 1, JSON.stringify(dismissed));
  await layerClick("layer:wizard", "wizard-close");
  const empty = await layers("the wizard closed", (state) => !state.wizard);
  check("the root goes with the last layer", empty.root === null, JSON.stringify(empty));
  // Left open for the unload below.
  await layerClick("composerControl:layers", "wizard");
  await layers("the wizard open again", (state) => state.wizard?.onTop);

  // --- unload and reload ----------------------------------------------------
  await page((id) => window.piDesktop.invoke("pi-desktop/plugin/disable", id), LAB);
  const unloaded = await until(
    () => {
      if (document.querySelector("[data-lab], [data-pi-plugin], #pi-plugin-layers")) return null;
      const turn = window.__labE2E.turn(0);
      return {
        sheets: document.querySelectorAll("style[data-pi-plugin-style]").length,
        hostChart: turn.querySelector(".code-block .code-block-lang")?.textContent ?? null,
        overflow: document.querySelectorAll(".pi-action-overflow").length,
        entryStacks: document.querySelectorAll(".pi-entry-extra-stack").length,
      };
    },
    null,
    "lab samples removed",
  );
  check(
    "disabling the plugin takes every sample, menu, block, layer and sheet with it",
    unloaded.sheets === 0 && unloaded.hostChart === `${LAB}:chart` && unloaded.overflow === 0 && unloaded.entryStacks === 0,
    JSON.stringify(unloaded),
  );
  await page((id) => window.piDesktop.invoke("pi-desktop/plugin/enable", id), LAB);
  const reloaded = await until(
    () => {
      const labs = window.__labE2E.labs(document);
      return labs.includes("entryExtra") && labs.includes("composerControl:crash") ? [...new Set(labs)] : null;
    },
    null,
    "lab samples back",
    30_000,
  );
  check("re-enabling loads the lab again with fresh samples", reloaded.includes("toolCard") && reloaded.includes("blockRenderer"), reloaded.join(","));
  return { sessionId };
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}
