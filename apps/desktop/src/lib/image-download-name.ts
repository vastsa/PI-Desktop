// A scheme of two or more letters, so a Windows drive (`C:\`) stays a path.
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * File name to save an image under, derived from the path or URL it was shown
 * from. For a URL the query and fragment are not part of the name and an
 * encoded name is decoded, matching what a browser would save. A local path
 * keeps its last segment verbatim: `#` and `%` are legal in file names there.
 */
export function imageDownloadName(reference: string): string {
  return lastSegment(URL_SCHEME.test(reference) ? urlPathName(reference) : reference) || "image";
}

function urlPathName(reference: string): string {
  let pathname: string;
  try {
    pathname = new URL(reference).pathname;
  } catch {
    pathname = reference.replace(/[?#].*$/s, "");
  }
  const encoded = lastSegment(pathname);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}
