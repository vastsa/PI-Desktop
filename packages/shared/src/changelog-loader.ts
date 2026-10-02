import { resolveChangelogLocale } from "./changelog-runtime.js";
import type { ChangelogEntry, ChangelogLocale } from "./changelog.js";

export { normalizeChangelogVersion, resolveChangelogLocale } from "./changelog-runtime.js";

type CatalogLoader = () => Promise<readonly ChangelogEntry[]>;

const catalogLoaders: Record<ChangelogLocale, CatalogLoader> = {
  en: () => import("./changelog-en.js").then((module) => module.enEntries),
  "zh-CN": () => import("./changelog-zh-CN.js").then((module) => module.zhCNEntries),
  "zh-TW": () => import("./changelog-zh-TW.js").then((module) => module.zhTWEntries),
  tr: () => import("./changelog-tr.js").then((module) => module.trEntries),
  de: () => import("./changelog-de.js").then((module) => module.deEntries),
  es: () => import("./changelog-es.js").then((module) => module.esEntries),
  fr: () => import("./changelog-fr.js").then((module) => module.frEntries),
  ko: () => import("./changelog-ko.js").then((module) => module.koEntries),
  "pt-BR": () => import("./changelog-pt-BR.js").then((module) => module.ptBREntries),
};

const catalogRequests = new Map<ChangelogLocale, Promise<readonly ChangelogEntry[]>>();

export function loadChangelogCatalog(
  localeInput?: string | null,
): Promise<readonly ChangelogEntry[]> {
  const locale = resolveChangelogLocale(localeInput);
  const existing = catalogRequests.get(locale);
  if (existing) return existing;

  const request = catalogLoaders[locale]();
  catalogRequests.set(locale, request);
  void request.catch(() => {
    if (catalogRequests.get(locale) === request) catalogRequests.delete(locale);
  });
  return request;
}
