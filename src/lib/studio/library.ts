/* ---------------------------------------------------------------------------
 * THE SHARED TEMPLATE LIBRARY, as a pure list and a pure filter.
 *
 * Every approved design is in it — the ones shipped with the app and the ones
 * somebody uploaded and published — and what a person can narrow it by is what
 * is on each tile: its name, the occasion it is listed under, the languages it
 * is made in and who uploaded it. Built-in designs have no uploader and are
 * filed under BUILT_IN.
 *
 * No database and no framework in here, so the filter is tested on its own.
 * ------------------------------------------------------------------------- */

export const BUILT_IN = "built-in";

export type LibraryItem = {
  id: string;
  version: string;
  name: string;
  description: string;
  occasion: string;
  occasionLabel: string;
  occasionColor: string | null;
  languages: { code: string; label: string }[];
  preview: string;
  /** Uploaded by somebody here, rather than shipped with the app. */
  custom: boolean;
  /** Who uploaded it; null for a design shipped with the app. */
  uploaderId: string | null;
  uploaderName: string | null;
  archived: boolean;
};

export type LibraryFilter = { q?: string | null | undefined; occasion?: string | null | undefined; language?: string | null | undefined; uploader?: string | null | undefined };

const norm = (s: string) => s.normalize("NFC").toLowerCase().trim();

/** The items that match every filter given. An empty filter is the whole list, in the order it came. */
export function filterLibrary<T extends LibraryItem>(items: readonly T[], f: LibraryFilter): T[] {
  const q = norm(f.q ?? "");
  const words = q ? q.split(/\s+/) : [];
  return items.filter((d) => {
    if (f.occasion && d.occasion !== f.occasion) return false;
    if (f.language && !d.languages.some((l) => l.code === f.language)) return false;
    if (f.uploader) {
      if (f.uploader === BUILT_IN ? d.uploaderId !== null : d.uploaderId !== f.uploader) return false;
    }
    if (words.length) {
      const hay = norm(`${d.name} ${d.description} ${d.occasionLabel} ${d.uploaderName ?? "mahek built-in"}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** The values the filter boxes offer: only what the list actually has, each once. */
export function libraryFacets(items: readonly LibraryItem[]) {
  const occasions = new Map<string, string>();
  const languages = new Map<string, string>();
  const uploaders = new Map<string, string>();
  for (const d of items) {
    occasions.set(d.occasion, d.occasionLabel);
    for (const l of d.languages) languages.set(l.code, l.label);
    uploaders.set(d.uploaderId ?? BUILT_IN, d.uploaderName ?? "Built in");
  }
  const list = (m: Map<string, string>) => [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  return { occasions: list(occasions), languages: list(languages), uploaders: list(uploaders) };
}
