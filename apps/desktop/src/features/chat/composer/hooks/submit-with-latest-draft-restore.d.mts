export function submitWithLatestDraftRestore(
  draftKey: string,
  submit: () => Promise<boolean>,
  restoreDraft: () => void,
): Promise<boolean>;
