import React from 'react';
import { Animated, AppState, type AppStateStatus, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color as C, radius } from '../../theme/tokens';
import { Icon } from '../ui/Icon';
import { PrimaryButton, T } from '../ui/primitives';
import { DUR, EASE, Presence, useReduceMotion, useShake } from '../ui/motion';
import { forgetUnlock, markLeft, markUnlocked, shouldLock } from '../../data/app-lock';
import { capability, prompt } from '../../native/biometrics';
import { useBoot } from '../../state/boot';
import { setAppLocked } from '../../state/push-banner';

/**
 * The lock screen.
 *
 * It is a COVER, not a route. Everything underneath stays mounted and running —
 * the sync engine, the media queue, the route trail — so a locked phone in a
 * pocket goes on sending the morning's orders and goes on drawing the line the
 * office is watching. Making it a route would unmount the app in order to hide
 * it, which is the one thing a field handset must not do.
 *
 * It does nothing until somebody is signed in, on purpose: there is nothing to
 * lock on a phone nobody has signed in on, and covering the sign-in form with a
 * fingerprint prompt is the trap this whole feature was moved away from.
 *
 * THERE IS NO DEAD END IN HERE. `shouldLock` refuses to lock a phone that has
 * no screen lock left to check against, and where it does lock, the OS prompt
 * always carries the device PIN as its own fallback — so a cut thumb on a wet
 * morning costs a PIN and never a day's work.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const boot = useBoot();
  const [locked, setLocked] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  /* What the last attempt said, shown verbatim. "Try again" with no reason
     leaves somebody pressing the same button at a sensor that has stopped
     reading. */
  const [why, setWhy] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('Fingerprint');

  const signedIn = !!boot.session;
  /* One prompt at a time. The OS raises `inactive` while its own dialog is up,
     and a second `authenticateAsync` over the first cancels it on Android. */
  const inFlight = React.useRef(false);

  const ask = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAsking(true);
    setWhy(null);
    try {
      const outcome = await prompt('Unlock MBOS');
      if (outcome.ok) {
        markUnlocked();
        setLocked(false);
        return;
      }
      if (outcome.kind === 'unavailable') {
        /*
         * Nothing left to check against — the fingers or the screen lock went
         * after the setting was turned on. `shouldLock` has already switched
         * the setting off; letting them straight in is the other half of that,
         * and the alternative is a handset nobody can open with a day's unsent
         * work inside it.
         */
        markUnlocked();
        setLocked(false);
        return;
      }
      /* Cancelled gets no message: they pressed cancel, they know what they
         did, and a red sentence for it reads as a failure rather than a
         choice. A lockout gets one, because nothing else explains a sensor
         that has stopped responding. */
      setWhy(outcome.kind === 'lockout' ? outcome.message : null);
    } finally {
      inFlight.current = false;
      setAsking(false);
    }
  }, []);

  /**
   * Put the cover up and ask in the same breath.
   *
   * The two are one act, which is why they are one function rather than an
   * effect watching the flag: the ordinary morning is the person picking the
   * phone up to find the prompt already open, touching the sensor, and never
   * seeing this screen at all.
   */
  const raise = React.useCallback(async () => {
    /*
     * THE COVER GOES UP FIRST, before anything is asked of anybody.
     *
     * It used to wait on `capability()` — four calls into
     * expo-local-authentication — so on resume the customer list and what each
     * of them owes were on screen for the few hundred milliseconds the lock
     * took to decide what to CALL itself. Nothing about putting the cover up
     * needs that answer; it only chooses the word "Fingerprint" or "Face
     * unlock", which the cover can correct once it arrives. A lock screen that
     * previews the book it is protecting is not a lock screen, and that is as
     * true of the half-second before it as of the screen itself.
     */
    setLocked(true);
    void capability()
      .then((can) => setLabel(can.label))
      .catch(() => {
        /* The default label stands. Being unable to name the sensor is not a
           reason to leave the app uncovered. */
      });
    await ask();
  }, [ask]);

  /* On the way up, once there is a session to protect. */
  React.useEffect(() => {
    if (!boot.ready || !signedIn) return;
    let live = true;
    void (async () => {
      if ((await shouldLock()) && live) await raise();
    })();
    return () => {
      live = false;
    };
  }, [boot.ready, signedIn, raise]);

  /*
   * Coming back is where the clock is read.
   *
   * The check happens on the way BACK rather than on the way out, because what
   * matters is how long the phone was out of the person's hands and that is
   * only knowable on return.
   *
   * `inactive` is deliberately not treated as leaving. iOS raises it for the
   * app switcher, for a notification shade pulled halfway down, and for the
   * moment a system dialog appears — including the fingerprint dialog itself,
   * which would otherwise re-arm the lock it is in the middle of answering.
   */
  React.useEffect(() => {
    if (!signedIn) return;
    const onState = (state: AppStateStatus) => {
      if (state === 'background') {
        markLeft();
        return;
      }
      if (state !== 'active') return;
      void (async () => {
        if (await shouldLock()) await raise();
      })();
    };
    const sub = AppState.addEventListener('change', onState);
    return () => sub.remove();
  }, [signedIn, raise]);

  /* Signing out forgets the unlock, so whoever opens the app on this handset
     next is asked rather than walking into the session behind it. */
  React.useEffect(() => {
    if (!signedIn) {
      forgetUnlock();
      setLocked(false);
    }
  }, [signedIn]);

  /*
   * THE COVER LEAVES; IT DOES NOT ARRIVE.
   *
   * Unlocking lifts it away — a fade with a slight swell, `DUR.quick` — so the
   * app underneath reads as uncovered rather than as a different screen
   * snapping in. Locking has no animation at all, and that asymmetry is the
   * point: a cover that faded IN would show the customer list through it for
   * the length of the fade, which is the preview `raise` already refuses to
   * give. So while `locked` the opacity is a plain 1, not the animated value,
   * and there is no frame in which the cover is up but see-through.
   *
   * Kept mounted while it leaves, and touch-transparent while it does: the
   * person is in, and a tap on the app in those 180 ms must land on the app.
   */
  /* The push banner reads this: while the cover is up it draws nothing, and
     the system shows the push instead — see `state/push-banner.ts`. */
  React.useEffect(() => {
    setAppLocked(locked);
  }, [locked]);

  const reduce = useReduceMotion();
  const fade = React.useRef(new Animated.Value(1)).current;
  const [coverMounted, setCoverMounted] = React.useState(locked);
  if (locked && !coverMounted) setCoverMounted(true);

  React.useEffect(() => {
    if (locked || !coverMounted) return;
    if (reduce) {
      setCoverMounted(false);
      return;
    }
    fade.setValue(1);
    const anim = Animated.timing(fade, { toValue: 0, duration: DUR.quick, easing: EASE, useNativeDriver: true });
    anim.start(({ finished }) => {
      if (finished) setCoverMounted(false);
    });
    return () => anim.stop();
  }, [locked, coverMounted, reduce, fade]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {coverMounted ? (
        <Animated.View
          pointerEvents={locked ? 'auto' : 'none'}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            /* Above everything drawn in the app's window, whatever its order:
               Android stacks by elevation, and the push banner has some. */
            zIndex: 1000,
            elevation: 24,
            opacity: locked ? 1 : fade,
            transform: [{ scale: locked ? 1 : fade.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1] }) }],
          }}>
          <Cover asking={asking} why={why} label={label} onUnlock={() => void ask()} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * What is drawn over the app.
 *
 * Deliberately bare. It names the app and asks for a finger, and it shows
 * nothing else — no customer, no figure, no count of what is waiting. A lock
 * screen that previews the book it is protecting is not a lock screen.
 */
