/**
 * Matching and ranking for the plugin launcher surface.
 *
 * Pure functions over the host-provided catalog plus the user's local store, so
 * every ordering rule here is unit-testable without a DOM: which tile wins, why
 * it won, how many matches there were, and which plugin (if any) receives the
 * typed input.
 *
 * Ranking, best first:
 *   0 declared trigger (whole-input regex match) — a plugin asking for `1+1`
 *     outranks every name that merely contains `1`
 *   1 exact name      2 exact alias
 *   3 name prefix     4 pinyin prefix      5 initials prefix
 *   6 name substring  7 pinyin substring   8 alias substring  9 description
 * Ties break on recency, then plugins before applications, then name, then
 * catalog order — so the order is stable across renders.
 */
import {
  LAUNCHER_TRIGGER_INPUT_MAX_LENGTH,
  type LauncherAppEntry,
  type LauncherAppSource,
  type LauncherCatalog,
  type LauncherItemKind,
  type LauncherMatchReason,
  type LauncherPluginEntry,
  type LauncherTriggerMeta,
} from "@pi-desktop/shared";
import {
  launcherMonogram,
  launcherPinyinTokens,
  normalizeLauncherText,
} from "./launcher-text.ts";
import {
  launcherTriggerKey,
  type LauncherStoreSnapshot,
} from "./launcher-store.ts";

/** Tiles per grid row. */
export const LAUNCHER_COLUMNS = 8;
export const LAUNCHER_RECENT_ROWS = 2;
export const LAUNCHER_PINNED_ROWS = 1;
export const LAUNCHER_MATCH_ROWS = 3;
export const LAUNCHER_RECENT_TILES = LAUNCHER_COLUMNS * LAUNCHER_RECENT_ROWS;
export const LAUNCHER_PINNED_TILES = LAUNCHER_COLUMNS * LAUNCHER_PINNED_ROWS;
export const LAUNCHER_MATCH_TILES = LAUNCHER_COLUMNS * LAUNCHER_MATCH_ROWS;


/** One grid cell. */
export type LauncherTile = {
  /** `plugin:<id>` or `app:<key>`. */
  id: string;
  kind: LauncherItemKind;
  name: string;
  /** Second line: how it matched, or what the plugin will receive. */
  detail: string;
  reason: LauncherMatchReason;
  monogram: string;
  iconDataUrl?: string;
  executableName?: string;
  appSource?: LauncherAppSource;
  pluginId?: string;
  trigger?: { id: string; payload: string };
};

type IndexedItem = {
  id: string;
  kind: LauncherItemKind;
  name: string;
  nameText: string;
  pinyin: string;
  initials: string;
  aliases: AliasKeys[];
  description?: string;
  descriptionText: string;
  iconDataUrl?: string;
  executableName?: string;
  appSource?: LauncherAppSource;
  pluginId?: string;
  triggers: LauncherTriggerMeta[];
  order: number;
};

/** One alias with every form the matcher compares against. */
type AliasKeys = {
  raw: string;
  text: string;
  pinyin: string;
  initials: string;
};

function aliasKeys(raw: string): AliasKeys {
  const tokens = launcherPinyinTokens(raw);
  return {
    raw,
    text: normalizeLauncherText(raw),
    pinyin: tokens.full,
    initials: tokens.initials,
  };
}

/** The first alias whose text, pinyin or initials satisfy `test`. */
function aliasHit(
  aliases: readonly AliasKeys[],
  test: (form: string) => boolean,
): AliasKeys | undefined {
  return aliases.find(
    (alias) => test(alias.text) || test(alias.pinyin) || test(alias.initials),
  );
}

/** A launchable item plus everything the matcher needs, computed once. */
export type LauncherIndex = {
  items: IndexedItem[];
  byId: Map<string, IndexedItem>;
};

