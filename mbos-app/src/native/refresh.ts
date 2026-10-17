import { syncNow } from '../sync/engine';
import { checkForUpdate } from './update-check';
import { downloadUpdate, fetchUpdateInBackground } from './updates';
import { refreshVerdict, type RefreshVerdict } from '../engines/refresh';

/**
 * THE REFRESH BUTTON, wired: the three questions asked side by side.
 *
 * Side by side because none of them depends on another, and a salesman on 2G
 * waits for the slowest rather than the sum. None of them can throw — `syncNow`
 * answers why it did not run, the update checks answer `failed`/`current` — and
 * the `catch` arms below exist only so that stays true if one of them changes.
 * What to do with the answers is `engines/refresh.ts`.
 */
export async function refreshEverything(): Promise<RefreshVerdict> {
  const [sync, ota, apk] = await Promise.all([
    syncNow({ manual: true }).catch(() => ({
      ran: false,
      pushed: 0,
      accepted: 0,
      rejected: 0,
      pulled: 0,
      reason: 'Could not refresh now. Try again in a minute.',
    })),
    downloadUpdate().catch(() => 'failed' as const),
    checkForUpdate().catch(() => ({ kind: 'current' as const })),
  ]);
  return refreshVerdict({ sync, ota, apk });
}

/**
 * WITHOUT A PRESS — at launch, and on a resume after a long absence — an
 * over-the-air bundle is fetched and NOTHING is put on the screen.
 *
 * It used to raise the Update now / Update later modal from here too, and Mahek
 * asked for the opposite: the prompt belongs to the reload button, pressed by
 * somebody who has a moment, and never to an automatic sync that lands on him
 * mid-order. So a waiting bundle simply applies on the next cold start (or at
 * once, if it lands within seconds of the launch), and a newer APK is offered
 * when he presses reload or opens the Sync screen.
 */
export async function fetchUpdateQuietly(): Promise<void> {
  await fetchUpdateInBackground().catch(() => 'failed' as const);
}
