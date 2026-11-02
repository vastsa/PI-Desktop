import assert from "node:assert/strict";
import { waitFor } from "./wait.mjs";

export async function verifyScheduledSettingsSwitch({ task, invoke, evaluate, click, fill, key, send }) {
  const beforeDisable = await invoke("scheduledList");
  await evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await click("General", ".settings-nav-item");
  await waitFor(() => evaluate(`document.querySelector('[role="switch"][aria-label="Scheduled tasks"]')?.getAttribute('aria-checked') === 'true'`), 10_000, "scheduled tasks enabled by default");
  await click("Scheduled tasks", '[role="switch"]', true);
  await waitFor(async () => (await invoke("settingsGet")).scheduledTasksEnabled === false, 5000, "disabled setting persisted");
  await click("Back to app", '[data-nav="back-to-app"]');
  assert.equal(await evaluate(`!!document.querySelector('[data-nav="scheduled"]')`), false);
  assert.deepEqual(await invoke("scheduledList"), beforeDisable, "switch cannot rewrite individual tasks");
  await assert.rejects(() => invoke("scheduledExecute", task.id), /INVALID_PARAMS/);
  await click("Search", "button", true);
  await fill(".search-input", "Scheduled");
  await waitFor(() => evaluate(`document.querySelector('.search-dialog')?.innerText.includes('Scheduled tasks')`), 5000, "settings switch remains discoverable");
  assert.equal(await evaluate(`[...document.querySelectorAll('.search-item-title')].some(e => e.textContent.trim() === 'Scheduled')`), false, "disabled page is absent from search");
  await key("Escape", 27);
  await send("Page.reload");
  await waitFor(() => evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`), 30_000, "renderer reload with saved settings");
  assert.equal(await evaluate(`!!document.querySelector('[data-nav="scheduled"]')`), false);
  await evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await click("General", ".settings-nav-item");
  await waitFor(() => evaluate(`document.querySelector('[role="switch"][aria-label="Scheduled tasks"]')?.getAttribute('aria-checked') === 'false'`), 10_000, "disabled switch restored");
  await click("Scheduled tasks", '[role="switch"]', true);
  await waitFor(async () => (await invoke("settingsGet")).scheduledTasksEnabled === true, 5000, "enabled setting persisted");
  await click("Back to app", '[data-nav="back-to-app"]');
  await waitFor(() => evaluate(`!!document.querySelector('[data-nav="scheduled"]')`), 5000, "scheduled entry restored");
  await evaluate(`document.querySelector('[data-nav="scheduled"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.page-title') && document.body.innerText.includes(${JSON.stringify(task.title)})`), 10_000, "same scheduled task restored");
  assert.deepEqual(await invoke("scheduledList"), beforeDisable);
  console.log("PASS scheduled settings: default on, disable, hide navigation/search, reject runs, reload, re-enable, preserve tasks");
}
