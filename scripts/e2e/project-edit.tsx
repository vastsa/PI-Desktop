import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { api } from "../../apps/desktop/src/lib/api";
import { ProjectsPage } from "../../apps/desktop/src/pages/ProjectsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var projectEditProbe: () => Promise<unknown>;
}

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: en } }, initImmediate: false });
useAppStore.setState({
  sessions: [],
  workspace: null,
  openProjectPaths: ["/fixture/website"],
  projectMeta: {},
  runningSessions: { background: true },
});

function completeTask() {
  useAppStore.setState({ runningSessions: { background: false } });
  document.getElementById("background-status")!.textContent = "Background task completed";
}

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <aside className="fixture-controls">
      <strong>Project editor regression test</strong>
      <span id="background-status">Background task running</span>
      <button id="complete-background" onClick={completeTask}>Complete background task</button>
      <small>Real Settings → Projects UI · controlled background event</small>
    </aside>
    <main className="fixture-page"><ProjectsPage /></main>
  </I18nextProvider>,
);

async function until<T>(read: () => T | null | false, label: string): Promise<T> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(requestAnimationFrame);
  }
  throw new Error(`Timed out: ${label}`);
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  ) ?? null;
}

async function click(label: string) {
  (await until(() => button(label), label)).click();
}

function inputName(value: string) {
  const input = document.querySelector<HTMLInputElement>("#project-edit-name")!;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

async function openEditor() {
  (await until(() => document.querySelector<HTMLButtonElement>(".projects-row"), "project row")).click();
  await click("Open actions for Website");
  (await until(() => document.querySelector<HTMLButtonElement>('[data-action="edit-project"]'), "edit action")).click();
  await until(() => {
    const input = document.querySelector<HTMLInputElement>("#project-edit-name");
    return input && !input.disabled && input.value === "Website" ? input : null;
  }, "loaded editor");
}

globalThis.projectEditProbe = async () => {
  await openEditor();
  inputName("Website redesign");
  await click("Remove folder: assets");
  await until(() => !document.querySelector('[aria-label="Remove folder: assets"]'), "removed extra folder");
  completeTask();
  // Let the update traverse the real ProjectsPage and any resulting IPC loads.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const input = document.querySelector<HTMLInputElement>("#project-edit-name")!;
  const preserved = input.value === "Website redesign";
  const foldersPreserved = !document.querySelector('[aria-label="Remove folder: assets"]');
  if (!preserved || !foldersPreserved) {
    return { ok: false, name: input.value, preserved, foldersPreserved };
  }
  await click("Save changes");
  await until(() => !document.querySelector("#project-edit-name"), "saved editor closed");
  await until(() => document.body.textContent?.includes("Website redesign"), "updated project visible");
  const { groups } = await api.listProjectGroups();
  const saved = groups[0]?.name === "Website redesign" &&
    groups[0]?.primaryPath === "/fixture/website" &&
    groups[0]?.roots.length === 1 && groups[0]?.roots[0]?.path === "/fixture/website";
  return { ok: saved, preserved, foldersPreserved, saved };
};