function indexEntry(
  entry: LauncherPluginEntry | LauncherAppEntry,
  order: number,
  store: LauncherStoreSnapshot,
): IndexedItem {
  const aliases = (store.aliases[entry.id] ?? []).map(aliasKeys);
  const tokens = launcherPinyinTokens(entry.name);
  const triggers =
    entry.kind === "plugin"
      ? entry.triggers.filter(
          (trigger) =>
            !store.disabledTriggers.includes(
              launcherTriggerKey(entry.pluginId, trigger.id),
            ),
        )
      : [];
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    nameText: normalizeLauncherText(entry.name),
    pinyin: tokens.full,
    initials: tokens.initials,
    aliases,
    description: entry.kind === "plugin" ? entry.description : undefined,
    descriptionText: normalizeLauncherText(
      entry.kind === "plugin" ? (entry.description ?? "") : "",
    ),
    iconDataUrl: entry.kind === "app" ? entry.iconDataUrl : undefined,
    executableName: entry.kind === "app" ? entry.executableName : undefined,
    appSource: entry.kind === "app" ? entry.source : undefined,
    pluginId: entry.kind === "plugin" ? entry.pluginId : undefined,
    triggers,
    order,
  };
}

/**
 * Build the search index. Plugins the user hid from the launcher are left out
 * entirely; disabled triggers are already removed from each plugin's list.
 */
export function indexLauncherCatalog(
  catalog: LauncherCatalog,
  store: LauncherStoreSnapshot,
): LauncherIndex {
  const items: IndexedItem[] = [];
  catalog.plugins.forEach((plugin, index) => {
    if (store.disabledPlugins.includes(plugin.pluginId)) return;
    items.push(indexEntry(plugin, index, store));
  });
  catalog.apps.forEach((app, index) => {
    items.push(indexEntry(app, catalog.plugins.length + index, store));
  });
  return { items, byId: new Map(items.map((item) => [item.id, item])) };
}

function tile(
  item: IndexedItem,
  reason: LauncherMatchReason,
  detail: string,
  trigger?: { id: string; payload: string },
): LauncherTile {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    detail,
    reason,
    monogram: launcherMonogram(item.name),
    iconDataUrl: item.iconDataUrl,
    executableName: item.executableName,
    appSource: item.appSource,
    pluginId: item.pluginId,
    trigger,
  };
}

function recencyRank(store: LauncherStoreSnapshot): Map<string, number> {
  return new Map(store.recents.map((id, index) => [id, index]));
}

/** `{ tiles, total }` — `total` survives the grid cap so the panel can say how many. */
export type LauncherSection = {
  tiles: LauncherTile[];
  total: number;
};

function section(tiles: LauncherTile[], limit: number): LauncherSection {
  return { tiles: tiles.slice(0, limit), total: tiles.length };
}

function resolveIds(
  ids: readonly string[],
  index: LauncherIndex,
  reason: LauncherMatchReason,
): LauncherTile[] {
  const tiles: LauncherTile[] = [];
  for (const id of ids) {
    const item = index.byId.get(id);
    if (item) tiles.push(tile(item, reason, ""));
  }
  return tiles;
}

/** Recents section: two rows by default, with the true total reported. */
export function buildLauncherRecentSection(
  index: LauncherIndex,
  store: LauncherStoreSnapshot,
  limit: number = LAUNCHER_RECENT_TILES,
): LauncherSection {
  return section(resolveIds(store.recents, index, "recent"), limit);
}

/** Pinned section: one row by default. */
export function buildLauncherPinnedSection(
  index: LauncherIndex,
  store: LauncherStoreSnapshot,
  limit: number = LAUNCHER_PINNED_TILES,
): LauncherSection {
  return section(resolveIds(store.pins, index, "pinned"), limit);
}

const TRIGGER_PATTERN_MAX_LENGTH = 200;
const triggerCache = new Map<string, RegExp | null>();

function compileTrigger(trigger: LauncherTriggerMeta): RegExp | null {
  const key = `${trigger.flags ?? ""}/${trigger.pattern}`;
  if (triggerCache.has(key)) return triggerCache.get(key) ?? null;
  let compiled: RegExp | null = null;
  if (trigger.pattern.length <= TRIGGER_PATTERN_MAX_LENGTH) {
    try {
      compiled = new RegExp(trigger.pattern, trigger.flags);
    } catch {
      // The host validates patterns at load; a stale catalog entry is ignored
      // rather than allowed to throw on every keystroke.
      compiled = null;
    }
  }
  if (triggerCache.size > 512) triggerCache.clear();
  triggerCache.set(key, compiled);
  return compiled;
}

/**
 * Whole-input trigger match.
 *
 * The whole trimmed input must match — `includes` semantics would let a single
 * `1` summon every arithmetic plugin. Input longer than
 * `LAUNCHER_TRIGGER_INPUT_MAX_LENGTH` is never matched, so a pasted wall of text
 * costs one length check instead of a regex run.
 */
