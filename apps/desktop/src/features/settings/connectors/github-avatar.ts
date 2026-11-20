/**
 * Which avatar address the GitHub card may load (ADR github-connector).
 *
 * The address comes from the stored credential record, not from a live
 * answer. Loading whatever it names would let a planted or damaged record
 * make Settings fetch an arbitrary URL each time the page opens. GitHub
 * serves every account avatar from one host, so only that host is loaded.
 */
const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";

/** The address to load, or null when the card should show its placeholder. */
export function githubAvatarSource(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== GITHUB_AVATAR_HOST || parsed.port !== "") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return url;
}
