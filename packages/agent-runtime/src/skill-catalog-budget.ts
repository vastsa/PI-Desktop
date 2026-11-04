/**
 * What the skill catalog costs, and when that cost stops being free.
 *
 * Every skill is listed in the system prompt — name plus description, every
 * turn, for the life of the session. That is the right trade while the library
 * is small: the model can only reach for a skill it knows exists. It stops being
 * free at scale: measured on a real library, one entry is ~123 characters, so 50
 * skills is ~1.8k tokens per turn and 200 skills is ~7k, before a single tool
 * call. Nothing else in the app would ever say so.
 *
 * The gate reports; it never trims. A skill that is silently dropped from the
 * catalog is worse than an expensive one, because the model cannot ask for what
 * it cannot see.
 */

/** Measured against a real library: ~123 chars per entry at typical lengths. */
export const SKILL_CATALOG_BUDGET_CHARS = 8_000;

export type SkillBudgetEntry = {
  name: string;
  description?: string | null;
};

/** Characters this entry adds to the prompt, including its list separator. */
function entryChars(entry: SkillBudgetEntry): number {
  return entry.name.length + (entry.description?.length ?? 0) + 6;
}

export function skillCatalogChars(entries: readonly SkillBudgetEntry[]): number {
  return entries.reduce((total, entry) => total + entryChars(entry), 0);
}

export type SkillCatalogBudget = {
  chars: number;
  limit: number;
  skills: number;
  over: boolean;
};

export function skillCatalogBudget(
  entries: readonly SkillBudgetEntry[],
  limit: number = SKILL_CATALOG_BUDGET_CHARS,
): SkillCatalogBudget {
  const chars = skillCatalogChars(entries);
  return { chars, limit, skills: entries.length, over: chars > limit };
}
