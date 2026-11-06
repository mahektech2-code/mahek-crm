import React from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { BottomSheet } from '../ui/overlays';
import { PrimaryButton, SecondaryButton, T } from '../ui/primitives';
import { color as C, weight } from '../../theme/tokens';
import { pushStatus, registerForPush, turnOnNotifications } from '../../native/push';

/* "Later" holds until the app is next opened, so a salesman in a shop is not asked
   again on every return to Home, and is asked again tomorrow. */
let laterThisOpen = false;

/**
 * Asks a salesman with notifications off to turn them on.
 *
 * Android's own dialog says only "allow MBOS to send notifications", and after it
 * has been refused it never appears again. So this says why it matters, and it
 * keeps asking. It never blocks the day: his work goes on without it.
 */
export function NotificationsPrompt() {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const check = React.useCallback(() => {
    void pushStatus().then((s) => {
      if (s.ok) {
        /* Allowed while this sheet was up, or in the phone's settings: the token goes up now. */
        setOpen((was) => {
          if (was) void registerForPush();
          return false;
        });
      } else if (s.reason === 'permission' && !laterThisOpen) {
        setOpen(true);
      }
    });
  }, []);

  useFocusEffect(check);
  /* Coming back from Android's dialog or from the phone's settings is not a focus change. */
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => sub.remove();
  }, [check]);

  const later = () => {
    laterThisOpen = true;
    setOpen(false);
  };

  return (
    <BottomSheet open={open} onClose={later}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
        <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>Turn on notifications</T>
        <T style={{ fontSize: 15, lineHeight: 21, color: C.body, marginTop: 6 }}>
          MBOS tells you when a task is due, your route changes or an order is refused. Without
          notifications you only see these when you open the app.
        </T>
        <View style={{ marginTop: 16 }}>
          <PrimaryButton
            label={busy ? 'Asking…' : 'Turn on'}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void turnOnNotifications()
                .then((r) => {
                  if (r.ok) setOpen(false);
                })
                .finally(() => setBusy(false));
            }}
          />
        </View>
        <View style={{ marginTop: 10 }}>
          <SecondaryButton label="Later" onPress={later} />
        </View>
      </View>
    </BottomSheet>
  );
}
