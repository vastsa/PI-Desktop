import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { PullRequestsPage } from "../../apps/desktop/src/pages/PullRequestsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const firstWorkspace = { path: "/fixtures/first", name: "First project" };
const secondWorkspace = { path: "/fixtures/second", name: "Second project" };
const requests = [];

window.piDesktop = {
  platform: "darwin",
  on: () => () => {},
  async invoke(channel) {
    if (channel !== IPC.invoke.pullsList) {
      throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    const workspacePath = useAppStore.getState().workspace?.path;
    return new Promise((resolve) => requests.push({ workspacePath, resolve }));
  },
};

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

useAppStore.setState({ workspace: firstWorkspace });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
flushSync(() =>
  root.render(
    <I18nextProvider i18n={i18n}>
      <PullRequestsPage />
    </I18nextProvider>,
  ),
);

const frame = () => new Promise(requestAnimationFrame);
async function settle() {
  await frame();
  await frame();
}
function assert(value, message) {
  if (!value) throw new Error(message);
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message);
}
function requestsFor(workspacePath) {
  return requests.filter((request) => request.workspacePath === workspacePath);
}
function release(request, pulls) {
  assert(request, "Expected a held pull request list call");
  request.resolve({ ok: true, data: { pulls } });
}

window.pullRequestsLoadingProbe = async () => {
  await waitFor(
    () => requestsFor(firstWorkspace.path).length === 1,
    "First workspace request was not issued",
  );
  const pending = container.querySelector('[role="status"][aria-busy="true"]');
  assert(pending, "Pending list must show its accessible loading status");
  assert(
    !container.querySelector(".page-empty-icon"),
    "Pending list must not look like an empty result",
  );

  flushSync(() => useAppStore.setState({ workspace: secondWorkspace }));
  await waitFor(
    () => requestsFor(secondWorkspace.path).length === 1,
    "Second workspace request was not issued",
  );
  const secondWorkspacePulls = [
    {
      number: 22,
      title: "Second workspace open pull request",
      url: "https://example.invalid/pull/22",
      author: "fixture",
      isDraft: false,
      headRefName: "feature/open",
      baseRefName: "main",
    },
    {
      number: 23,
      title: "Second workspace draft pull request",
      url: "https://example.invalid/pull/23",
      author: "fixture",
      isDraft: true,
      headRefName: "feature/draft",
      baseRefName: "main",
    },
  ];
  release(requestsFor(secondWorkspace.path)[0], secondWorkspacePulls);
  await waitFor(
    () => container.textContent?.includes("Second workspace open pull request"),
    "Second workspace rows did not render",
  );

  const refresh = container.querySelector(".page-header .flex button");
  assert(refresh instanceof HTMLButtonElement, "Refresh button must be rendered");
  flushSync(() => refresh.click());
  await waitFor(
    () => requestsFor(secondWorkspace.path).length === 2,
    "Explicit refresh request was not issued",
  );
  assert(
    container.textContent?.includes("Second workspace open pull request"),
    "Explicit refresh must keep current rows visible",
  );
  release(requestsFor(secondWorkspace.path)[1], secondWorkspacePulls);
  await waitFor(
    () => !refresh.disabled,
    "Explicit refresh did not finish",
  );

  const allTab = [...container.querySelectorAll('[role="tab"]')].find((tab) =>
    tab.textContent?.includes("All"),
  );
  assert(allTab?.textContent?.replace(/\s+/g, "").endsWith("2"), "Filter count must match current workspace rows");
  flushSync(() => allTab.click());
  release(requestsFor(firstWorkspace.path)[0], [
    {
      number: 11,
      title: "Stale first workspace pull request",
      url: "https://example.invalid/pull/11",
      isDraft: false,
    },
  ]);
  await settle();
  assert(
    container.textContent?.includes("Second workspace open pull request") &&
      container.textContent.includes("Second workspace draft pull request"),
    "Completing an older request must preserve second workspace rows",
  );
  assert(
    !container.textContent?.includes("Stale first workspace pull request"),
    "A stale request must not replace current workspace rows",
  );

  root.unmount();
  return { ok: true, requestCount: requests.length, workspaceRows: 2 };
};
