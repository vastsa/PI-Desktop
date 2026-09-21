export function resolveReleaseDocumentCheck(currentVersion, requestedVersion) {
  const documentVersion = requestedVersion ?? currentVersion;
  const isPrereleasePreview =
    requestedVersion !== undefined &&
    currentVersion !== documentVersion &&
    currentVersion.startsWith(`${documentVersion}-`);

  return {
    documentVersion,
    surfaceVersion: isPrereleasePreview ? currentVersion : documentVersion,
    isPrereleasePreview,
  };
}
