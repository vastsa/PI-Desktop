/**
 * The installed-plugins card grid and its control rail, driven through the
 * real components in Chromium.
 *
 * Only the IPC boundary is fixtured (`api`); `usePluginsPage`,
 * `InstalledPluginsPanel`, the real `ScopeControl`, the overflow menu, the
 * permission dialog, the install dialog and the plugin settings sheet are the
 * shipping implementations. Runs headless through
 * `scripts/e2e-installed-grid.mjs`; each probe returns a PASS summary the
 * harness prints, and no install ever leaves the renderer.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "../../packages/i18n/src/index";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { usePluginsPage } from "../../apps/desktop/src/features/plugins/usePluginsPage";
import { InstalledPluginsPanel } from "../../apps/desktop/src/features/plugins/InstalledPluginsPanel";
import { PluginDialogs } from "../../apps/desktop/src/features/plugins/PluginDialogs";
import { usePluginBrowseState } from "../../apps/desktop/src/features/plugins/browse-state";

const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
};
const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const maybe = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);
const settle = async (predicate: () => boolean, label: string) => {
  for (let tick = 0; tick < 400; tick++) {
    if (predicate()) return;
    // A hidden Chromium window can stop producing animation frames; whichever
    // of the two fires first advances the wait, so the probe never stalls.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 16);
    });
  }
  throw new Error(`Did not settle: ${label}`);
};

const LONG_ID = "acme.some-really-long-plugin-identifier.for-the-fixture-that-must-truncate";

/**
 * Seven plugins covering every group and every rail shape: enabled with an
 * update (and a panel and settings), enabled with only a panel, enabled with
 * only settings, a disabled plugin that still has an update, a plain disabled
 * plugin, a broken plugin, and one whose id must truncate.
 */
const installFixtures = () => [
  {
    id: "acme.updater",
    name: "Acme Updater",
    version: "1.0.0",
    enabled: true,
    status: "ready",
    source: "marketplace",
    permissions: ["ui.panel"],
    capabilities: ["panel", "commands"],
    settings: [{ key: "token", title: "Token", type: "string" }],
    ui: { panel: "panel.html" },
    autoUpdate: true,
    marketplace: { providerId: "official", trust: "verified" },
    updateAvailable: {
      version: "1.2.3",
      shasum: "abc",
      url: "https://example.test/updater.piplug",
      permissionDiff: ["net.fetch"],
    },
  },
  {
    id: "acme.panel",
    name: "Acme Panel",
    version: "2.0.0",
    enabled: true,
    status: "ready",
    source: "marketplace",
    permissions: ["ui.panel"],
    capabilities: ["panel"],
    ui: { panel: "panel.html" },
  },
  {
    id: "acme.settings-only",
    name: "Acme Settings",
    version: "0.4.0",
    enabled: true,
    status: "ready",
    source: "installed",
    permissions: [],
    settings: [{ key: "note", title: "Note", type: "string" }],
  },
  {
    id: "acme.disabled-update",
    name: "Acme Dormant",
    version: "1.0.0",
    enabled: false,
    status: "disabled",
    source: "marketplace",
    permissions: ["ui.panel"],
    capabilities: ["panel"],
    settings: [{ key: "token", title: "Token", type: "string" }],
    ui: { panel: "panel.html" },
    updateAvailable: {
      version: "2.0.0",
      shasum: "def",
      url: "https://example.test/dormant.piplug",
      permissionDiff: [],
    },
  },
  {
    id: "acme.disabled",
    name: "Acme Off",
    version: "3.1.0",
    enabled: false,
    status: "disabled",
    source: "installed",
    permissions: [],
  },
  {
    id: "acme.broken",
    name: "Acme Broken",
    version: "0.1.0",
    enabled: false,
    status: "error",
    errorMessage: "Manifest could not be read",
    source: "installed",
    permissions: [],
  },
  {
    id: LONG_ID,
    name: "Long Identifier",
    version: "9.9.9",
    enabled: true,
    status: "ready",
    source: "marketplace",
    permissions: [],
  },
];

