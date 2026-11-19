import {
  announcementLocaleCandidates,
  type AnnouncementSchedule,
} from "../app-overlay-model";

/**
 * The release announcement, filled per release (see ./README.md).
 *
 * `null` keeps the announcement off — the normal state. Set it only when a
 * release carries a change users must hear about in plain words; the id is
 * that release's version, and the matching `content/<id>/<locale>.md` files
 * must exist (English is required). Each id is shown at most once.
 */
export const RELEASE_ANNOUNCEMENT: AnnouncementSchedule | null = null;

// Markdown is loaded on demand; image assets resolve to bundled URLs.
const documents = import.meta.glob<string>("./content/*/*.md", {
  query: "?raw",
  import: "default",
});
const assets = import.meta.glob<string>("./content/*/assets/*", {
  query: "?url",
  import: "default",
  eager: true,
});

function documentKey(id: string, locale: string): string {
  return `./content/${id}/${locale}.md`;
}

/** Whether the announcement ships at least its English text. */
export function hasAnnouncementContent(id: string): boolean {
  return documentKey(id, "en") in documents;
}

export type AnnouncementContent = {
  markdown: string;
  /** Map a Markdown image reference to a bundled asset; anything else is dropped. */
  resolveImage: (src: string) => string | null;
};

export async function loadAnnouncementContent(
  id: string,
  language: string | undefined,
): Promise<AnnouncementContent | null> {
  const locale = announcementLocaleCandidates(language).find(
    (candidate) => documentKey(id, candidate) in documents,
  );
  if (!locale) return null;
  const markdown = await documents[documentKey(id, locale)]();
  return {
    markdown,
    resolveImage: (src) => {
      const relative = src.replace(/^\.\//, "");
      if (!/^assets\/[^/]+$/.test(relative)) return null;
      return assets[`./content/${id}/${relative}`] ?? null;
    },
  };
}
