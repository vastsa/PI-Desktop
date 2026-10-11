/**
 * Session references: what the composer's `@` session mentions may attach
 * (Settings › AI › Session references). The host owns both preferences and
 * hands them to `composerTrigger` providers on every query
 * (`PluginTriggerQuery.sessionReferences`); the bundled `pi.session-mentions`
 * plugin builds its references from them.
 *
 * Absent or unrecognised stored values read as the defaults, so no migration
 * is needed.
 */

/** Share of the current chat's remaining context one reference may use. */
export const SESSION_REFERENCE_BUDGET_PERCENTS = [10, 25, 50, 100] as const;
export type SessionReferenceBudgetPercent =
  (typeof SESSION_REFERENCE_BUDGET_PERCENTS)[number];
export const DEFAULT_SESSION_REFERENCE_BUDGET_PERCENT: SessionReferenceBudgetPercent = 25;

/** Complete Q&A turns one reference may hold, the session's first turn included. */
export const SESSION_REFERENCE_MAX_TURNS_CHOICES = [3, 5, 10, 20] as const;
export type SessionReferenceMaxTurns =
  (typeof SESSION_REFERENCE_MAX_TURNS_CHOICES)[number];
export const DEFAULT_SESSION_REFERENCE_MAX_TURNS: SessionReferenceMaxTurns = 10;

export type SessionReferenceSettings = {
  readonly budgetPercent: SessionReferenceBudgetPercent;
  readonly maxTurns: SessionReferenceMaxTurns;
};

export function resolveSessionReferenceBudgetPercent(
  value: unknown,
): SessionReferenceBudgetPercent {
  return (SESSION_REFERENCE_BUDGET_PERCENTS as readonly unknown[]).includes(value)
    ? (value as SessionReferenceBudgetPercent)
    : DEFAULT_SESSION_REFERENCE_BUDGET_PERCENT;
}

export function resolveSessionReferenceMaxTurns(
  value: unknown,
): SessionReferenceMaxTurns {
  return (SESSION_REFERENCE_MAX_TURNS_CHOICES as readonly unknown[]).includes(value)
    ? (value as SessionReferenceMaxTurns)
    : DEFAULT_SESSION_REFERENCE_MAX_TURNS;
}

/** Both preferences as the app uses them, defaults filled in. */
export function resolveSessionReferenceSettings(
  settings:
    | {
        readonly sessionReferenceBudgetPercent?: unknown;
        readonly sessionReferenceMaxTurns?: unknown;
      }
    | null
    | undefined,
): SessionReferenceSettings {
  return {
    budgetPercent: resolveSessionReferenceBudgetPercent(
      settings?.sessionReferenceBudgetPercent,
    ),
    maxTurns: resolveSessionReferenceMaxTurns(settings?.sessionReferenceMaxTurns),
  };
}
