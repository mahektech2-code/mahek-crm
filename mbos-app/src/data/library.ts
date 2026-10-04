import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { deleteAsync, documentDirectory, downloadAsync, getContentUriAsync, getInfoAsync } from 'expo-file-system/legacy';
import { all, run } from '../db';
import { accessToken, BASE, deviceId, versionHeader } from '../sync/api';

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
 * A library is opened to find one paper he already knows the name of, so the
 * order never moves: anything carrying an expiry first, then alphabetical.
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

/* ------------------------------------------------------------ the file */

/**
 * The file a row holds, if it is the CURRENT one.
 *
 * The download is named after the attachment it came from, so a document the
 * office replaced (a new price list under the same row) reads as not
 * downloaded rather than opening last month's rates.
 */
export function heldFile(d: Pick<DocumentRow, 'localUri' | 'remoteRef'>): string | null {
  const uri = d.localUri?.trim();
  if (!uri || !d.remoteRef) return null;
  return uri.includes(fileStem(d.remoteRef)) ? uri : null;
}

function fileStem(remoteRef: string): string {
  return 'mbos-doc-' + remoteRef.replace(/[^A-Za-z0-9_-]/g, '');
}

export type DownloadAnswer = { ok: true; uri: string } | { ok: false; reason: string };

/**
 * DOWNLOAD ONCE, OPEN WITHOUT SIGNAL.
 *
 * The bytes come from `/api/mbos/documents/[id]` with this handset's own
 * token, and land in the app's document directory — not the cache, which
 * Android empties when storage runs low, and an emptied price list is exactly
 * the one he reaches for in a shop with no signal.
 */
export async function downloadDocument(d: DocumentRow): Promise<DownloadAnswer> {
  if (!d.remoteRef) return { ok: false, reason: 'The office has not attached a file to this yet.' };
  if (!documentDirectory) return { ok: false, reason: 'This phone has nowhere to keep the file.' };
  const token = await accessToken();
  if (!token) return { ok: false, reason: 'Sign in again to download this.' };

  const target = documentDirectory + fileStem(d.remoteRef);
  try {
    const done = await downloadAsync(`${BASE}/api/mbos/documents/${encodeURIComponent(d.id)}`, target, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-mbos-device': await deviceId(),
        'x-mbos-app-version': versionHeader(),
      },
    });
    if (done.status !== 200) {
      await deleteAsync(target, { idempotent: true });
      if (done.status === 401) return { ok: false, reason: 'Your sign-in needs refreshing. Open Send to office, press Send now, then try again.' };
      if (done.status === 404) return { ok: false, reason: 'This document is not available to you any more.' };
      if (done.status === 410) return { ok: false, reason: 'The office has taken this file down.' };
      return { ok: false, reason: 'The file could not be downloaded. Try again.' };
    }
    /* The previous version of this row, if there was one, is not kept. */
    if (d.localUri && d.localUri !== target) await deleteAsync(d.localUri, { idempotent: true });
    await run('UPDATE documents SET localUri = ?, availableOffline = 1 WHERE id = ?', [target, d.id]);
    return { ok: true, uri: target };
  } catch {
    await deleteAsync(target, { idempotent: true }).catch(() => undefined);
    return { ok: false, reason: 'No signal. Download it when you are back online.' };
  }
}

/** Android's flag for "the viewer may read this content URI". */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Hand a downloaded file to whatever on the phone reads it.
 *
 * A `file://` path cannot be given to another app on Android — the system
 * refuses it outright — so it goes over as a content URI with read permission,
 * the same way the update installer is handed its APK.
 */
export async function openDocumentFile(uri: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const info = await getInfoAsync(uri);
    if (!info.exists) return { ok: false, reason: 'The file is no longer on this phone. Download it again.' };
    if (Platform.OS !== 'android') return { ok: false, reason: 'Opening files is only on Android.' };
    const contentUri = await getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'This phone has no app that opens this file.' };
  }
}

/** Forget a file that is no longer on the phone, so the row says so. */
export async function forgetDocumentFile(id: string): Promise<void> {
  await run('UPDATE documents SET localUri = NULL, availableOffline = 0 WHERE id = ?', [id]);
}
