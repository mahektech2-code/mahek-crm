import React from 'react';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';

import { routeForNotification } from '../native/push';
import { useBoot } from './boot';

/**
 * Tapping a push opens the thing it is about.
 *
 * Without this a push is a dead end: it buzzes, the salesman taps it, the app
 * opens on whatever screen he left, and the message he tapped is nowhere in
 * sight. He then has to go and find it — which is the whole cost of the push
 * saved and spent again, and the reason people stop tapping them.
 *
 * TWO WAYS IN, and only one of them is a listener. A tap while the app is
 * running or in the background raises an event. A tap that COLD-STARTS the app
 * raises it before any React tree exists to hear it, so that one has to be
 * asked for — `getLastNotificationResponseAsync` is the only way to learn the
 * app was opened by a notification rather than by its icon. Handling only the
 * listener is the ordinary mistake and it fails exactly where push matters
 * most: the phone in a pocket, notification on the lock screen, app not
 * running.
 *
 * IT WAITS FOR A SESSION. Routing to `/tasks` before boot has decided whether
 * anybody is signed in would push a screen behind the sign-in form, where the
 * salesman lands on it after signing in with no idea why.
 */
export function PushTaps() {
  const boot = useBoot();
  const signedIn = !!boot.session;
  /* A cold-start tap is delivered once and stays the "last response" for the
     life of the process, so it has to be consumed rather than re-read on
     every state change. */
  const coldStartHandled = React.useRef(false);

  React.useEffect(() => {
    if (!boot.ready || !signedIn) return;

    let live = true;

    void (async () => {
      if (coldStartHandled.current) return;
      coldStartHandled.current = true;
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!live || !response) return;
        router.push(routeForNotification(response.notification.request.content.data));
      } catch {
        /* No response to read, or a shape this version does not have. The app
           opens on its own first screen, which is where it would have gone. */
      }
    })();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        router.push(routeForNotification(response.notification.request.content.data));
      } catch {
        /* A route that will not push is not worth crashing the app for. */
      }
    });

    return () => {
      live = false;
      sub.remove();
    };
  }, [boot.ready, signedIn]);

  return null;
}