const pageMocks = () => ({
  listProjects: async () => ({ projects: [] }),
  listPlugins: async () => ({ plugins: installFixtures() }),
  listPluginServices: async () => [],
  marketCheckUpdates: async () => ({}),
  marketSearch: async () => ({ plugins: [] }),
  onPluginChanged: () => () => {},
  onPluginInstallProgress: () => () => {},
});

function mountProbe() {
  document.body.style.margin = "0";
  const host = document.createElement("div");
  host.id = "installed-grid-host";
  host.style.width = "960px";
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    ),
  );
  return { host, root };
}

/** Marks the phase a hung probe stopped in; the harness reports it. */
const step = (name: string) => {
  (globalThis as Record<string, unknown>).__probeStep = name;
};

const cardByName = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".plugins-row")].find(
    (card) => card.querySelector(".plugins-row-name")?.textContent === name,
  )!;
const controlsOf = (card: HTMLElement) =>
  [...card.querySelector<HTMLElement>(".plugins-row-controls")!.children];
const menuItemByText = (text: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".scope-compact-menu.is-open button, .plugins-menu.is-open button",
    ),
  ].find((button) => button.textContent?.includes(text))!;
const columnsOf = (list: HTMLElement) =>
  window
    .getComputedStyle(list)
    .gridTemplateColumns.split(" ")
    .filter(Boolean)
    .map((value) => Number.parseFloat(value));

