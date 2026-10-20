// Reuse the production SettingsPage fixture; mock only its preload boundary.
import "./settings-scroll.jsx";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { setNotificationSoundSettings } from "../../apps/desktop/src/lib/notification-sound";

const storageKey = "notification-sound-e2e-settings";
let saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {
  ...useAppStore.getState().settings,
  networkProxy: { mode: "system" },
};
const originalInvoke = window.piDesktop.invoke;
let rejectSave = false;
window.piDesktop.invoke = async (channel, input) => {
  if (channel === IPC.invoke.settingsGet) return { ok: true, data: saved };
  if (channel === IPC.invoke.settingsSet) {
    if (rejectSave) throw new Error("Fixture settings write failed");
    saved = input;
    localStorage.setItem(storageKey, JSON.stringify(saved));
    return { ok: true, data: saved };
  }
  return originalInvoke(channel, input);
};
document.documentElement.dataset.theme = saved.theme;
setNotificationSoundSettings(saved.notificationSound);
flushSync(() => useAppStore.setState({ settings: saved, settingsTab: "general" }));

const frame = () => new Promise(requestAnimationFrame);
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate, message) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await frame();
  }
}
const control = () => document.querySelector(".settings-notification-sound-control");
const modeButton = () => control()?.querySelector('[aria-haspopup="listbox"]');
async function chooseMode(label) {
  flushSync(() => modeButton().click());
  await until(() => document.querySelector('[role="option"]'), "Sound menu must open");
  const option = [...document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent.trim() === label);
  assert(option, `Missing sound mode ${label}`);
  flushSync(() => option.click());
}
function wav() {
  const count = 1_600;
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((c, index) => view.setUint8(offset + index, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true); view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 660 / 8_000) * 2_000, true);
  return bytes;
}
async function upload(file) {
  const input = control().querySelector('input[type="file"]');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await frame();
}

window.notificationSoundProbe = async (phase) => {
  await until(control, "Production sound control must render");
  if (phase === "restore") {
    assert(saved.notificationSound?.mode === "custom", "Custom choice must survive process restart");
    assert(control().textContent.includes("completion.wav"), "Saved filename must restore");
    assert(saved.notificationSound.customDataUrl.startsWith("data:audio/wav;base64,"), "Audio must be self-contained");
    return { restored: true };
  }
  assert(modeButton().textContent.includes("System default"), "Missing settings must use the system chime");
  const input = control().querySelector('input[type="file"]');
  let pickerOpened = false;
  input.click = () => { pickerOpened = true; }; // Native file picker is the external edge.
  await chooseMode("Custom audio");
  assert(pickerOpened, "Selecting Custom must open the audio picker");
  await upload(new File([wav()], "completion.wav", { type: "audio/wav" }));
  await until(() => saved.notificationSound?.mode === "custom" && control().getAttribute("aria-busy") === "false", "Custom audio must persist");
  assert(control().textContent.includes("completion.wav"), "Chosen filename must be visible");
  const preview = [...control().querySelectorAll("button")].find((node) => node.textContent === "Preview");
  assert(preview && !preview.disabled, "Custom audio must expose enabled Preview");
  let played = false;
  const BrowserAudio = window.Audio;
  window.Audio = function (source) {
    const audio = new BrowserAudio(source);
    audio.addEventListener("play", () => { played = true; }, { once: true });
    return audio;
  };
  preview.click();
  await until(() => played, "Preview must play the actual WAV through browser audio");
  await chooseMode("System default");
  await until(() => saved.notificationSound?.mode === "system" && control().getAttribute("aria-busy") === "false", "System choice must persist");
  await chooseMode("Custom audio");
  await until(() => saved.notificationSound?.mode === "custom" && control().getAttribute("aria-busy") === "false", "Previously chosen custom audio must be reusable");
  const previous = JSON.stringify(saved.notificationSound);
  await upload(new File(["text"], "invalid.txt", { type: "text/plain" }));
  await until(() => control().querySelector('[role="status"]'), "Invalid file must report an error");
  assert(JSON.stringify(saved.notificationSound) === previous, "Invalid audio must preserve the saved selection");
  await upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.wav", { type: "audio/wav" }));
  await until(() => control().textContent.includes("5 MB"), "Oversized audio must report the limit");
  assert(JSON.stringify(saved.notificationSound) === previous, "Oversized audio must preserve the saved selection");
  rejectSave = true;
  await chooseMode("System default");
  await until(() => control().textContent.includes("Could not save"), "Write failure must report an error");
  assert(saved.notificationSound.mode === "custom", "Write failure must preserve the saved preference");
  rejectSave = false;
  await upload(new File([wav()], "completion.wav", { type: "audio/wav" }));
  await until(() => !control().querySelector('[role="status"]') && control().getAttribute("aria-busy") === "false", "Successful retry must clear the error");
  i18n.addResourceBundle("zh-CN", "translation", flattenCatalog(catalogs["zh-CN"]));
  saved = { ...saved, language: "zh-CN" };
  localStorage.setItem(storageKey, JSON.stringify(saved));
  flushSync(() => useAppStore.setState({ settings: saved }));
  await i18n.changeLanguage("zh-CN");
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.theme = saved.theme;
  control().scrollIntoView({ block: "center" });
  await document.fonts.ready;
  await Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished));
  await frame(); await frame();
  const row = control().closest(".settings-row").getBoundingClientRect();
  return {
    upload: true, preview: true, modeSwitch: true, invalidFile: true, sizeLimit: true, saveFailure: true,
    clip: { x: Math.floor(row.x), y: Math.floor(row.y), width: Math.ceil(row.width), height: Math.ceil(row.height) },
  };
};
