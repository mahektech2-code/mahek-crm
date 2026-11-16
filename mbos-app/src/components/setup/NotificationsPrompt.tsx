import React from 'react';
import { AppState, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { BottomSheet } from '../ui/overlays';
import { T } from '../ui/primitives';
import { Icon } from '../ui/Icon';
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bell" size={22} color={C.primaryDeep} strokeWidth={2} />
          </View>
          <T style={[{ flex: 1, fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>Turn on notifications</T>
        </View>
        {/* What it is for, as three things he will recognise, and the cost
            of saying no in one line. The whole sentence is read out. */}
        <View
          accessible
          accessibilityLabel="MBOS tells you when a task is due, your route changes or an order is refused. Without notifications you only see these when you open the app."
          style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {['Task due', 'Route changed', 'Order refused'].map((w) => {
              /* A refusal is the one of the three that costs him a ring-back. */
              const red = w === 'Order refused';
              return (
                <View
                  key={w}
                  style={{ height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: red ? C.dangerBg : C.canvas, justifyContent: 'center' }}>
                  <T style={[{ fontSize: 12, color: red ? C.danger : C.ink }, weight(600)]}>{w}</T>
                </View>
              );
            })}
          </View>
          <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 8 }}>
            Without them you only see these when you open the app.
          </T>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={busy ? 'Asking' : 'Turn on'}
          accessibilityState={{ busy }}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void turnOnNotifications()
              .then((r) => {
                if (r.ok) setOpen(false);
              })
              .finally(() => setBusy(false));
          }}
          style={({ pressed }) => [btn, { marginTop: 14, backgroundColor: C.primary, opacity: busy ? 0.7 : pressed ? 0.9 : 1 }]}>
          <T style={[{ fontSize: 16, color: C.onNavy }, weight(700)]}>{busy ? 'Asking…' : 'Turn on'}</T>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Later"
          onPress={later}
          style={({ pressed }) => ({ marginTop: 8, minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}>
          <T style={[{ fontSize: 15, color: C.muted }, weight(600)]}>Later</T>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const btn = { minHeight: 56, borderRadius: 28, alignItems: 'center' as const, justifyContent: 'center' as const, paddingHorizontal: 12 };
