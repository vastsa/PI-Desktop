import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { RadialMenu, type RadialMenuSlot } from "../../apps/desktop/src/components/RadialMenu";

const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
};
const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
};

type ProbeState = {
  calls: string[];
  closes: number;
  disabledCalls: string[];
};

const state: ProbeState = { calls: [], closes: 0, disabledCalls: [] };

const items = (disabledLeft = false, disabledUp = false): RadialMenuSlot[] => [
  { id: "up", label: "Copy conversation", icon: <span>U</span>, disabled: disabledUp, onSelect: () => state.calls.push("up") },
  { id: "right", label: "Select text", icon: <span>R</span>, onSelect: () => state.calls.push("right") },
  { id: "down", label: "Jump to latest", icon: <span>D</span>, onSelect: () => state.calls.push("down") },
  {
    id: "left",
    label: "Leave empty",
    icon: <span>L</span>,
    disabled: disabledLeft,
    onSelect: () => state.disabledCalls.push("left"),
  },
];

function Probe({ disabledLeft, disabledUp }: { disabledLeft: boolean; disabledUp: boolean }) {
  const [open, setOpen] = React.useState(true);
  return open ? (
    <RadialMenu
      point={{ x: 420, y: 340 }}
      items={items(disabledLeft, disabledUp)}
      label="Transcript ring"
      onClose={() => {
        state.closes += 1;
        setOpen(false);
      }}
    />
  ) : (
    <div id="ring-closed" />
  );
}

const mount = (disabledLeft = false, disabledUp = false) => {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<Probe disabledLeft={disabledLeft} disabledUp={disabledUp} />));
  const menu = document.querySelector<HTMLElement>(".radial-menu");
  check(!!menu, "ring did not mount");
  return menu as HTMLElement;
};

/** Ring center and the mid-line radius where the item stacks sit. */
const geometry = (menu: HTMLElement) => {
  const rect = menu.getBoundingClientRect();
  return {
    rect,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    itemRadius: rect.width * 0.34,
  };
};

const pointFor = (menu: HTMLElement, degrees: number | "hub") => {
  const { centerX, centerY, itemRadius } = geometry(menu);
  if (degrees === "hub") return { x: centerX, y: centerY };
  return {
    x: centerX + Math.cos((degrees * Math.PI) / 180) * itemRadius,
    y: centerY + Math.sin((degrees * Math.PI) / 180) * itemRadius,
  };
};

const pointerMove = async (menu: HTMLElement, degrees: number) => {
  const { x, y } = pointFor(menu, degrees);
  flushSync(() =>
    menu.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }),
    ),
  );
  await settle();
};

const clickAt = async (menu: HTMLElement, degrees: number | "hub") => {
  const { x, y } = pointFor(menu, degrees);
  flushSync(() =>
    menu.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    ),
  );
  await settle();
};

const pressAt = (menu: HTMLElement, degrees: number | "hub") => {
  const { x, y } = pointFor(menu, degrees);
  flushSync(() =>
    menu.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 2, clientX: x, clientY: y }),
    ),
  );
};

const releaseAt = async (menu: HTMLElement, degrees: number | "hub") => {
  const { x, y } = pointFor(menu, degrees);
  flushSync(() =>
    menu.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 2, clientX: x, clientY: y }),
    ),
  );
  await settle();
};

