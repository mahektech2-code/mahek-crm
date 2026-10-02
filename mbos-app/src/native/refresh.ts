import { syncNow } from '../sync/engine';
import { checkForUpdate } from './update-check';
import { downloadUpdate, fetchUpdateInBackground } from './updates';
import { useStore } from '../state/store';
import { refreshVerdict, updateOffer, type RefreshVerdict } from '../engines/refresh';

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
 * THE SAME QUESTION, ASKED WITHOUT A PRESS — at launch, and on a resume after a
 * long absence, which is where `boot.tsx` already looked for an OTA.
 *
 * It used to fetch the bundle and then say nothing: the bundle waited for a
 * cold start that a phone kept alive by the location service might not have
 * for days. Now a waiting bundle, or a newer APK, puts the Update now / Update
 * later modal up. `applied` is the cold-start case where the bundle is already
 * being reloaded onto, so there is nothing to offer.
 */
export async function offerAnyUpdate(): Promise<void> {
  const [ota, apk] = await Promise.all([
    fetchUpdateInBackground().catch(() => 'failed' as const),
    checkForUpdate().catch(() => ({ kind: 'current' as const })),
  ]);
  if (ota === 'applied') return;
  const offer = updateOffer(ota, apk);
  if (offer) useStore.getState().offerUpdate(offer);
}