Object.assign(globalThis, {
  installedGridLayoutProbe: async () => {
    step("init");
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    step("mocks");
    Object.assign(api, {
      ...pageMocks(),
      // A verified rating for the updater, a zero summary for the panel, and
      // nothing for the rest: the chip must appear once, never for zero.
      marketReviewSummaries: async () => ({
        "acme.updater": {
          pluginId: "acme.updater",
          ratingAvg: 4.5,
          ratingCount: 3,
          ratingDist: [0, 0, 0, 1, 2],
          positiveCount: 2,
          neutralCount: 1,
          negativeCount: 0,
        },
        "acme.panel": {
          pluginId: "acme.panel",
          ratingAvg: null,
          ratingCount: 0,
          ratingDist: [0, 0, 0, 0, 0],
          positiveCount: 0,
          neutralCount: 0,
          negativeCount: 0,
        },
      }),
      setPluginScope: async () => ({ ok: true }),
      enablePlugin: async () => ({ ok: true }),
      disablePlugin: async () => ({ ok: true }),
    });

    useAppStore.setState({ plugins: installFixtures() });
    usePluginBrowseState.setState({ tab: "installed", installedQuery: "" });
    step("render");
    const { host, root } = mountProbe();

    step("mount");
    await settle(() => !!maybe(".plugins-list"), "installed grid");
    await settle(() => !!maybe(".plugins-rating"), "rating chip");

    step("groups");
    // --- Groups and their members ----------------------------------------
    const groups = [...document.querySelectorAll<HTMLElement>(".plugins-group")].map(
      (group) => ({
        label: group.querySelector(".plugins-group-label")?.textContent,
        count: group.querySelector(".plugins-group-count")?.textContent,
        names: [...group.querySelectorAll<HTMLElement>(".plugins-row-name")].map(
          (node) => node.textContent,
        ),
      }),
    );
    check(
      JSON.stringify(groups) ===
        JSON.stringify([
          { label: "Needs attention", count: "1", names: ["Acme Broken"] },
          { label: "Updates available", count: "2", names: ["Acme Dormant", "Acme Updater"] },
          { label: "Active", count: "3", names: ["Acme Panel", "Acme Settings", "Long Identifier"] },
          { label: "Turned off", count: "1", names: ["Acme Off"] },
        ]),
      `groups: ${JSON.stringify(groups)}`,
    );
    check(
      cardByName("Acme Broken").querySelector(".plugins-row-error")?.textContent?.includes(
        "Manifest could not be read",
      ) === true,
      "broken error message missing",
    );

    step("rail");
    // --- Control rail: order and gating ----------------------------------
    const updaterRail = controlsOf(cardByName("Acme Updater"));
    check(
      updaterRail.length === 4 &&
        updaterRail[0].classList.contains("scope-control") &&
        updaterRail[1].classList.contains("btn-primary") &&
        updaterRail[1].textContent?.includes("Update to v1.2.3") === true &&
        updaterRail[2].getAttribute("aria-label") === "Plugin settings" &&
        updaterRail[3].classList.contains("plugins-menu-wrap"),
      `updater rail: ${updaterRail.map((node) => node.className).join(" | ")}`,
    );
    const panelRail = controlsOf(cardByName("Acme Panel"));
    check(
      panelRail.length === 3 &&
        panelRail[0].classList.contains("scope-control") &&
        panelRail[1].textContent?.includes("Open panel") === true &&
        panelRail[2].classList.contains("plugins-menu-wrap"),
      `panel rail: ${panelRail.map((node) => node.className).join(" | ")}`,
    );
    const settingsRail = controlsOf(cardByName("Acme Settings"));
    check(
      settingsRail.length === 3 &&
        settingsRail[1].getAttribute("aria-label") === "Plugin settings",
      `settings rail: ${settingsRail.map((node) => node.className).join(" | ")}`,
    );
    for (const name of ["Acme Dormant", "Acme Off"]) {
      const card = cardByName(name);
      const rail = controlsOf(card);
      check(card.querySelector(".btn-primary") === null, `${name} has a primary`);
      check(
        card.querySelector('[aria-label="Plugin settings"]') === null,
        `${name} has a settings icon`,
      );
      check(
        rail.length === 2 && rail[1].classList.contains("plugins-menu-wrap"),
        `${name} rail: ${rail.map((node) => node.className).join(" | ")}`,
      );
      check(
        card.querySelector(".plugins-row-controls")?.textContent?.includes("Open panel") === false,
        `${name} offered the panel action`,
      );
    }

    step("details");
    // --- Disclosure stays, and only when there is something to disclose ---
    const updaterDetails = cardByName("Acme Updater").querySelector<HTMLDetailsElement>(
      "details.plugins-row-details",
    );
    check(!!updaterDetails, "details disclosure missing");
    check(updaterDetails.open === false, "details started open");
    updaterDetails.querySelector("summary")!.click();
    check(updaterDetails.open === true, "details did not open");
    check(
      updaterDetails.querySelector(".plugins-row-details-body")?.textContent?.includes(
        "Capabilities",
      ) === true,
      "opened details missing the readout",
    );
    check(
      cardByName("Acme Settings").querySelector("details.plugins-row-details") === null,
      "a plugin with nothing to disclose grew a details section",
    );

    step("scope");
    // --- ScopeControl is real and first -----------------------------------
    const scopeTrigger = cardByName("Acme Updater").querySelector<HTMLButtonElement>(
      ".scope-compact-trigger",
    );
    check(!!scopeTrigger, "compact scope trigger missing");
    step("scope:open");
    scopeTrigger.click();
    await settle(() => !!maybe(".scope-compact-menu.is-open"), "scope menu");
    step("scope:menu");
    check(
      document.querySelectorAll('.scope-compact-menu.is-open [role="menuitemradio"]').length === 3,
      "scope menu does not offer the three choices",
    );
    const disableCalls: string[] = [];
    const scopes: Array<[string, unknown]> = [];
    Object.assign(api, {
      setPluginScope: async (id: string, scope: unknown) => {
        scopes.push([id, scope]);
        return { ok: true };
      },
      disablePlugin: async (id: string) => {
        disableCalls.push(id);
        return { ok: true };
      },
    });
    step("scope:choose");
    menuItemByText("Off").click();
    await settle(() => disableCalls.length === 1, "scope off recorded");
    check(disableCalls[0] === "acme.updater", `disable call: ${JSON.stringify(disableCalls)}`);
    await settle(() => !maybe(".scope-compact-menu.is-open"), "scope menu closed");

    // "Projects" is not the current state, so choosing it reaches the host
    // with the resolved scope.
    step("scope:projects");
    cardByName("Acme Updater")
      .querySelector<HTMLButtonElement>(".scope-compact-trigger")!
      .click();
    await settle(() => !!maybe(".scope-compact-menu.is-open"), "scope menu reopened");
    menuItemByText("Projects").click();
    await settle(() => scopes.length === 1, "scope choice recorded");
    check(
      scopes[0][0] === "acme.updater" &&
        JSON.stringify(scopes[0][1]) === JSON.stringify({ mode: "projects", projects: [] }),
      `scope call: ${JSON.stringify(scopes)}`,
    );

    step("meta");
    // --- Ratings meta adds no line, long ids truncate ----------------------
    const updaterCard = cardByName("Acme Updater");
    const meta = updaterCard.querySelector<HTMLElement>(".plugins-row-meta")!;
    const chip = meta.querySelector<HTMLElement>(".plugins-rating");
    check(!!chip, "rating chip missing from the meta line");
    const metaRect = meta.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    check(
      chipRect.top >= metaRect.top - 1 && chipRect.bottom <= metaRect.bottom + 1,
      "rating chip wrapped onto its own line",
    );
    check(metaRect.height <= 24, `meta line grew: ${metaRect.height}`);
    check(
      cardByName("Acme Panel").querySelector(".plugins-rating") === null,
      "zero summary rendered a chip",
    );

    const longCard = cardByName("Long Identifier");
    const idElement = longCard.querySelector<HTMLElement>(".plugins-row-id")!;
    check(
      idElement.scrollWidth > idElement.clientWidth + 8,
      `long id was not truncated: ${idElement.scrollWidth}/${idElement.clientWidth}`,
    );
    check(
      idElement.getBoundingClientRect().right <= longCard.getBoundingClientRect().right + 0.5,
      "long id overflows the card",
    );

    step("grid");
    // --- Grid: 340px floor at width, min() fallback when narrower ---------
    const wideColumns = columnsOf(find(".plugins-list"));
    check(wideColumns.length >= 2, `wide host columns: ${wideColumns.join(",")}`);
    check(
      Math.min(...wideColumns) >= 340 - 1,
      `a wide column is under 340px: ${wideColumns.join(",")}`,
    );

    host.style.width = "300px";
    const narrowList = find(".plugins-list");
    const narrowColumns = columnsOf(narrowList);
    check(narrowColumns.length === 1, `narrow host columns: ${narrowColumns.join(",")}`);
    check(narrowColumns[0] <= 300, `narrow column overflows the host: ${narrowColumns[0]}`);
    check(
      narrowList.scrollWidth <= narrowList.clientWidth + 1,
      "grid overflows horizontally below 340px",
    );
    const narrowCard = cardByName("Acme Updater");
    const narrowCardRect = narrowCard.getBoundingClientRect();
    check(
      narrowCardRect.right <= narrowList.getBoundingClientRect().right + 0.5,
      "card overflows the narrow grid",
    );

    step("narrow");
    // --- Narrow rail wraps and stays usable -------------------------------
    const narrowControls = narrowCard.querySelector<HTMLElement>(".plugins-row-controls")!;
    check(
      narrowControls.scrollWidth <= narrowControls.clientWidth + 1,
      "control rail overflows the narrow card",
    );
    check(
      narrowControls.getBoundingClientRect().height > 40,
      `control rail did not wrap: ${narrowControls.getBoundingClientRect().height}`,
    );
    for (const control of [...narrowControls.children]) {
      const rect = control.getBoundingClientRect();
      check(
        rect.right <= narrowCardRect.right + 0.5 && rect.bottom <= narrowCardRect.bottom + 0.5,
        "a control sits outside the narrow card",
      );
    }

    root.unmount();
    host.remove();
    return "PASS: groups/members/error, rail order + disabled gating, disclosure, real scope menu, chip inline + long-id truncation, 340px grid floor + sub-340 fallback, narrow rail wrap";
  },

  installedGridActionsProbe: async () => {
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const installs: Array<Record<string, unknown>> = [];
    const panels: string[] = [];
    const autoUpdates: Array<[string, boolean]> = [];
    const uninstalls: string[] = [];
    Object.assign(api, {
      ...pageMocks(),
      marketReviewSummaries: async () => ({}),
      marketInstall: async (input: Record<string, unknown>) => {
        installs.push(input);
        return { result: { plugin: installFixtures()[0], upgraded: true, permissionDiff: [] } };
      },
      openPluginPanel: async (id: string) => {
        panels.push(id);
        return { ok: true };
      },
      setPluginAutoUpdate: async (id: string, enabled: boolean) => {
        autoUpdates.push([id, enabled]);
        return { ok: true };
      },
      uninstallPlugin: async (id: string) => {
        uninstalls.push(id);
        return { ok: true };
      },
    });

    useAppStore.setState({ plugins: installFixtures() });
    usePluginBrowseState.setState({ tab: "installed", installedQuery: "" });
    const { host, root } = mountProbe();
    step("mount");
    await settle(() => !!maybe(".plugins-list"), "installed grid");

    // --- Update carries the updating version into the install -------------
    const updaterCard = cardByName("Acme Updater");
    updaterCard.querySelector<HTMLButtonElement>(".btn-primary")!.click();
    await settle(() => !!maybe(".plugins-modal"), "permission dialog");
    const permissionDialog = [...document.querySelectorAll<HTMLElement>(".plugins-modal")].find(
      (node) => node.textContent?.includes("Install Acme Updater?"),
    );
    check(!!permissionDialog, "permission dialog missing");
    check(
      permissionDialog!.textContent?.includes("v1.2.3") === true,
      "permission dialog does not name the target version",
    );
    permissionDialog!.querySelector<HTMLButtonElement>(".plugins-modal-actions .btn-primary")!.click();
    await settle(() => installs.length === 1, "marketInstall recorded");
    check(
      installs[0].id === "acme.updater" &&
        installs[0].version === "1.2.3" &&
        installs[0].enable === true &&
        installs[0].autoUpdate === true,
      `install call: ${JSON.stringify(installs[0])}`,
    );
    await settle(() => !maybe(".plugins-install-modal"), "install dialog stepped aside");

    // --- Open panel names the plugin ---------------------------------------
    cardByName("Acme Panel")
      .querySelector<HTMLButtonElement>(".plugins-row-controls .btn-secondary")!
      .click();
    await settle(() => panels.length === 1, "openPluginPanel recorded");
    check(panels[0] === "acme.panel", `panel call: ${JSON.stringify(panels)}`);

    // --- Settings opens only where declared --------------------------------
    cardByName("Acme Updater")
      .querySelector<HTMLButtonElement>('[aria-label="Plugin settings"]')!
      .click();
    await settle(() => !!maybe(".plugins-settings-modal"), "settings sheet");
    check(
      find(".plugins-settings-modal").textContent?.includes("Acme Updater settings") === true,
      "settings sheet title missing",
    );
    find<HTMLButtonElement>('[aria-label="Close plugin settings"]').click();
    await settle(() => !maybe(".plugins-settings-modal"), "settings sheet closed");

    // --- Overflow: auto-update toggle, uninstall, and no uninstall for a
    //     bundled plugin ------------------------------------------------------
    updaterCard.querySelector<HTMLButtonElement>('[aria-label="Actions for Acme Updater"]')!.click();
    await settle(() => !!maybe(".plugins-menu.is-open"), "row menu");
    menuItemByText("Disable auto-update").click();
    await settle(() => autoUpdates.length === 1, "auto-update recorded");
    check(
      autoUpdates[0][0] === "acme.updater" && autoUpdates[0][1] === false,
      `auto-update call: ${JSON.stringify(autoUpdates)}`,
    );

    await settle(() => !maybe(".plugins-menu.is-open"), "row menu closed");
    cardByName("Acme Updater")
      .querySelector<HTMLButtonElement>('[aria-label="Actions for Acme Updater"]')!
      .click();
    await settle(() => !!maybe(".plugins-menu.is-open"), "row menu reopened");
    menuItemByText("Uninstall").click();
    await settle(() => uninstalls.length === 1, "uninstall recorded");
    check(uninstalls[0] === "acme.updater", `uninstall call: ${JSON.stringify(uninstalls)}`);

    root.unmount();
    host.remove();
    return "PASS: update->permission->marketInstall(v1.2.3), panel id, settings sheet opens/closes, overflow auto-update false + uninstall";
  },
});

function Probe() {
  const model = usePluginsPage();
  return (
    <>
      <InstalledPluginsPanel {...model} />
      <PluginDialogs {...model} />
    </>
  );
}
