import { describe, expect, it } from "vitest";
import {
  formatPluginThemeVariables,
  normalizePluginThemeVariableValues,
  validatePluginThemeVariables,
  type PluginThemeVariableContrib,
} from "./theme-variables.js";

const declarations: PluginThemeVariableContrib[] = [
  { name: "--nexus-backdrop-blur", type: "length", unit: "px", min: 0, max: 20, default: 6 },
  { name: "--nexus-opacity", type: "number", min: 0, max: 1, default: 0.75 },
  { name: "--nexus-accent", type: "color", default: "#42a875" },
  { name: "--nexus-density", type: "select", values: ["calm", "dense"], default: "calm" },
];

describe("plugin theme variables", () => {
  it("accepts and serializes only typed declared values", () => {
    const values = validatePluginThemeVariables(declarations, {
      "--nexus-backdrop-blur": 12,
      "--nexus-opacity": 0.5,
      "--nexus-accent": "#AABBCCDD",
      "--nexus-density": "dense",
    });
    expect(values).toEqual({
      "--nexus-backdrop-blur": 12,
      "--nexus-opacity": 0.5,
      "--nexus-accent": "#AABBCCDD",
      "--nexus-density": "dense",
    });
    expect(formatPluginThemeVariables("plugin:demo.scenic:twilight", declarations, values)).toBe(
      ':root[data-plugin-theme="plugin:demo.scenic:twilight"] { --nexus-backdrop-blur: 12px; --nexus-opacity: 0.5; --nexus-accent: #AABBCCDD; --nexus-density: dense; }',
    );
  });

  it("rejects undeclared and unsafe values", () => {
    expect(() => validatePluginThemeVariables(declarations, { "--pi-bg": "#000000" })).toThrow(/undeclared/i);
    expect(() => validatePluginThemeVariables(declarations, { "--nexus-backdrop-blur": "12px" })).toThrow(/number/i);
    expect(() => validatePluginThemeVariables(declarations, { "--nexus-backdrop-blur": 21 })).toThrow(/range/i);
    expect(() => validatePluginThemeVariables(declarations, { "--nexus-accent": "url(https://bad)" })).toThrow(/color/i);
  });

  it("fills missing values from immutable declared defaults", () => {
    expect(normalizePluginThemeVariableValues(declarations, { "--nexus-backdrop-blur": 4 })).toEqual({
      "--nexus-backdrop-blur": 4,
      "--nexus-opacity": 0.75,
      "--nexus-accent": "#42a875",
      "--nexus-density": "calm",
    });
  });
});
