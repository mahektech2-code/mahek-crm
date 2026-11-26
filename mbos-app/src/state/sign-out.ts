import React from 'react';
import { router } from 'expo-router';
import { useStore } from './store';
import { useBoot } from './boot';
import { signOut as signOutReal } from '../data/session';
import { pendingCount } from '../sync/queue';
import { dayState } from '../data/attendance';
import { plural } from '../lib/format';

async function routePointsWaiting(): Promise<number> {
  const trail = await import('../sync/trail');
  let native = 0;
  try {
    const service = await import('../native/location-service');
    const state = await service.serviceState();
    native = state.buffered ?? 0;
  } catch {
    native = 0;
  }
  return (await trail.pending()) + native;
}

/**
 * SIGNING OUT ASKS FIRST, from wherever it is offered.
 *
 * There were two copies. Profile asked and said how many entries were still
 * waiting; More signed out on one tap of a menu row that looks like every
 * other row on that screen. A stray thumb there signed somebody out in a lane
 * with no signal — and getting back in needs signal the first time — so one
 * tap could cost the rest of a working day. Both now come through here.
 *
 * It also says the thing that matters most and was never said: if he is still
 * punched in, signing out stops his route being recorded for the rest of the
 * day. That is right for somebody handing the phone back; it is a surprise for
 * somebody who only wanted to sign in again.
 */
export function useSignOut(): () => void {
  const askConfirm = useStore((s) => s.askConfirm);
  const notify = useStore((s) => s.notify);
  const forget = useStore((s) => s.signOut);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? '';

  return React.useCallback(() => {
    void (async () => {
      const [waiting, day, points] = await Promise.all([
        pendingCount().catch(() => 0),
        userId ? dayState(userId).catch(() => null) : Promise.resolve(null),
        /* The route still to go up — the native buffer and the queue. Kept for
           him, but only HE gets them back: said, so a phone handed over with
           an unsent afternoon is a choice and not a surprise. */
        routePointsWaiting().catch(() => 0),
      ]);
      const lines: string[] = [];
      if (day?.running) {
        lines.push('You are still punched in. Signing out stops your route being recorded. Punch out first if your day is over.');
      }
      lines.push(
        waiting
          ? `${plural(waiting, 'entry', 'entries')} not sent yet. They stay on this phone and send when you sign in again. Nobody else can sign in on this phone until they have gone.`
          : 'Everything you saved has reached the office.',
      );
      if (points > 0) {
        lines.push(
          plural(points, 'route point', 'route points') +
            ' not sent yet. They stay on this phone and send when you sign in again — if someone else signs in here first, they are lost.',
        );
      }
      askConfirm({
        title: 'Sign out?',
        body: lines.join('\n\n'),
        confirmLabel: 'Sign out',
        tone: 'danger',
        cancelLabel: 'Stay signed in',
        run: () => {
          void signOutReal()
            .catch(() => undefined)
            .then(() => {
              forget();
              boot.setSession(null);
              router.replace('/');
            });
        },
      });
    })().catch(() => notify('Could not check what is still waiting. Try again.', 'error'));
  }, [askConfirm, notify, forget, boot, userId]);
}