Object.assign(globalThis, {
  radialMenuProbe: async () => {
    // 1. The four wedges render with their visible labels.
    let menu = mount();
    check(menu.querySelectorAll(".radial-menu-wedge").length === 4, "expected four wedge paths");
    const labels = [...menu.querySelectorAll(".radial-menu-item")].map((node) => node.getAttribute("aria-label"));
    check(labels.join("|") === "Copy conversation|Select text|Jump to latest|Leave empty", `labels: ${labels.join("|")}`);
    const shown = [...menu.querySelectorAll(".radial-menu-label")].map((node) => node.textContent);
    check(shown.join("|") === "Copy conversation|Select text|Jump to latest|Leave empty", `visible labels: ${shown.join("|")}`);
    check(menu.querySelector(".radial-menu-hub-label") === null, "the retired hub label is still rendered");

    // 2. The wedge under the pointer highlights.
    await pointerMove(menu, 0);
    check(menu.querySelector(".radial-menu-wedge.is-active") !== null, "no wedge highlighted at 0°");
    check(menu.querySelectorAll(".radial-menu-wedge.is-active").length === 1, "more than one wedge highlighted");
    const active = menu.querySelector(".radial-menu-item[data-active='true']");
    check(active?.getAttribute("aria-label") === "Select text", `active item read ${active?.getAttribute("aria-label")}`);

    // 3. Clicking the wedge runs it and closes the ring.
    await clickAt(menu, 0);
    check(state.calls.join("|") === "right", `click ran ${state.calls.join("|")}`);
    check(document.getElementById("ring-closed") !== null, "ring stayed mounted after running an item");

    // 4. A click on the hub closes without running anything.
    const before = state.calls.length;
    menu = mount();
    await clickAt(menu, "hub");
    check(state.calls.length === before, "hub click ran an action");
    check(document.getElementById("ring-closed") !== null, "hub click did not close the ring");

    // 5. A disabled direction stays open and runs nothing.
    const closesBefore = state.closes;
    menu = mount(true);
    await clickAt(menu, 180);
    check(state.disabledCalls.length === 0, "disabled wedge ran its action");
    check(state.closes === closesBefore, "disabled wedge closed the ring");
    check(document.querySelector(".radial-menu") !== null, "disabled wedge removed the ring");

    // 6. Arrow keys move the highlight and Enter activates the focused slot.
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>(".radial-menu-item")];
    buttons[0]?.focus();
    flushSync(() =>
      buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    await settle();
    const focused = document.activeElement as HTMLButtonElement | null;
    check(focused?.className.includes("radial-menu-item") === true, "arrow key did not move focus");
    check(focused?.getAttribute("aria-label") === "Select text", `arrow key landed on ${focused?.getAttribute("aria-label")}`);
    flushSync(() => focused?.click());
    await settle();
    check(state.calls.at(-1) === "right", `Enter path ran ${state.calls.at(-1)}`);

    // 7. An empty first slot still leaves the keyboard path on an enabled action.
    menu = mount(false, true);
    await settle();
    const firstFocusable = document.activeElement as HTMLButtonElement | null;
    check(firstFocusable?.getAttribute("aria-label") === "Select text", `disabled first slot kept focus on ${firstFocusable?.tagName}`);
    flushSync(() =>
      firstFocusable?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await settle();
    const nextFocusable = document.activeElement as HTMLButtonElement | null;
    check(nextFocusable?.getAttribute("aria-label") === "Jump to latest", `arrow key did not skip the disabled first slot: ${nextFocusable?.getAttribute("aria-label")}`);
    flushSync(() => nextFocusable?.click());
    await settle();
    check(state.calls.at(-1) === "down", `keyboard action ran ${state.calls.at(-1)}`);

    // 8. Marking gesture: a right press seen while open runs its release wedge.
    menu = mount();
    pressAt(menu, 0);
    await releaseAt(menu, 0);
    check(state.calls.at(-1) === "right", `marking release ran ${state.calls.at(-1)}`);
    check(document.getElementById("ring-closed") !== null, "marking release did not close the ring");

    // 9. Releasing in the hub dismisses without running anything.
    const markingBefore = state.calls.length;
    menu = mount();
    pressAt(menu, "hub");
    await releaseAt(menu, "hub");
    check(state.calls.length === markingBefore, "hub release ran an action");
    check(document.getElementById("ring-closed") !== null, "hub release did not close the ring");

    // 10. The opening right-click's trailing release is inert: it has no
    // matching press seen while the ring was open.
    menu = mount();
    await releaseAt(menu, 0);
    check(state.calls.length === markingBefore, "unpaired release ran an action");
    check(document.querySelector(".radial-menu") !== null, "unpaired release closed the ring");

    // 11. Escape closes the ring.
    flushSync(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await settle();
    check(document.querySelector(".radial-menu") === null, "Escape did not close the ring");

    // 12. The ring is clamped inside a small viewport.
    document.body.replaceChildren();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        <RadialMenu
          point={{ x: window.innerWidth - 4, y: window.innerHeight - 4 }}
          items={items()}
          label="Edge ring"
          onClose={() => {}}
        />,
      ),
    );
    const edge = document.querySelector<HTMLElement>(".radial-menu");
    check(!!edge, "edge ring did not mount");
    const rect = (edge as HTMLElement).getBoundingClientRect();
    const declaredWidth = Number.parseFloat((edge as HTMLElement).style.width);
    check(
      rect.right <= window.innerWidth && rect.bottom <= window.innerHeight && rect.width === declaredWidth,
      `edge ring escaped the viewport: ${JSON.stringify({ right: rect.right, bottom: rect.bottom, width: rect.width })}`,
    );

    return `radial menu ok: ${state.calls.join(",")} | closes=${state.closes}`;
  },
});
