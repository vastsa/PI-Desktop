import type { ChineseVariant } from "./types.js";

type Converter = (text: string) => string;

const converters = new Map<ChineseVariant, Promise<Converter>>();

async function createConverter(variant: ChineseVariant): Promise<Converter> {
  const { default: OpenCC } = await import("opencc-js");
  switch (variant) {
    case "simplified":
      return OpenCC.Converter({ from: "t", to: "cn" });
    case "traditional-taiwan":
      return OpenCC.Converter({ from: "cn", to: "tw" });
    case "traditional-hong-kong":
      return OpenCC.Converter({ from: "cn", to: "hk" });
  }
}

function converterFor(variant: ChineseVariant): Promise<Converter> {
  const existing = converters.get(variant);
  if (existing) return existing;

  const loading = createConverter(variant);
  converters.set(variant, loading);
  void loading.catch(() => {
    if (converters.get(variant) === loading) converters.delete(variant);
  });
  return loading;
}

/** Check whether a language code represents Chinese (Mandarin or Cantonese). */
export function isChineseLanguage(language: string): boolean {
  const base = language.toLowerCase().split("-", 1)[0];
  return base === "zh" || base === "yue";
}

/** Convert Chinese text to the specified variant using OpenCC. */
export async function convertChineseOutput(
  text: string,
  variant: ChineseVariant,
): Promise<string> {
  return (await converterFor(variant))(text);
}
