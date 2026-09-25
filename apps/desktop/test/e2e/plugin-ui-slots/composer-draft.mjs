// The lab's composer samples beyond the toolbar: the `#` trigger, and the
// draft lab panel, where the draft is rewritten and attachments are staged
// into the open session. A rewrite needs a person's input, so these steps
// click and type through CDP input (`renderer.click`, `renderer.type`); a
// page-side `element.click()` is synthetic, which is what a remote write
// looks like.

const button = (lab, name) => `[data-lab="${lab}"] [data-lab-button="${name}"]`;

/** What the composer shows: its text, chips by kind, and the image tray. */
function composerView() {
  const input = document.querySelector(".composer-input");
  const chips = [...(input?.querySelectorAll(".composer-chip") ?? [])].map((chip) => ({
    mark: chip.dataset.pluginMark ?? null,
    name: chip.querySelector(".composer-chip-name")?.textContent ?? "",
  }));
  const images = [...document.querySelectorAll(".composer-image-attachment-open")].map(
    (open) => open.getAttribute("aria-label")?.split(" — ")[0] ?? "",
  );
  return {
    text: input ? (input.value ?? input.textContent) : null,
    focused: Boolean(input) && document.activeElement === input,
    chips,
    images,
    follows: document.querySelector("[data-lab-draft]")?.getAttribute("data-lab-draft") ?? null,
  };
}

