import * as ImageManipulator from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { all, newId, run } from '../db';
import { getConfig } from '../data/config';
import * as api from './api';
import { backoffFor, MAX_ATTEMPTS } from './queue';

/**
 * Photographs and audio.
 *
 * Kept in a queue of their own, and that separation is the point: a shop photo
 * is three hundred times the size of the payment record beside it, and on a
 * bad connection one upload can hold up everything behind it. Records go
 * first, always; media follows and is allowed to take as long as it takes.
 */

export type MediaKind = 'shop_photo' | 'customer_photo' | 'cheque_photo' | 'bill_photo' | 'selfie' | 'sample_proof' | 'deposit_proof' | 'task_proof' | 'voice_note';

/**
 * How big the file is, for the queue's own reporting.
 *
 * A size we cannot read is recorded as zero rather than throwing. The bytes
 * still upload; only the "840 KB" on the sync screen is poorer for it, and
 * losing a photograph to a failed stat call would be the wrong trade.
 */
function byteSize(uri: string): number {
  try {
    const file = new File(uri);
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Compress on capture, before queuing — not at upload time.
 *
 * A 4 MB photograph that sits in the queue for six hours is 4 MB of the
 * handset's storage and 4 MB the salesman eventually pays for over mobile
 * data. Both dimensions and quality are configuration, because what is
 * legible for a damaged drum is not what is legible for a cheque.
 */
export async function captureImage(args: {
  uri: string;
  parentType: string;
  parentId: string;
  kind: MediaKind;
}): Promise<string> {
  const maxDim = await getConfig<number>('mbos.sync.imageMaxDimensionPx', 1600);
  /* The setting is a percent, because that is what a person setting it means.
     `compress` wants 0-1, and the conversion happens here rather than in the
     Admin Console — a 70 that silently became fully lossless would look like a
     working setting right up until somebody checked a file size. */
  const qualityPercent = await getConfig<number>('mbos.sync.imageQualityPercent', 70);
  const quality = Math.min(1, Math.max(0.01, qualityPercent / 100));

  const result = await ImageManipulator.manipulateAsync(
    args.uri,
    [{ resize: { width: maxDim } }],
    { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
  );

  const id = newId('media');

  await run(
    `INSERT INTO media_queue (id, parentType, parentId, kind, localUri, mimeType, bytes, state, nextAttemptAt, createdAt)
     VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, 'queued', 0, ?)`,
    [id, args.parentType, args.parentId, args.kind, result.uri, byteSize(result.uri), Date.now()],
  );
  return id;
}

/** Audio is queued as-is; re-encoding speech to save bytes loses the words. */
export async function queueAudio(args: { uri: string; parentType: string; parentId: string }): Promise<string> {
  const id = newId('media');
  await run(
    `INSERT INTO media_queue (id, parentType, parentId, kind, localUri, mimeType, bytes, state, nextAttemptAt, transcriptionState, createdAt)
     VALUES (?, ?, ?, 'voice_note', ?, 'audio/m4a', ?, 'queued', 0, 'pending', ?)`,
    [id, args.parentType, args.parentId, args.uri, byteSize(args.uri), Date.now()],
  );
  return id;
}

type MediaRow = {
  id: string; parentType: string; parentId: string; kind: string;
  localUri: string; mimeType: string; attempts: number; transcriptionState: string | null;
};

/**
 * Upload what is ready.
 *
 * Wi-Fi-only is a setting that applies to MEDIA and never to records — the
 * brief is explicit. A salesman who has asked to save data still needs his
 * payment to reach the office; what waits for Wi-Fi is the photograph of the
 * cheque, not the fact that the cheque exists.
 */
export async function runMediaQueue(): Promise<{ uploaded: number; failed: number }> {
  const wifiOnly = await getConfig<boolean>('mbos.sync.mediaWifiOnly', false);
  if (wifiOnly) {
    const NetInfo = (await import('@react-native-community/netinfo')).default;
    const state = await NetInfo.fetch();
    if (state.type !== 'wifi') return { uploaded: 0, failed: 0 };
  }

  const now = Date.now();
  const rows = await all<MediaRow>(
    `SELECT * FROM media_queue WHERE state = 'queued' AND nextAttemptAt <= ? ORDER BY createdAt ASC LIMIT 5`,
    [now],
  );

  let uploaded = 0;
  let failed = 0;

  for (const row of rows) {
    await run(`UPDATE media_queue SET state = 'syncing' WHERE id = ?`, [row.id]);
    try {
      const { remoteRef } = await api.uploadMedia({
        clientId: row.id,
        parentType: row.parentType,
        parentId: row.parentId,
        kind: row.kind,
        uri: row.localUri,
        mimeType: row.mimeType,
      });
      await run(`UPDATE media_queue SET state = 'synced', remoteRef = ? WHERE id = ?`, [remoteRef, row.id]);
      uploaded += 1;
      await afterUpload(row);
    } catch (e) {
      const attempts = row.attempts + 1;
      const reason = e instanceof Error ? e.message : 'Upload failed';
      if (attempts >= MAX_ATTEMPTS) {
        await run(`UPDATE media_queue SET state = 'failed', attempts = ?, failureReason = ? WHERE id = ?`, [attempts, reason, row.id]);
        failed += 1;
      } else {
        await run(`UPDATE media_queue SET state = 'queued', attempts = ?, nextAttemptAt = ?, failureReason = ? WHERE id = ?`,
          [attempts, backoffFor(attempts, now), reason, row.id]);
      }
    }
  }

  return { uploaded, failed };
}

/**
 * Audio is deleted from the handset only once its transcription is confirmed
 * stored — never merely because the upload succeeded.
 *
 * A recording of what a customer actually said is the only copy of it. Losing
 * it to save a few megabytes, before anything has confirmed the words survived
 * the trip, is not a trade worth making.
 */
async function afterUpload(row: MediaRow): Promise<void> {
  if (row.kind !== 'voice_note') {
    await maybeDeleteLocal(row);
    return;
  }
  /* The server confirms transcription on a later pull; until it does, the
     audio stays exactly where it is. */
  await run(`UPDATE media_queue SET transcriptionState = 'uploaded' WHERE id = ?`, [row.id]);
}

/** Called when a pull confirms the transcript is stored server-side. */
export async function confirmTranscription(mediaId: string, transcript: string): Promise<void> {
  const rows = await all<MediaRow>('SELECT * FROM media_queue WHERE id = ?', [mediaId]);
  const row = rows[0];
  if (!row) return;

  await run('UPDATE visits SET transcript = ?, transcriptIsAi = 1 WHERE voiceNoteId = ?', [transcript, mediaId]);
  await run(`UPDATE media_queue SET transcriptionState = 'confirmed' WHERE id = ?`, [mediaId]);

  const keep = await getConfig<boolean>('mbos.ai.retainAudioAfterTranscription', false);
  if (!keep) await maybeDeleteLocal(row);
}

async function maybeDeleteLocal(row: MediaRow): Promise<void> {
  try {
    const file = new File(row.localUri);
    if (file.exists) file.delete();
  } catch {
    /* A file that will not delete is a tidy-up problem, never a data problem.
       The bytes are already on the server; leaving them here costs storage
       and nothing else. */
  }
}

export async function mediaCounts(): Promise<{ pending: number; failed: number }> {
  const rows = await all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM media_queue GROUP BY state');
  const map = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  return { pending: (map.queued ?? 0) + (map.syncing ?? 0), failed: map.failed ?? 0 };
}
