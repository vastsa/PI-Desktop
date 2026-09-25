import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { PiSkillDiscoveryPanel } from "../../apps/desktop/src/components/settings/PiSkillDiscoveryPanel";
import { api } from "../../apps/desktop/src/lib/api";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/settings.css";

declare global { var piSkillDiscoveryProbe: () => Promise<unknown>; }
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function until(condition: () => boolean) {
  const deadline = performance.now() + 6000;
  while (!condition() && performance.now() < deadline) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  assert(condition(), "UI did not reach the expected state");
}
globalThis.piSkillDiscoveryProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const candidate = { id: "fixture", name: "planning-with-files", path: "/fixture/.pi/agent/npm/node_modules/planning-with-files", skills: ["SKILL.md"], hasExtensions: false, imported: false };
  let calls = 0;
  let cancel = true;
  let fail = false;
  let runtimeFailure = false;
  api.discoverPiSkills = async () => {
    if (fail) throw new Error("Discovery unavailable");
    return { candidates: [{ ...candidate }], errors: [] };
  };
  api.importPiSkills = async id => {
    assert(id === candidate.id, "wrong candidate"); calls++;
    if (!cancel) candidate.imported = true;
    if (runtimeFailure) throw new Error("Plugin process failed");
    return { canceled: cancel };
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><PiSkillDiscoveryPanel /></I18nextProvider>));
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  await until(() => Boolean(button("Import and enable")));
  assert(calls === 0, "discovery must not import automatically");
  assert(container.textContent?.includes(candidate.path), "source path must be visible");
  flushSync(() => button("Import and enable").click());
  await until(() => !button("Import and enable").disabled);
  assert(!candidate.imported && calls === 1, "cancel must leave candidate available");
  cancel = false;
  flushSync(() => button("Import and enable").click());
  await until(() => Boolean(button("Already imported")));
  assert(button("Already imported").disabled, "duplicate import must be disabled");
  fail = true;
  flushSync(() => button("Refresh pi CLI skills").click());
  await until(() => Boolean(container.querySelector('[role="alert"]')));
  assert(container.textContent?.includes("Discovery unavailable"), "failure must be visible");
  fail = false;
  flushSync(() => button("Refresh pi CLI skills").click());
  await until(() => !button("Refresh pi CLI skills").disabled);
  assert(!container.querySelector('[role="alert"]'), "retry must clear previous failure");
  candidate.imported = false;
  flushSync(() => button("Refresh pi CLI skills").click());
  await until(() => Boolean(button("Import and enable")));
  runtimeFailure = true;
  flushSync(() => button("Import and enable").click());
  await until(() => Boolean(container.querySelector('[role="alert"]')));
  await until(() => Boolean(button("Already imported")));
  assert(button("Already imported").disabled, "host registration must survive a runtime failure");
  assert(container.textContent?.includes("Plugin process failed"), "rediscovery must not hide the import error");
  assert(container.textContent?.includes("manage imported packages in Plugins"), "recovery location must remain visible");
  root.unmount(); container.remove();
  return { ok: true, scenarios: ["discover without import", "cancel", "enable", "duplicate", "failure and retry", "registered import runtime failure"] };
};