export async function driveComposerDraft({ renderer, check }) {
  const page = renderer.run;
  // A sample's outcome once `accept(outcome)` holds; `accept` runs in the
  // page, so it closes over nothing of this module.
  const outcome = (lab, label, accept) =>
    renderer
      .until(
        `(lab) => { const out = window.__labE2E.result(document, lab); return out && (${accept})(out) ? out : null; }`,
        lab,
        label,
        5_000,
      )
      .catch((error) => ({ error: error.message }));
  const view = () => page(composerView);
  const synthetic = (lab, name) => page((selector) => {
    document.querySelector(selector)?.click();
    return true;
  }, button(lab, name));

  const DRAFT = "layer:draft";
  const ATTACH = "layer:attach";

  // Every toolbar control, the lab's with their outcomes showing, fits its
  // slot whole: nothing is cut at a slot's edge.
  const cut = await page(() =>
    [...document.querySelectorAll('.pi-plugin-slot[data-pi-slot="composerControl"]')]
      .filter((slot) => slot.scrollWidth > slot.clientWidth + 1)
      .map((slot) => {
        const name = slot.firstElementChild?.getAttribute("data-lab") ?? slot.getAttribute("data-pi-plugin");
        return `${name} ${slot.scrollWidth}>${slot.clientWidth}`;
      }),
  );
  check("the lab's toolbar controls fit the toolbar whole", cut.length === 0, JSON.stringify(cut));

  const start = await view();
  check("the lab follows the live draft", /^\d+$/.test(start.follows ?? ""), JSON.stringify(start.follows));

  // --- the `#` trigger ------------------------------------------------------
  await page(() => {
    const input = document.querySelector(".composer-input");
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return true;
  });
  await renderer.type(" #caret");
  const rows = await renderer
    .until(
      () => {
        const names = [...document.querySelectorAll(".composer-ac-list .composer-ac-name")].map((name) => name.textContent);
        return names.length ? names : null;
      },
      null,
      "the lab's # rows",
      5_000,
    )
    .catch((error) => ({ error: error.message }));
  check("typing # lists the lab's matching issues", Array.isArray(rows) && rows.join() === "#7", JSON.stringify(rows));
  await renderer.click('.composer-ac-list [data-ac-index="0"]');
  const marked = await renderer
    .until(
      `() => { const v = (${composerView})(); return v.chips.some((chip) => chip.mark === "mark" && chip.name === "#7") ? v : null; }`,
      null,
      "the #7 mark",
      5_000,
    )
    .catch((error) => ({ error: error.message }));
  check(
    "picking a row puts the plugin's mark in place of the typed token",
    Boolean(marked.text) && !marked.text.includes("#caret"),
    JSON.stringify(marked),
  );

  // --- the draft rewritten ---------------------------------------------------
  await synthetic("composerControl:draft", "draft-panel");
  const docked = await renderer
    .until(
      () => {
        const panel = document.querySelector('[data-lab="layer:composer"] .p-dialog');
        const input = document.querySelector(".composer-input");
        if (!panel || !input) return null;
        const box = panel.getBoundingClientRect();
        const field = input.getBoundingClientRect();
        const hit = document.elementFromPoint(field.left + 8, field.top + 8);
        return {
          z: Number(panel.closest("[data-pi-layer]")?.style.zIndex),
          above: box.bottom <= field.top,
          composerReachable: Boolean(hit && input.contains(hit)),
        };
      },
      null,
      "the draft lab panel",
      5_000,
    )
    .catch((error) => ({ error: error.message }));
  check(
    "the draft lab opens in its own layer, docked clear of the composer",
    docked.z >= 600 && docked.above && docked.composerReachable,
    JSON.stringify(docked),
  );
  const before = await view();
  await renderer.click(button(DRAFT, "draft-polish"));
  const polished = await outcome(DRAFT, "the polish outcome", (out) => out.text.startsWith("polished g"));
  const afterPolish = await view();
  const stamps = (state) => state.chips.filter((chip) => chip.mark === "mark" && chip.name === "lab ✓").length;
  check(
    "a click on Polish rewrites the draft it followed, marks kept in place",
    polished.status === "ok" && stamps(afterPolish) === 1 && afterPolish.chips.some((chip) => chip.name === "#7") &&
      !/ {2}/.test(afterPolish.text) && afterPolish.follows !== before.follows && !afterPolish.focused,
    JSON.stringify({ polished, afterPolish }),
  );
  await renderer.click(button(DRAFT, "draft-polish"));
  const again = await outcome(DRAFT, "the second polish", (out) => out.status === "ok" && out.text !== polished.text);
  check("polishing again keeps a single stamp", stamps(await view()) === 1, JSON.stringify(again));

  const unchanged = (await view()).text;
  await renderer.click(button(DRAFT, "draft-polish-late"));
  const late = await outcome(DRAFT, "the late polish", (out) => out.status === "error");
  check(
    "a rewrite that starts after the click is refused as remote",
    late.text === "PLUGIN_DRAFT_REMOTE" && (await view()).text === unchanged,
    JSON.stringify(late),
  );
  await synthetic(DRAFT, "draft-read");
  const read = await outcome(DRAFT, "the read outcome", (out) => out.status === "ok");
  check("composer.readDraft answers with the followed generation", read.text === `read g${(await view()).follows}`, JSON.stringify(read));
  await synthetic(DRAFT, "draft-polish");
  const remote = await outcome(DRAFT, "the synthetic polish", (out) => out.status === "error");
  check(
    "a synthetic click is no gesture: the rewrite is refused",
    remote.text === "PLUGIN_DRAFT_REMOTE" && (await view()).text === unchanged,
    JSON.stringify(remote),
  );

  // --- attachments ------------------------------------------------------------
  const step = async (name, label, accept) => {
    await synthetic(ATTACH, name);
    return outcome(ATTACH, label, accept);
  };
  const note = await step("attach-note", "the note", (out) => out.text === "note attached" || out.status === "error");
  const withNote = await view();
  check(
    "a text attachment lands as a chip in the draft",
    note.status === "ok" && withNote.chips.some((chip) => chip.mark === null && chip.name === "lab-note.md") && !withNote.focused,
    JSON.stringify({ note, chips: withNote.chips }),
  );
  const image = await step("attach-image", "the image", (out) => out.text === "image attached" || out.status === "error");
  const withImage = await view();
  check(
    "an image attachment joins the draft's images, not its text",
    image.status === "ok" && withImage.images.includes("lab-dot.png") && withImage.chips.length === withNote.chips.length,
    JSON.stringify({ image, images: withImage.images }),
  );
  const path = await step("attach-path", "the path", (out) => out.status === "error");
  check("a path is refused, not read", path.text === "PLUGIN_ATTACHMENT_REFERENCE_REFUSED", JSON.stringify(path));
  const listed = await step("attach-list", "the list", (out) => out.status === "ok");
  check("attachments.list names the plugin's attachments", listed.text === "2: lab-note.md, lab-dot.png", JSON.stringify(listed));
  const removed = await step("attach-remove", "the image removed", (out) => out.status === "ok");
  const withoutImage = await view();
  check("attachments.remove takes the image out of the draft", removed.text === "removed" && !withoutImage.images.includes("lab-dot.png"), JSON.stringify(withoutImage.images));
  const one = await step("attach-list", "the list of one", (out) => out.status === "ok" && out.text !== "removed");
  await step("attach-remove", "the note removed", (out) => out.status === "ok" && out.text !== one.text);
  const empty = await renderer
    .until(
      `() => { const v = (${composerView})(); return v.chips.some((chip) => chip.name === "lab-note.md") ? null : v; }`,
      null,
      "the note chip gone",
      5_000,
    )
    .catch((error) => ({ error: error.message }));
  check("removing the note takes its chip with it", one.text === "1: lab-note.md" && Array.isArray(empty.chips), JSON.stringify({ one, chips: empty.chips }));
  const none = await step("attach-remove", "nothing to remove", (out) => out.status === "error");
  check("an unknown attachment id is refused", none.text === "PLUGIN_ATTACHMENT_NOT_FOUND", JSON.stringify(none));

  await synthetic("layer:composer", "draft-close");
  const closed = await renderer
    .until(() => (document.querySelector('[data-lab="layer:composer"], #pi-plugin-layers') ? null : true), null, "the draft lab closed", 5_000)
    .catch((error) => ({ error: error.message }));
  check("the draft lab's ✕ closes its layer", closed === true, JSON.stringify(closed));
}