export function matchLauncherTrigger(
  trigger: LauncherTriggerMeta,
  input: string,
): string | null {
  if (!input || input.length > LAUNCHER_TRIGGER_INPUT_MAX_LENGTH) return null;
  const compiled = compileTrigger(trigger);
  if (!compiled) return null;
  const match = compiled.exec(input);
  if (!match || match[0] !== input) return null;
  return input;
}

type Scored = {
  item: IndexedItem;
  score: number;
  reason: LauncherMatchReason;
  detail: string;
  trigger?: { id: string; payload: string };
};

function queryTrimmed(query: string): string {
  return query.trim();
}

/**
 * The hit view: at most `LAUNCHER_MATCH_TILES` tiles, plus the number of matches
 * the grid had to drop so the footer can ask the user to keep typing.
 */
export function searchLauncherItems(
  index: LauncherIndex,
  query: string,
  store: LauncherStoreSnapshot,
): LauncherSection {
  const trimmed = queryTrimmed(query);
  if (!trimmed) return { tiles: [], total: 0 };
  const normalized = normalizeLauncherText(trimmed);
  const rank = recencyRank(store);
  const scored: Scored[] = [];
  for (const item of index.items) {
    const hit = scoreItemNormalized(item, normalized, trimmed);
    if (hit) scored.push(hit);
  }
  scored.sort(
    (left, right) =>
      left.score - right.score ||
      (rank.get(left.item.id) ?? rank.size) - (rank.get(right.item.id) ?? rank.size) ||
      kindRank(left.item.kind) - kindRank(right.item.kind) ||
      left.item.name.localeCompare(right.item.name) ||
      left.item.order - right.item.order,
  );
  return section(
    scored.map((hit) => tile(hit.item, hit.reason, hit.detail, hit.trigger)),
    LAUNCHER_MATCH_TILES,
  );
}

function kindRank(kind: LauncherItemKind): number {
  return kind === "plugin" ? 0 : 1;
}

function scoreItemNormalized(
  item: IndexedItem,
  normalized: string,
  raw: string,
): Scored | null {
  // Triggers compare against the raw input (a pattern may care about spaces or
  // case), name matching compares against the folded form.
  for (const trigger of item.triggers) {
    const payload = matchLauncherTrigger(trigger, raw);
    if (payload) {
      return {
        item,
        score: 0,
        reason: "pattern",
        detail: payload,
        trigger: { id: trigger.id, payload },
      };
    }
  }
  if (!normalized) return null;
  return scoreByName(item, normalized);
}

function scoreByName(item: IndexedItem, query: string): Scored | null {
  if (item.nameText === query) {
    return { item, score: 1, reason: "name", detail: item.name };
  }
  const exactAlias = aliasHit(item.aliases, (form) => form === query);
  if (exactAlias) {
    return { item, score: 2, reason: "alias", detail: exactAlias.raw };
  }
  if (item.nameText.startsWith(query)) {
    return { item, score: 3, reason: "name", detail: item.name };
  }
  const prefixAlias = aliasHit(item.aliases, (form) => form.startsWith(query));
  if (prefixAlias) {
    return { item, score: 3, reason: "alias", detail: prefixAlias.raw };
  }
  if (item.pinyin.startsWith(query)) {
    return { item, score: 4, reason: "pinyin", detail: item.pinyin };
  }
  if (item.initials.startsWith(query)) {
    return { item, score: 5, reason: "initials", detail: item.initials };
  }
  if (item.nameText.includes(query)) {
    return { item, score: 6, reason: "name", detail: item.name };
  }
  if (item.pinyin.includes(query)) {
    return { item, score: 7, reason: "pinyin", detail: item.pinyin };
  }
  if (item.initials.includes(query)) {
    return { item, score: 7, reason: "initials", detail: item.initials };
  }
  const partialAlias = aliasHit(item.aliases, (form) => form.includes(query));
  if (partialAlias) {
    return { item, score: 8, reason: "alias", detail: partialAlias.raw };
  }
  if (item.descriptionText.includes(query)) {
    return {
      item,
      score: 9,
      reason: "description",
      detail: item.description ?? "",
    };
  }
  return null;
}
