export { en, type EnglishCatalog } from "./locales/en/index.js";
export { default as enDefault } from "./locales/en/index.js";
export { zhCN } from "./locales/zh-CN/index.js";
export { default as zhCNDefault } from "./locales/zh-CN/index.js";
export { zhTW } from "./locales/zh-TW/index.js";
export { default as zhTWDefault } from "./locales/zh-TW/index.js";
export { tr } from "./locales/tr/index.js";
export { default as trDefault } from "./locales/tr/index.js";
export { es } from "./locales/es/index.js";
export { default as esDefault } from "./locales/es/index.js";
export { fr } from "./locales/fr/index.js";
export { default as frDefault } from "./locales/fr/index.js";
export { de } from "./locales/de/index.js";
export { default as deDefault } from "./locales/de/index.js";
export { ko } from "./locales/ko/index.js";
export { default as koDefault } from "./locales/ko/index.js";
export { ptBR } from "./locales/pt-BR/index.js";
export { default as ptBRDefault } from "./locales/pt-BR/index.js";

export * from "./locale-info.js";

import { en, type EnglishCatalog } from "./locales/en/index.js";
import { zhCN } from "./locales/zh-CN/index.js";
import { zhTW } from "./locales/zh-TW/index.js";
import { tr } from "./locales/tr/index.js";
import { es } from "./locales/es/index.js";
import { fr } from "./locales/fr/index.js";
import { de } from "./locales/de/index.js";
import { ko } from "./locales/ko/index.js";
import { ptBR } from "./locales/pt-BR/index.js";

import type { AppLocale } from "./locale-info.js";

export const catalogs: Record<AppLocale, EnglishCatalog> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  tr,
  de,
  es,
  fr,
  ko,
  "pt-BR": ptBR,
};
