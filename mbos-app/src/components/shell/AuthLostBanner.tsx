import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authLost, onAuthLostChange } from '../../sync/api';
import { authLostSentence, type AuthLostReason } from '../../engines/sign-in';
import { pendingCount } from '../../sync/queue';
import { signOut } from '../../data/session';
import { useBoot } from '../../state/boot';
import { useStore } from '../../state/store';
import { color as C } from '../../theme/tokens';

/**
 * THE PHONE CAN NO LONGER SEND, AND IT SAYS SO ON EVERY SCREEN.
 *
 * A refresh token that ran out after a week away, a handset an admin released,
 * an account closed or the field app taken away: each of these refuses every
 * request until a person does something, and none of them used to be shown.
 * Home opened as usual, every visit and order saved as usual, and each one
 * then burned its retries against a refusal nobody could see until it sat in
 * "Not accepted" — a day's work that looked sent and was not.
 *
 * The banner is the only fix the phone can make: say it, say how many entries
 * are waiting, and take him to the sign-in screen. Signing back in as the same
 * person sends what was waiting.
 */
export function AuthLostBanner() {
  const boot = useBoot();
  const insets = useSafeAreaInsets();
  const forget = useStore((s) => s.signOut);
  const [reason, setReason] = React.useState<AuthLostReason | null>(null);
  const [waiting, setWaiting] = React.useState(0);

  React.useEffect(() => {
    if (!boot.session) {
      setReason(null);
      return;
    }
    let live = true;
    const read = () =>
      void Promise.all([authLost(), pendingCount().catch(() => 0)]).then(([lost, n]) => {
        if (!live) return;
        setReason(lost?.reason ?? null);
        setWaiting(n);
      });
    read();
    onAuthLostChange(read);
    return () => {
      live = false;
      onAuthLostChange(null);
    };
  }, [boot.session]);

  if (!boot.session || !reason) return null;

  const canSignIn = reason !== 'inactive' && reason !== 'no_app_access';

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        paddingTop: insets.top + 8,
        paddingBottom: 12,
        paddingHorizontal: 16,
        backgroundColor: C.dangerBg,
        borderBottomWidth: 1,
        borderBottomColor: C.danger,
      }}
      accessibilityRole="alert">
      <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
        {authLostSentence(reason)}
        {waiting ? ` ${waiting === 1 ? '1 entry is' : `${waiting} entries are`} waiting to send.` : ''}
      </Text>
      {canSignIn ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            /* Signing out keeps the outbox, and the same person signing back
               in sends it — see `data/session.ts`. */
            void signOut()
              .catch(() => undefined)
              .then(() => {
                forget();
                boot.setSession(null);
                router.replace('/');
              });
          }}
          style={{ marginTop: 8, minHeight: 40, justifyContent: 'center' }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: C.danger }}>Sign in again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