function Cover({
  asking,
  why,
  label,
  onUnlock,
}: {
  asking: boolean;
  why: string | null;
  label: string;
  onUnlock: () => void;
}) {
  const insets = useSafeAreaInsets();
  const finger = label === 'Fingerprint';

  /*
   * A LOCKOUT SHAKES, AND ONLY A LOCKOUT.
   *
   * It is the one refusal this screen can tell apart: `prompt` folds a finger
   * that did not read into `cancelled`, because the OS's own dialog has
   * already said so to the person's face, and shaking the cover behind that
   * dialog for a cancel he chose would read as the app scolding him. A
   * lockout is different — the sensor has stopped answering and the sentence
   * explaining why has just appeared — so it moves and buzzes `warning`.
   * Keyed on the sentence arriving: `ask` clears it first, so a second
   * lockout in a row shakes again.
   */
  const { shake, style: shakeStyle } = useShake('warning');
  React.useEffect(() => {
    if (why) shake();
  }, [why, shake]);

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: C.surface,
        paddingHorizontal: 24,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + 24,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Animated.View style={[{ alignSelf: 'stretch', alignItems: 'center' }, shakeStyle]}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: radius.xl,
          backgroundColor: C.primaryTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Icon name="finger" size={32} color={C.primaryDeep} strokeWidth={1.5} />
      </View>

      <T s="h2" style={{ marginTop: 16 }}>
        MBOS is locked
      </T>
      <T s="body" style={{ color: C.muted, marginTop: 6, textAlign: 'center' }}>
        {finger ? 'Touch the fingerprint sensor to open the app.' : `Use ${label.toLowerCase()} to open the app.`}
      </T>

      <Presence show={!!why} style={{ alignSelf: 'stretch' }}>
        <View
          style={{
            backgroundColor: C.dangerBg,
            borderLeftWidth: 3,
            borderLeftColor: C.danger,
            borderRadius: 8,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginTop: 20,
          }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{why}</T>
        </View>
      </Presence>
      </Animated.View>

      <PrimaryButton
        label={asking ? 'Waiting for your finger…' : 'Unlock'}
        onPress={onUnlock}
        disabled={asking}
        whyDisabled="The fingerprint box is already open."
        style={{ marginTop: 24, alignSelf: 'stretch' }}
      />

      {/* Not a button, because there is no second thing to press: the phone's
          own prompt carries the PIN. Saying so is what stops somebody with a
          wet thumb concluding they are shut out of their own day. */}
      <T s="caption" style={{ marginTop: 12, textAlign: 'center' }}>
        If your finger does not work, use your phone PIN in the same box.
      </T>
    </View>
  );
}
