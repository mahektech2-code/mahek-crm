import { all } from '../db';

/**
 * The document library and the training centre, read from the local store.
 *
 * Both of these screens rendered a hardcoded list for as long as they have
 * existed, with a grey line underneath admitting it was not live — which is a
 * footnote under five plausible rows, and a footnote is not what somebody
 * reads. The pull has carried `documents` and `courses` since the office was
 * given a way to publish them, and `sync/pull.ts` has been writing both tables
 * the whole time. Nothing was missing except a read.
 *
 * So there is no placeholder here and no fallback: what the office published
 * is what the screen shows, and where it has published nothing the screen says
 * that instead of inventing a price list.
 */

export type DocumentRow = {
  id: string;
  title: string;
  category: string | null;
  kind: string | null;
  sizeLabel: string | null;
  remoteRef: string | null;
  localUri: string | null;
  availableOffline: number;
  expiresOn: string | null;
};

export type CourseRow = {
  id: string;
  title: string;
  category: string | null;
  kind: string | null;
  minutes: number | null;
  mandatory: number;
  deadline: string | null;
  completedAt: number | null;
  quizScore: number | null;
};

/**
 * Newest-looking first is wrong for a library — a salesman opens it to find
 * one paper he already knows the name of. Compulsory reading first, then
 * alphabetical, so the same document is always in the same place.
 */
export async function listDocuments(): Promise<DocumentRow[]> {
  return all<DocumentRow>(
    `SELECT id, title, category, kind, sizeLabel, remoteRef, localUri,
            availableOffline, expiresOn
       FROM documents
      ORDER BY (expiresOn IS NOT NULL) DESC, title COLLATE NOCASE ASC`,
  );
}

/** Due first, then unfinished, then what is already done. */
export async function listCourses(): Promise<CourseRow[]> {
  return all<CourseRow>(
    `SELECT id, title, category, kind, minutes, mandatory, deadline,
            completedAt, quizScore
       FROM courses
      ORDER BY (completedAt IS NOT NULL) ASC, mandatory DESC, title COLLATE NOCASE ASC`,
  );
}
