/**
 * WHAT THE REFRESH BUTTON SAYS, once the three things it asked have answered.
 *
 * The button in the top bar does three jobs at once, because a salesman who
 * presses "refresh" means all of them and cannot be expected to know they are
 * three: send what is waiting and pull what the office changed, fetch a new
 * over-the-air bundle if there is one, and ask whether a newer APK has been
 * published. They used to live on three different occasions — a sync every
 * minute, an update check on a COLD start only, and an APK card on the Sync
 * screen nobody opens unprompted — and a phone kept alive all day by the
 * location service never had a cold start, so a fix shipped over the air sat
 * undelivered for days on exactly the handsets that were working hardest.
 *
 * Pure, like every engine here, so the order of precedence below can be
 * tested without a handset.
 *
 * ONE OFFER, never two sheets. In order:
 *
 *   1. A newer APK. Native changes cannot arrive any other way, and an OTA
 *      for this build is at best a stopgap beside it — so this is the one to
 *      put in front of him.
 *   2. A bundle downloaded and waiting. Offered as a restart he chooses, never
 *      done under him: he may be half-way through an order.
 *   3. Neither: a toast saying what the sync did, so the press visibly did
 *      something.
 */

export type RefreshSync = {
  ran: boolean;
  pushed: number;
  accepted: number;
  rejected: number;
  pulled: number;
  reason?: string;
};

export type RefreshOta = 'none' | 'ready' | 'off' | 'failed';

export type RefreshApk = { kind: 'current' } | { kind: 'available'; version: string; url: string };

/** What the update modal offers. Restart is an OTA already on the phone. */
export type UpdateOffer = { kind: 'install'; version: string; url: string } | { kind: 'restart' };

export type RefreshVerdict = { offer: UpdateOffer | null; summary: string };

/** One line about the data half, whatever else happens. */
export function syncSummary(sync: RefreshSync): string {
  if (!sync.ran) return sync.reason ?? 'Could not refresh now. Try again in a minute.';
  if (sync.rejected > 0) {
    return `${sync.rejected} ${sync.rejected === 1 ? 'entry was' : 'entries were'} not accepted by the office`;
  }
  if (sync.accepted > 0) {
    return `${sync.accepted} ${sync.accepted === 1 ? 'entry' : 'entries'} sent, and the latest from the office is on your phone`;
  }
  if (sync.pushed > 0) return sync.reason ?? 'Some entries could not be sent yet. They will try again.';
  return 'Up to date with the office';
}

/**
 * The one offer, if any. Shared by the refresh button and the automatic check
 * at launch, so the two cannot disagree about which update to put in front of
 * him.
 */
export function updateOffer(ota: RefreshOta, apk: RefreshApk): UpdateOffer | null {
  if (apk.kind === 'available') return { kind: 'install', version: apk.version, url: apk.url };
  if (ota === 'ready') return { kind: 'restart' };
  return null;
}

export function refreshVerdict(input: { sync: RefreshSync; ota: RefreshOta; apk: RefreshApk }): RefreshVerdict {
  return { offer: updateOffer(input.ota, input.apk), summary: syncSummary(input.sync) };
}
