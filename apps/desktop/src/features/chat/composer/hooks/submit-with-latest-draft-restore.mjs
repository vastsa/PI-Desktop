const latestSubmissions = new Map();

/**
 * Restore a rejected draft only while its submission still owns that draft
 * slot. The unique token prevents older in-flight submissions from regaining
 * ownership after a newer submission has settled.
 *
 * @param {string} draftKey
 * @param {() => Promise<boolean>} submit
 * @param {() => void} restoreDraft
 * @returns {Promise<boolean>}
 */
export async function submitWithLatestDraftRestore(draftKey, submit, restoreDraft) {
  const token = Symbol();
  latestSubmissions.set(draftKey, token);
  try {
    const accepted = await submit();
    if (!accepted && latestSubmissions.get(draftKey) === token) restoreDraft();
    return accepted;
  } finally {
    if (latestSubmissions.get(draftKey) === token) latestSubmissions.delete(draftKey);
  }
}
