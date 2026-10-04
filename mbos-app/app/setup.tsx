import React from 'react';
import { AppState, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { Card, PrimaryButton, T } from '../src/components/ui/primitives';
import { DrawnTick, Swap, animateLayout } from '../src/components/ui/motion';
import { SetupStepList, useSetupActions } from '../src/components/setup/SetupSteps';
import { color as C, radius, weight } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { markWalkthroughShown, readSetupSteps } from '../src/data/setup-walkthrough';
import { firstOpen, stepsForEntry, type SetupStepView } from '../src/engines/setup-steps';
import { RESTART_ANSWER } from '../src/engines/oem-keepalive';

/**
 * Setting the phone up, one step at a time — opened straight after sign-in
 * on a new install, and again after an update that left something missing.
 *
 * Android grants nothing at install. Every permission here is a dialog the
 * salesman has to answer, and two are pages in Settings, so the most this
 * screen can do is put each one in front of him in the order that works and
 * take him to the exact page where a dialog cannot. That is what it does: one
 * step open at a time, one button, and every step re-read the moment he comes
 * back from Settings.
 *
 * **It never blocks.** "Do this later" is always there. The start-of-day gate
 * on `/phone-setup` is what refuses a day, and it keeps that job — this screen
 * is the quick way to satisfy it before the morning it matters, not a second
 * gate in front of the app.
 *
 * **Re-read on RETURN, not only on focus.** Going to Settings leaves the app
 * rather than this screen, so the router's focus event never fires on the way
 * back. `AppState` becoming active is what does, and a step still reading "to
 * do" after he has just done it is the one thing this screen must never show.
 */
export default function SetupScreen() {
  const notify = useStore((s) => s.notify);
  const [steps, setSteps] = React.useState<SetupStepView[] | null>(null);

  const load = React.useCallback(() => {
    void readSetupSteps()
      .then((next) => {
        /* Coming back from Settings with a step done moves the open step
           down the list; the layout eases there so his eye follows it to the
           next thing to do. A re-read that changed nothing moves nothing. */
        animateLayout();
        setSteps(stepsForEntry('walkthrough', next));
      })
      .catch(() => setSteps([]));
  }, []);

  useFocusEffect(load);

  React.useEffect(() => {
    /* Shown once for this build, whatever he does next — so "Later" is a real
       answer and the screen does not come back on every open. */
    void markWalkthroughShown();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  const leave = React.useCallback(() => router.replace('/home'), []);

  /* The autostart claim is the same one the start-of-day gate spends, so a
     phone whose last day recorded nothing is not asked again on the next screen. */
  const ackItems = React.useCallback(() => ['autostart'], []);
  const actions = useSetupActions({ notify, reload: load, ackItems });

  const current = steps ? firstOpen(steps) : null;
  const doneCount = steps ? steps.filter((s) => s.tone === 'done').length : 0;

  /*
   * WHETHER HE FINISHED IT HERE, which is the only time the drawn tick is due.
   *
   * The tick buzzes `success`, and a phone already set up — opened from More
   * to check — has finished nothing on this visit. So it is drawn only where
   * this visit has SEEN a step still to do and then seen none: the walkthrough
   * completed under his thumb. Set during render rather than in an effect, the
   * same way `Swap` tracks its previous key.
   */
  const [sawUnfinished, setSawUnfinished] = React.useState(false);
  if (current && !sawUnfinished) setSawUnfinished(true);
  const finishedHere = !!steps && !current && sawUnfinished;

  return (
    <AppFrame title="Set up your phone" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <Card>
        <Swap id={current ? 'todo' : 'done'}>
        {finishedHere ? (
          <View style={{ alignItems: 'center', marginBottom: 10 }}>
            <DrawnTick size={56} color={C.success} background={C.successBg} />
          </View>
        ) : null}
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          {current ? 'Set this up once. It takes one minute.' : 'Your phone is set up'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          {current
            ? 'Android asks for each of these one by one. MBOS cannot turn them on for you. ' +
              'Do each step below. Each button opens the right place.'
            : 'Everything MBOS needs is allowed. ' + RESTART_ANSWER}
        </T>
        </Swap>
      </Card>

      {steps === null ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          Checking your phone…
        </T>
      ) : (
        <>
          {current ? (
            <T s="caption" style={{ marginTop: 14 }}>
              {`Step ${Math.min(doneCount + 1, steps.length)} of ${steps.length}`}
            </T>
          ) : null}

          <SetupStepList steps={steps} openKey={current?.key ?? null} actions={actions} />

          {current ? (
            <Pressable
              onPress={leave}
              accessibilityRole="button"
              style={{ alignSelf: 'center', marginTop: 18, minHeight: 48, justifyContent: 'center', paddingHorizontal: 12 }}>
              <T s="small" style={{ color: C.muted }}>
                Do this later
              </T>
            </Pressable>
          ) : (
            <PrimaryButton label="Start using MBOS" onPress={leave} style={{ marginTop: 16, borderRadius: radius.xl }} />
          )}
        </>
      )}
    </AppFrame>
  );
}
