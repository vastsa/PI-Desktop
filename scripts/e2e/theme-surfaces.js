/** Real CSS cascade probe; fixture classes use the built app's complete stylesheet. */
// Built-in sRGB paint and shadows sampled from the pre-fix a9053531 app.
const DEFAULT_RGBA = {"light":{"rail":[244,244,244,255],"search":[255,255,255,255],"active":[224,224,225,255],"knob":[255,255,255,255],"composer":[255,255,255,255],"pluginSearch":[243,243,243,255],"capabilitySearch":[243,243,243,255],"pluginFocus":[255,255,255,255],"capabilityFocus":[255,255,255,255]},"dark":{"rail":[0,0,0,255],"search":[33,33,33,255],"active":[255,255,255,26],"knob":[24,24,24,255],"composer":[33,33,33,245],"pluginSearch":[255,255,255,13],"capabilitySearch":[255,255,255,13],"pluginFocus":[255,255,255,18],"capabilityFocus":[255,255,255,18]}};
const DEFAULT_SHADOWS = {"light":{"knob":"rgba(0, 0, 0, 0.22) 0px 1px 2px 0px","composer":"rgba(0, 0, 0, 0.04) 0px 3px 7.5px 0px, rgba(0, 0, 0, 0.05) 0px 0px 20px 0px","pluginFocus":"oklab(0.22559 -0.00131416 -0.00642684 / 0.35) 0px 0px 0px 1px","capabilityFocus":"oklab(0.22559 -0.00131416 -0.00642684 / 0.35) 0px 0px 0px 1px"},"dark":{"knob":"rgba(0, 0, 0, 0.16) 0px 1px 2px 0px","composer":"rgba(0, 0, 0, 0.04) 0px 3px 7.5px 0px, rgba(0, 0, 0, 0.05) 0px 0px 20px 0px","pluginFocus":"oklab(0.999994 0.0000455678 0.0000200868 / 0.45) 0px 0px 0px 1px","capabilityFocus":"oklab(0.999994 0.0000455678 0.0000200868 / 0.45) 0px 0px 0px 1px"}};
const surfaces = {
  rail: [".settings-nav", "--ds-settings-rail-bg"],
  search: [".settings-search", "--ds-settings-field-bg"],
  active: [".settings-nav-item.active", "--ds-settings-nav-active"],
  knob: [".settings-toggle-thumb", "--ds-switch-knob-on"],
  composer: [".composer-shell", "--ds-bg-elevated-primary"],
  pluginSearch: [".plugins-search", "--ds-field-inset-bg"],
  capabilitySearch: [".agent-capability-search-wrap", "--ds-field-inset-bg"],
};
const customColors = {
  "--ds-settings-rail-bg": "#243645",
  "--ds-settings-field-bg": "#365476",
  "--ds-settings-nav-active": "#526f82",
  "--ds-switch-knob-on": "#e7ae41",
  "--ds-bg-elevated-primary": "#604679",
  "--ds-bg-composer": "#715667",
  "--ds-field-inset-bg": "#325e53",
  "--ds-field-inset-focus-bg": "#487b65",
};
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const context = canvas.getContext("2d", { willReadFrequently: true });
function rgba(color) {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}
async function settle() {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
function sample(selector) {
  const element = document.querySelector(selector);
  const style = getComputedStyle(element);
  return { color: style.backgroundColor, rgba: rgba(style.backgroundColor), shadow: style.boxShadow };
}
globalThis.themeSurfacesProbe = async (theme, custom) => {
  document.documentElement.dataset.theme = theme;
  document.querySelector("#custom-theme")?.remove();
  if (custom) {
    const style = document.createElement("style");
    style.id = "custom-theme";
    style.textContent = `:root[data-theme="${theme}"] { ${Object.entries(customColors).map(([name, value]) => `${name}: ${value};`).join(" ")} }`;
    document.head.append(style);
  }
  document.activeElement?.blur();
  await settle();
  const values = Object.fromEntries(Object.entries(surfaces).map(([id, [selector]]) => [id, sample(selector)]));
  const failures = [];
  for (const [id, target, selector] of [
    ["pluginFocus", ".plugins-search", ".plugins-search"],
    ["capabilityFocus", ".agent-capability-search", ".agent-capability-search-wrap"],
  ]) {
    document.querySelector(target).focus();
    await settle();
    if (id === "pluginFocus" && !document.querySelector(target).matches(":focus-visible")) failures.push("plugin search did not receive keyboard focus");
    values[id] = sample(selector);
    document.activeElement.blur();
    await settle();
  }
  if (custom) {
    for (const [id, [, token]] of Object.entries(surfaces)) {
      const effectiveToken = id === "composer" && theme === "light" ? "--ds-bg-composer" : token;
      if (String(values[id].rgba) !== String(rgba(customColors[effectiveToken]))) failures.push(`${id} ignores ${token}`);
    }
    for (const id of ["pluginFocus", "capabilityFocus"]) {
      if (String(values[id].rgba) !== String(rgba(customColors["--ds-field-inset-focus-bg"]))) failures.push(`${id} ignores focus token`);
    }
  }
  if (!custom) {
    for (const [id, value] of Object.entries(values)) {
      if (String(value.rgba) !== String(DEFAULT_RGBA[theme][id])) failures.push(`${id} changed built-in paint`);
      if (value.shadow !== (DEFAULT_SHADOWS[theme][id] ?? "none")) failures.push(`${id} changed built-in shadow`);
    }
  }
  return { ok: failures.length === 0, theme, custom, values, failures,
    elevatedToken: getComputedStyle(document.documentElement).getPropertyValue("--ds-bg-elevated-primary").trim(),
    elevatedRgba: rgba(getComputedStyle(document.documentElement).getPropertyValue("--ds-bg-elevated-primary").trim()) };
};
