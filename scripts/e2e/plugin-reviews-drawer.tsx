/**
 * The public review drawer, driven through the real components in Chromium.
 *
 * Only the IPC boundary is fixtured (`api`); the page hook, the detail sheet,
 * the summary block, the drawer, its filters, paging, error/retry, the write
 * link, focus trapping and Escape are the shipping implementations. Runs
 * headless through `scripts/e2e-plugin-reviews-drawer.mjs`; returns a PASS
 * summary the harness prints.
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
import { MarketplacePanel } from "../../apps/desktop/src/features/plugins/MarketplacePanel";
import { PluginDetailSheet } from "../../apps/desktop/src/features/plugins/PluginDetailSheet";
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
  for (let frame = 0; frame < 240; frame++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(`Did not settle: ${label}`);
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const texts = (selector: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? "");

/** Marks the phase a hung probe stopped in; the harness reports it. */
const step = (name: string) => {
  (globalThis as Record<string, unknown>).__probeStep = name;
};

const cardByName = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".plugins-card")].find(
    (card) => card.querySelector(".plugins-card-name")?.textContent === name,
  )!;

const REVIEW_URL = "https://centre.example.test/plugins/test.focus#reviews";
const OPEN_FAILURE = "open refused by the system browser";

type ReviewCall = { pluginId: string; sentiment?: string; sort?: string; cursor?: string };

const summary = {
  pluginId: "test.focus",
  ratingAvg: 4.5,
  ratingCount: 3,
  ratingDist: [0, 0, 1, 0, 2],
  positiveCount: 2,
  neutralCount: 1,
  negativeCount: 0,
};

const review = (id: string, body: string, overrides: Record<string, unknown> = {}) => ({
  id,
  pluginId: "test.focus",
  authorName: "Ada",
  ratingHalfStars: 9,
  body,
  status: "visible",
  pluginVersion: "1.2.0",
  helpfulCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  editedAt: null,
  ...overrides,
});

const plugin = {
  id: "test.focus",
  name: "Focus test",
  // Long enough that the ratings summary sits below the sheet's first
  // screen, so "scroll preserved" is a measurable claim.
  description: "A test marketplace card used by the drawer fixture. ".repeat(60),
  author: "Test",
  latestVersion: "1.0.0",
  updatedAt: "2026-09-01T00:00:00Z",
  permissionSummary: [],
  categories: [],
  versions: [],
  permissions: [],
  readmeMarkdown: `# Long readme\n\n${"A line of readme content.\n\n".repeat(120)}`,
};

/** The page-agnostic IPC mocks shared by every probe. */
const pageMocks = () => ({
  listProjects: async () => ({ projects: [] }),
  listPlugins: async () => ({ plugins: [] }),
  listPluginServices: async () => [],
  marketCheckUpdates: async () => ({}),
  marketSearch: async () => ({ plugins: [plugin] }),
  marketGetDetail: async () => ({ plugin }),
  onPluginChanged: () => () => {},
  onPluginInstallProgress: () => () => {},
});

function mountProbe() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    ),
  );
  return { container, root };
}

