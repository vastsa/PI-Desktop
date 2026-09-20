/**
 * Global UI font model for the Settings picker.
 *
 * A selection is stored as a CSS `font-family` stack string in
 * `AppSettings.fontFamily`. Only installed system families are offered — the
 * app ships no fonts of its own — and every stack keeps system CJK fallbacks
 * so Chinese text stays readable when the selected family has no CJK glyphs.
 */
/**
 * CJK fallback tier appended to every custom stack. All three families are
 * provided by the platform; the app bundles no CJK face of its own.
 */
const CJK_FALLBACK = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;

export type FontOption = {
  /** CSS stack persisted on selection; `""` selects the system default. */
  value: string;
  /** Readable family name shown in the picker. */
  label: string;
  /** Family used to render the picker preview in the chosen face. */
  family: string;
  group: "default" | "system" | "custom";
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
 * Build the picker options: the system default, then installed system
 * families. The current stored stack is re-added first when it no longer
 * matches any known option — the family was uninstalled, or the stack names
 * one of the bundled faces an earlier build shipped and this one no longer
 * does.
 */
export function buildFontOptions(
  systemFonts: readonly string[],
  selected: string | undefined,
): FontOption[] {
  const options: FontOption[] = [
    { value: "", label: "System default", family: "", group: "default" },
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
