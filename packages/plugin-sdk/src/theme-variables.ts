/** Host-validated CSS custom properties for a contributed plugin theme. */
export type PluginThemeVariableContrib =
  | { name: string; type: "length"; unit: "px"; min: number; max: number; default: number }
  | { name: string; type: "number"; min?: number; max?: number; default: number }
  | { name: string; type: "color"; default: string }
  | { name: string; type: "select"; values: string[]; default: string };

export type PluginThemeVariableValues = Record<string, number | string>;

const VARIABLE_NAME = /^--[a-z][a-z0-9-]{0,63}$/;
const RESERVED_PREFIXES = ["--pi-", "--ds-", "--font-", "--text-", "--motion-"];
const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const SELECT = /^[a-zA-Z0-9._-]{1,64}$/;

export function isPluginThemeVariableName(value: unknown): value is string {
  return typeof value === "string" && VARIABLE_NAME.test(value) && !RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function validatePluginThemeVariableDeclaration(value: unknown): value is PluginThemeVariableContrib {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!isPluginThemeVariableName(item.name)) return false;
  if (item.type === "length") return item.unit === "px" && finite(item.min) && finite(item.max) && Number(item.min) <= Number(item.max) && finite(item.default) && inRange(Number(item.default), Number(item.min), Number(item.max));
  if (item.type === "number") return finite(item.default) && (item.min === undefined || finite(item.min)) && (item.max === undefined || finite(item.max)) && (item.min === undefined || item.max === undefined || Number(item.min) <= Number(item.max)) && inRange(Number(item.default), item.min as number | undefined, item.max as number | undefined);
  if (item.type === "color") return typeof item.default === "string" && COLOR.test(item.default);
  return item.type === "select" && Array.isArray(item.values) && item.values.length > 0 && item.values.every((option) => typeof option === "string" && SELECT.test(option)) && typeof item.default === "string" && item.values.includes(item.default);
}

export function validatePluginThemeVariables(declarations: readonly PluginThemeVariableContrib[], values: unknown): PluginThemeVariableValues {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError("theme variables must be an object");
  const declared = new Map(declarations.map((item) => [item.name, item]));
  const result: PluginThemeVariableValues = {};
  for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
    const declaration = declared.get(name);
    if (!declaration) throw new TypeError(`undeclared theme variable: ${name}`);
    if (declaration.type === "length" || declaration.type === "number") {
      if (!finite(value)) throw new TypeError(`theme variable ${name} must be a finite number`);
      if (!inRange(Number(value), declaration.min, declaration.max)) throw new RangeError(`theme variable ${name} is outside its declared range`);
      result[name] = Number(value);
    } else if (declaration.type === "color") {
      if (typeof value !== "string" || !COLOR.test(value)) throw new TypeError(`theme variable ${name} must be a #rrggbb or #rrggbbaa color`);
      result[name] = value;
    } else {
      if (typeof value !== "string" || !declaration.values.includes(value)) throw new TypeError(`theme variable ${name} must be one declared fixed option`);
      result[name] = value;
    }
  }
  return result;
}

export function normalizePluginThemeVariableValues(declarations: readonly PluginThemeVariableContrib[], values: unknown): PluginThemeVariableValues {
  const requested = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const accepted = validatePluginThemeVariables(declarations, requested);
  return Object.fromEntries(declarations.map((item) => [item.name, accepted[item.name] ?? item.default]));
}

export function formatPluginThemeVariables(themeId: string, declarations: readonly PluginThemeVariableContrib[], values: PluginThemeVariableValues): string {
  const selector = JSON.stringify(String(themeId));
  const body = declarations.map((item) => `${item.name}: ${item.type === "length" ? `${values[item.name] ?? item.default}px` : values[item.name] ?? item.default};`).join(" ");
  return `:root[data-plugin-theme=${selector}] { ${body} }`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: number, min?: number, max?: number): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}
