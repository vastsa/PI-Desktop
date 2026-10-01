/** Preserve legacy session-wide calls while rejecting stale explicit targets. */
export function matchesExpectedTurnId(
  activeTurnId: string | undefined,
  expectedTurnId: string | undefined,
): boolean {
  return expectedTurnId === undefined || expectedTurnId.length === 0 || activeTurnId === expectedTurnId;
}
