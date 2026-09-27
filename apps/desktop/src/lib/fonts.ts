/**
 * Global UI font model for the Settings picker.
 *
 * A selection is stored as a CSS `font-family` stack string in
 * `AppSettings.fontFamily`. Bundled families are open-licensed
 * (SIL OFL 1.1) and shipped with the app; system families are enumerated
 * by Electron main. Every stack keeps CJK fallbacks so Chinese text stays
 * readable when the selected family has no CJK glyphs.
 */
/**
 * CJK fallback tier appended to every custom stack. Noto Sans SC is bundled
 * (OFL); PingFang/YaHei cover platforms where it is not installed.
 */
const CJK_FALLBACK = `"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

export type BundledFont = {
  /** Stable id used only for option keys, never persisted. */
  id: string;
  /** Human-readable family name shown in the picker. */
  label: string;
  /** CSS family name registered by @font-face (fonts.css). */
  family: string;
  /** Full CSS stack persisted when the option is selected. */
  stack: string;
  /** Short license note shown under the option. */
  license: string;
};

export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    id: "geist",
    label: "Geist",
    family: "Geist",
    license: "OFL",
    stack: `"Geist", ${CJK_FALLBACK}`,
  },
  {
    id: "inter",
    label: "Inter",
    family: "Inter",
    license: "OFL",
    stack: `"Inter", ${CJK_FALLBACK}`,
  },
  {
    id: "noto-sans-sc",
    label: "Noto Sans SC",
    family: "Noto Sans SC",
    license: "OFL",
    stack: `"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`,
  },
  {
    id: "lxgw-wenkai",
    label: "LXGW WenKai",
    family: "LXGW WenKai",
    license: "OFL",
    stack: `"LXGW WenKai", ${CJK_FALLBACK}`,
  },
];

export type FontOption = {
  /** CSS stack persisted on selection; `""` selects the system default. */
  value: string;
  /** Readable family name shown in the picker. */
  label: string;
  /** Family used to render the picker preview in the chosen face. */
  family: string;
  group: "default" | "bundled" | "system" | "custom";
  license?: string;
};

/** Quote a bare family name for use inside a CSS font-family stack. */
export function cssFamilyForName(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Extract the first readable family name from a CSS stack. */
export function readableFontFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? stack;
  return first.replace(/^['"]|['"]$/g, "").replace(/\\'/g, "'");
}

function systemStack(family: string): string {
  return `${cssFamilyForName(family)}, ${CJK_FALLBACK}`;
}

/**
 * Build the picker options: system default, bundled open-licensed families,
 * then installed system families. The current stored stack is re-added first
 * when it no longer matches any known option (e.g. the font was uninstalled).
 */
export function buildFontOptions(
  systemFonts: readonly string[],
  selected: string | undefined,
): FontOption[] {
  const options: FontOption[] = [
    { value: "", label: "System default", family: "", group: "default" },
    ...BUNDLED_FONTS.map((font) => ({
      value: font.stack,
      label: font.label,
      family: font.family,
      license: font.license,
      group: "bundled" as const,
    })),
    ...systemFonts.map((family) => ({
      value: systemStack(family),
      label: family,
      family,
      group: "system" as const,
    })),
  ];
  const known = new Set(options.map((option) => option.value));
  if (selected && !known.has(selected)) {
    options.unshift({
      value: selected,
      label: readableFontFamily(selected),
      family: readableFontFamily(selected),
      group: "custom",
    });
  }
  return options;
}

let cachedSystemFonts: string[] | null = null;
let pendingSystemFonts: Promise<string[]> | null = null;

/** Installed system font families, fetched once per process via Electron main. */
export async function loadSystemFonts(): Promise<string[]> {
  if (cachedSystemFonts) return cachedSystemFonts;
  pendingSystemFonts ??= import("./api")
    .then(({ api }) => api.listSystemFonts())
    .finally(() => {
      pendingSystemFonts = null;
    });
  cachedSystemFonts = await pendingSystemFonts;
  return cachedSystemFonts;
}
