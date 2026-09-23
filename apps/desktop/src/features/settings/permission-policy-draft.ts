/** Adopt a changed saved policy only when the editor still matches the previous saved value. */
export function syncPermissionPolicyDraft(current: string, previousSaved: string, nextSaved: string): string {
  return current === previousSaved ? nextSaved : current;
}