Object.assign(globalThis, {
  pluginReviewsDrawerProbe: async () => {
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });

    const reviewCalls: ReviewCall[] = [];
    const opened: string[] = [];
    let failNegativeOnce = false;
    let failOpenOnce = false;

    // Fixture only the IPC boundary; the hook, sheet, drawer and focus logic
    // are real. "all" is slow on purpose so a filter switch can outrun it.
    Object.assign(api, {
      listProjects: async () => ({ projects: [] }),
      listPlugins: async () => ({ plugins: [] }),
      listPluginServices: async () => [],
      marketCheckUpdates: async () => ({}),
      marketSearch: async () => ({ plugins: [plugin] }),
      marketGetDetail: async () => ({ plugin }),
      marketReviewSummaries: async () => ({ "test.focus": summary }),
      marketReviews: async (query: ReviewCall) => {
        reviewCalls.push(query);
        if (query.sentiment === "all") await delay(250);
        if (query.sentiment === "negative" && failNegativeOnce) {
          failNegativeOnce = false;
          throw new Error("centre unavailable");
        }
        if (query.sentiment === "positive") {
          return {
            reviews: [review("p1", "positive only", { ratingHalfStars: 10 })],
            nextCursor: null,
            summary,
            reviewUrl: REVIEW_URL,
          };
        }
        if (query.sentiment === "negative") {
          return {
            reviews: [review("n1", "negative only", { ratingHalfStars: 3 })],
            nextCursor: null,
            summary,
            reviewUrl: REVIEW_URL,
          };
        }
        if (query.cursor === "c1") {
          // A stable keyset cursor can repeat a row the user has seen; the
          // drawer must deduplicate by id.
          return {
            reviews: [review("r1", "first"), review("r2", "second"), review("r3", "third")],
            nextCursor: null,
            summary,
            reviewUrl: REVIEW_URL,
          };
        }
        return {
          reviews: [review("r1", "first")],
          nextCursor: "c1",
          summary,
          reviewUrl: REVIEW_URL,
        };
      },
      browserOpenExternal: async (url?: string) => {
        if (failOpenOnce) {
          failOpenOnce = false;
          throw new Error(OPEN_FAILURE);
        }
        opened.push(String(url));
        return { ok: true };
      },
      onPluginChanged: () => () => {},
      onPluginInstallProgress: () => () => {},
    });

    usePluginBrowseState.setState({ tab: "market" });
    const { container, root } = mountProbe();

    // --- Card chip + summary in the detail sheet -------------------------
    await settle(() => !!maybe(".plugins-card-hit"), "marketplace card");
    await settle(() => !!maybe(".plugins-rating"), "card rating chip");
    const chip = find(".plugins-rating");
    check(
      chip.getAttribute("aria-label") === "Rated 4.5 out of 5 from 3 ratings",
      `rating chip aria-label: ${chip.getAttribute("aria-label")}`,
    );
    check(chip.textContent?.includes("4.5 (3)") === true, `rating chip text: ${chip.textContent}`);

    find(".plugins-card-hit").click();
    await settle(() => !!maybe(".plugins-sheet"), "detail sheet");
    await settle(
      () => texts(".plugins-sheet-section-title").includes("Ratings & reviews"),
      "ratings summary section",
    );
    const sections = texts(".plugins-sheet-section-title");
    const order = ["Permissions", "Ratings & reviews", "Versions"].map((title) =>
      sections.findIndex((text) => text.includes(title)),
    );
    check(
      order[0] >= 0 && order[0] < order[1] && order[1] < order[2],
      `section order: ${sections.join(" | ")}`,
    );
    check(!!maybe(".plugins-reviews-summary"), "summary block missing");
    check(!!maybe(".plugins-reviews-dist"), "sentiment distribution missing");

    const sheetBody = find(".plugins-sheet-body");

    // --- Open the drawer --------------------------------------------------
    const opener = find<HTMLButtonElement>(".plugins-sheet-reviews-action button");
    // Put the opener on screen with the sheet scrolled, so "position
    // preserved" is a measurable claim rather than a no-op.
    const bodyRect = sheetBody.getBoundingClientRect();
    const openerRect = opener.getBoundingClientRect();
    if (openerRect.bottom > bodyRect.bottom - 8) {
      sheetBody.scrollTop += openerRect.bottom - (bodyRect.bottom - 56);
    } else if (openerRect.top < bodyRect.top + 8) {
      sheetBody.scrollTop -= bodyRect.top + 56 - openerRect.top;
    }
    check(sheetBody.scrollTop > 0, "detail sheet did not scroll");
    const settledOpener = opener.getBoundingClientRect();
    check(
      settledOpener.top >= bodyRect.top && settledOpener.bottom <= bodyRect.bottom,
      "opener is not on screen for the user path",
    );
    const preservedScroll = sheetBody.scrollTop;
    opener.focus();
    opener.click();
    await settle(() => !!maybe(".plugins-reviews"), "review drawer");
    const drawer = find(".plugins-reviews");
    check(document.activeElement === drawer, "drawer did not take initial focus");
    check(find(".plugins-sheet").inert === true, "detail sheet not inert behind the drawer");
    check(find(".plugins-sheet-scrim").inert === true, "sheet scrim not inert behind the drawer");
    // An inert surface refuses focus, so the covered sheet is unreachable.
    const sheetButton = find<HTMLButtonElement>(".plugins-sheet .plugins-icon-btn");
    sheetButton.focus();
    check(document.activeElement !== sheetButton, "inert detail sheet accepted focus");

    // --- Focus trap -------------------------------------------------------
    const focusables = [
      ...drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    check(focusables.length >= 4, `expected several focusables, saw ${focusables.length}`);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    const forwardCarried = document.dispatchEvent(forward);
    check(forwardCarried === false, "Tab was not prevented at the drawer edge");
    check(document.activeElement === first, "Tab did not wrap to the first control");
    first.focus();
    const backward = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const backwardCarried = document.dispatchEvent(backward);
    check(backwardCarried === false, "Shift+Tab was not prevented at the drawer edge");
    check(document.activeElement === last, "Shift+Tab did not wrap to the last control");

    // --- First page, paging and dedup -------------------------------------
    await settle(
      () => texts(".plugins-review-body").includes("first"),
      "first review page",
    );
    check(
      find(".plugins-review-meta").textContent?.includes("User-reported version v1.2.0") === true,
      `version label: ${find(".plugins-review-meta").textContent}`,
    );
    find(".plugins-reviews-more button").click();
    await settle(() => texts(".plugins-review-body").includes("third"), "second review page");
    const bodies = texts(".plugins-review-body");
    check(
      bodies.length === 3 && bodies[0] === "first" && bodies[1] === "second" && bodies[2] === "third",
      `deduplicated rows: ${bodies.join(" | ")}`,
    );
    check(!maybe(".plugins-reviews-more"), "load more survived the last page");

    // --- Filter switch wins over a slow earlier answer --------------------
    const filterButton = (label: string) =>
      [...drawer.querySelectorAll<HTMLButtonElement>(".plugins-reviews-filters button")].find(
        (button) => button.textContent === label,
      )!;
    // Land on Positive first, then start the slow "All" query and outrun it
    // with another Positive switch before it answers.
    filterButton("Positive").click();
    await settle(
      () => texts(".plugins-review-body").includes("positive only"),
      "positive filter applied",
    );
    filterButton("All").click();
    await delay(30);
    filterButton("Positive").click();
    await settle(
      () => texts(".plugins-review-body").includes("positive only"),
      "positive filter re-applied",
    );
    await delay(400);
    const afterStale = texts(".plugins-review-body");
    check(
      afterStale.includes("positive only") && !afterStale.includes("first"),
      `stale answer reached the list: ${afterStale.join(" | ")}`,
    );
    const positiveCall = reviewCalls.find((call) => call.sentiment === "positive");
    check(
      positiveCall?.cursor === undefined && positiveCall?.sort === "newest",
      `positive first page query: ${JSON.stringify(positiveCall)}`,
    );

    // --- Error, alert, retry ---------------------------------------------
    failNegativeOnce = true;
    filterButton("Negative").click();
    await settle(() => !!maybe(".plugins-reviews-state[role='alert']"), "load error alert");
    check(
      find(".plugins-reviews-state[role='alert']").textContent?.includes("Couldn't load reviews.") ===
        true,
      "load error copy missing",
    );
    find(".plugins-reviews-state[role='alert'] button").click();
    await settle(
      () => texts(".plugins-review-body").includes("negative only"),
      "retry recovered the list",
    );

    // --- Write link: real anchor, page URL wins, middle-click only --------
    const write = find<HTMLAnchorElement>(".plugins-reviews-write");
    check(write.href === REVIEW_URL, `write link href: ${write.href}`);
    write.click();
    check(opened.length === 1 && opened[0] === REVIEW_URL, `open calls: ${JSON.stringify(opened)}`);
    const middle = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    const middleCarried = write.dispatchEvent(middle);
    check(middleCarried === false, "middle-click was not prevented");
    check(opened.length === 2, "middle-click did not open the centre page");
    write.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }));
    check(opened.length === 2, "right-click opened the centre page");
    failOpenOnce = true;
    const toastsBefore = useAppStore.getState().toasts.length;
    write.click();
    await settle(
      () =>
        useAppStore
          .getState()
          .toasts.some((toast) => toast.message === OPEN_FAILURE),
      "open failure toast",
    );
    check(useAppStore.getState().toasts.length > toastsBefore, "toast not appended");

    // --- Escape: top layer only, restore focus and position ---------------
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const escapeCarried = document.dispatchEvent(escape);
    check(escapeCarried === false, "Escape was not prevented");
    await settle(() => !maybe(".plugins-reviews"), "drawer closed by Escape");
    check(!!maybe(".plugins-sheet"), "Escape closed the detail sheet too");
    check(find(".plugins-sheet").inert === false, "detail sheet stayed inert after the drawer");
    check(document.activeElement === opener, "focus did not return to the opener");
    check(
      find(".plugins-sheet-body").scrollTop === preservedScroll,
      `sheet scroll moved: ${find(".plugins-sheet-body").scrollTop} vs ${preservedScroll}`,
    );

    root.unmount();
    container.remove();
    return "PASS: chip+summary order, drawer paging/dedup, filter stale-drop, error+retry, link (middle-only, href, failure toast), Tab trap + inert, Escape/focus/scroll restore";
  },

  pluginReviewsStaleSummaryProbe: async () => {
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    let summaryCalls = 0;
    let omitSummaries = false;
    Object.assign(api, {
      ...pageMocks(),
      // The first batch answers the id; once `omitSummaries` flips, the
      // answer drops it the way the centre drops an archived plugin.
      marketReviewSummaries: async () => {
        summaryCalls += 1;
        return omitSummaries ? {} : { "test.focus": summary };
      },
      marketReviews: async () => ({
        reviews: [],
        nextCursor: null,
        summary,
        reviewUrl: REVIEW_URL,
      }),
    });

    usePluginBrowseState.setState({ tab: "market", query: "" });
    const { container, root } = mountProbe();
    await settle(() => !!maybe(".plugins-card-hit"), "stale probe: card");
    await settle(() => !!maybe(".plugins-rating"), "stale probe: first rating chip");
    check(summaryCalls >= 1, "stale probe: no summaries batch ran");

    // Any marketplace refresh asks again with the full id set; the second
    // answer omits the plugin, so its rating must stop rendering.
    const callsBefore = summaryCalls;
    omitSummaries = true;
    usePluginBrowseState.setState({ query: "focus" });
    await settle(() => summaryCalls > callsBefore, "stale probe: second summaries batch");
    await settle(() => !maybe(".plugins-rating"), "stale probe: stale chip survived");

    root.unmount();
    container.remove();
    return "PASS: a summaries success that omits a requested id removes its stale rating chip";
  },

  pluginReviewsUnavailableSummaryProbe: async () => {
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    let summaryCalls = 0;
    let reviewsFailOnce = true;
    Object.assign(api, {
      ...pageMocks(),
      marketReviewSummaries: async () => {
        summaryCalls += 1;
        throw new Error("centre unavailable");
      },
      marketReviews: async () => {
        if (reviewsFailOnce) {
          reviewsFailOnce = false;
          throw new Error("centre unavailable");
        }
        return {
          reviews: [review("f1", "fallback works")],
          nextCursor: null,
          summary,
          reviewUrl: REVIEW_URL,
        };
      },
    });

    usePluginBrowseState.setState({ tab: "market", query: "" });
    const { container, root } = mountProbe();
    await settle(() => !!maybe(".plugins-card-hit"), "unavailable probe: card");
    await settle(() => summaryCalls >= 1, "unavailable probe: summaries attempt");
    check(!maybe(".plugins-rating"), "unavailable probe: chip rendered without a summary");

    find(".plugins-card-hit").click();
    await settle(() => !!maybe(".plugins-sheet"), "unavailable probe: detail sheet");
    const ratingsSection = () =>
      [...document.querySelectorAll<HTMLElement>(".plugins-sheet-section")].find(
        (node) =>
          node
            .querySelector(".plugins-sheet-section-title")
            ?.textContent?.includes("Ratings & reviews") ?? false,
      );
    await settle(() => !!ratingsSection(), "unavailable probe: ratings section");
    check(
      ratingsSection()?.textContent?.includes("Ratings aren't available from this source.") ===
        true,
      `unavailable probe: copy missing: ${ratingsSection()?.textContent}`,
    );
    const opener = ratingsSection()?.querySelector<HTMLButtonElement>(
      ".plugins-sheet-reviews-action button",
    );
    check(!!opener, "unavailable probe: drawer entry missing without a summary");
    opener.click();

    await settle(() => !!maybe(".plugins-reviews"), "unavailable probe: drawer");
    await settle(
      () => !!maybe(".plugins-reviews-state[role='alert']"),
      "unavailable probe: drawer retry state",
    );
    const composer = find<HTMLTextAreaElement>(".plugins-reviews-composer-field");
    check(composer.disabled === true, "unavailable probe: composer is not disabled");
    const fallbackWrite = find<HTMLAnchorElement>(".plugins-reviews-write");
    check(
      fallbackWrite.href === "https://plugins.aiuo.net/plugins/test.focus#reviews",
      `unavailable probe: fallback write link: ${fallbackWrite.href}`,
    );

    // The retry recovers the independent list, and the host's page URL takes
    // over from the fallback.
    find(".plugins-reviews-state[role='alert'] button").click();
    await settle(
      () => texts(".plugins-review-body").includes("fallback works"),
      "unavailable probe: retry recovered the list",
    );
    check(
      find<HTMLAnchorElement>(".plugins-reviews-write").href === REVIEW_URL,
      "unavailable probe: page URL did not replace the fallback",
    );

    root.unmount();
    container.remove();
    return "PASS: unavailable summary keeps the drawer entry; retry recovers the list and the fallback web link stays";
  },

  pluginReviewsNarrowDrawerProbe: async () => {
    step("narrow:init");
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    // Enough rows to make the drawer body scroll at a narrow viewport.
    const manyReviews = Array.from({ length: 14 }, (_, index) =>
      review(`r${index + 1}`, `Review body number ${index + 1}, long enough to occupy a line.`),
    );
    Object.assign(api, {
      ...pageMocks(),
      marketReviewSummaries: async () => ({ "test.focus": summary }),
      marketReviews: async () => ({
        reviews: manyReviews,
        nextCursor: null,
        summary,
        reviewUrl: REVIEW_URL,
      }),
    });

    usePluginBrowseState.setState({ tab: "market", query: "" });
    step("narrow:render");
    const { container, root } = mountProbe();
    await settle(() => !!maybe(".plugins-card-hit"), "narrow probe: card");
    find(".plugins-card-hit").click();
    await settle(() => !!maybe(".plugins-sheet-reviews-action button"), "narrow probe: opener");
    find(".plugins-sheet-reviews-action button").click();
    await settle(() => !!maybe(".plugins-reviews"), "narrow probe: drawer");

    step("narrow:geometry");
    const viewport = window.innerWidth;
    check(viewport <= 375, `viewport is not narrow: ${viewport}`);
    const drawer = find(".plugins-reviews");
    const drawerRect = drawer.getBoundingClientRect();
    check(
      drawerRect.left >= -0.5 && drawerRect.right <= viewport + 0.5 && drawerRect.width <= viewport,
      `drawer outside the viewport: ${JSON.stringify(drawerRect)} parent ${JSON.stringify(drawer.parentElement!.getBoundingClientRect())} viewport ${viewport}`,
    );
    check(
      document.documentElement.scrollWidth <= viewport + 1,
      `page overflows horizontally: ${document.documentElement.scrollWidth} > ${viewport}`,
    );
    const body = find(".plugins-reviews-body");
    check(body.scrollWidth <= body.clientWidth + 1, "drawer body overflows horizontally");

    step("narrow:controls");
    const controls = [
      ...document.querySelectorAll<HTMLElement>(".plugins-reviews-filters button"),
      ...document.querySelectorAll<HTMLElement>(".plugins-reviews-head button"),
      find(".plugins-reviews-write"),
    ];
    check(controls.length >= 7, `expected filter/sort/close/link controls, saw ${controls.length}`);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      check(
        rect.left >= drawerRect.left - 0.5 && rect.right <= drawerRect.right + 0.5,
        `control outside the drawer: ${control.className || control.getAttribute("aria-label")}`,
      );
    }
    const filterByText = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(".plugins-reviews-filters button")].find(
        (button) => button.textContent === text,
      )!;
    filterByText("Positive").click();
    await settle(
      () => filterByText("Positive").getAttribute("aria-pressed") === "true",
      "narrow probe: filter usable",
    );
    filterByText("Most helpful").click();
    await settle(
      () => filterByText("Most helpful").getAttribute("aria-pressed") === "true",
      "narrow probe: sort usable",
    );

    step("narrow:scroll");
    check(body.scrollHeight > body.clientHeight, "drawer body does not scroll");
    body.scrollTop = 120;
    check(body.scrollTop > 0, "drawer body did not scroll");
    const composerRect = find(".plugins-reviews-composer").getBoundingClientRect();
    check(
      composerRect.bottom <= window.innerHeight + 0.5 && composerRect.top >= -0.5,
      `composer is not pinned inside the viewport: ${JSON.stringify(composerRect)}`,
    );

    const opened: string[] = [];
    Object.assign(api, {
      browserOpenExternal: async (url?: string) => {
        opened.push(String(url));
        return { ok: true };
      },
    });
    find<HTMLAnchorElement>(".plugins-reviews-write").click();
    check(opened.length === 1 && opened[0] === REVIEW_URL, `write link: ${JSON.stringify(opened)}`);

    step("narrow:close");
    const close = [...document.querySelectorAll<HTMLButtonElement>(".plugins-reviews-head button")].find(
      (button) => button.getAttribute("aria-label") === "Close reviews",
    )!;
    check(!!close, "close button missing");
    close.click();
    await settle(() => !maybe(".plugins-reviews"), "narrow probe: drawer closed");
    check(!!maybe(".plugins-sheet"), "closing the drawer closed the sheet");

    root.unmount();
    container.remove();
    return "PASS: at a narrow viewport the drawer stays inside it with no horizontal overflow; filters, sort, close and the write link are all usable; the body scrolls and the composer stays pinned";
  },

  pluginReviewsBatchProbe: async () => {
    step("batch:init");
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const otherPlugin = { ...plugin, id: "other.plugin", name: "Other Plugin" };
    const freshPlugin = { ...plugin, id: "fresh.plugin", name: "Fresh Plugin" };
    let summariesCalls = 0;
    let lastIds: string[] = [];
    let releaseStale: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    Object.assign(api, {
      ...pageMocks(),
      // An empty query shows one plugin; a typed query shows two. The summary
      // batch for the first market list is held back so it can only land after
      // the batch for the final list.
      marketSearch: async (query?: string) => ({
        plugins: String(query ?? "").trim() ? [freshPlugin, otherPlugin] : [otherPlugin],
      }),
      marketReviewSummaries: async (ids: string[]) => {
        summariesCalls += 1;
        lastIds = [...ids];
        if (summariesCalls === 1) {
          await staleGate;
          // The abandoned query's answer would paint a chip for a plugin the
          // final batch no longer rates.
          return { "other.plugin": summary };
        }
        return { "fresh.plugin": summary };
      },
      marketReviews: async () => ({
        reviews: [],
        nextCursor: null,
        summary,
        reviewUrl: REVIEW_URL,
      }),
    });

    usePluginBrowseState.setState({ tab: "market", query: "" });
    step("batch:render");
    const { container, root } = mountProbe();
    await settle(() => !!maybe(".plugins-card-hit"), "batch probe: first market list");
    await settle(() => summariesCalls >= 1, "batch probe: first summaries batch");
    check(
      texts(".plugins-card-name").join("|") === "Other Plugin",
      `first list: ${texts(".plugins-card-name").join("|")}`,
    );

    // Typing settles on the fresh query: same behavior as the debounced
    // search, asserted as stable content rather than a fixed delay.
    step("batch:type");
    usePluginBrowseState.setState({ query: "fr" });
    await settle(
      () => texts(".plugins-card-name").join("|") === "Fresh Plugin|Other Plugin",
      "batch probe: fresh query rendered",
    );
    await settle(() => !!maybe(".plugins-rating"), "batch probe: fresh chip");
    check(
      find(".plugins-rating").textContent?.includes("4.5 (3)") === true,
      `fresh chip text: ${find(".plugins-rating").textContent}`,
    );
    check(
      cardByName("Other Plugin").querySelector(".plugins-rating") === null,
      "other plugin rendered a chip the final batch did not rate",
    );
    check(
      JSON.stringify([...lastIds].sort()) === JSON.stringify(["fresh.plugin", "other.plugin"]),
      `final batch ids: ${JSON.stringify(lastIds)}`,
    );

    step("batch:release");
    releaseStale?.();
    await delay(250);
    // The late answer for the left-behind id paints nothing: the fresh chip
    // stays and the stale rating never appears on the visible card.
    check(!!maybe(".plugins-rating"), "fresh chip lost after the stale answer landed");
    check(
      find(".plugins-rating").textContent?.includes("4.5 (3)") === true,
      "fresh chip changed after the stale answer landed",
    );
    check(
      cardByName("Other Plugin").querySelector(".plugins-rating") === null,
      "a late summaries answer for an abandoned query painted a chip",
    );
    check(
      JSON.stringify(texts(".plugins-card-name")) === JSON.stringify(["Fresh Plugin", "Other Plugin"]),
      `cards after settling: ${texts(".plugins-card-name").join("|")}`,
    );

    root.unmount();
    container.remove();
    return "PASS: the final summaries batch carries exactly the displayed ids, and a late answer for an abandoned query is discarded";
  },
});

function Probe() {
  const model = usePluginsPage();
  return (
    <>
      <MarketplacePanel {...model} />
      <PluginDetailSheet {...model} />
    </>
  );
}
