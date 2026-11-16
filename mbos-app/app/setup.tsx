import React from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Icon } from '../src/components/ui/Icon';
import { DrawnTick, Swap, animateLayout } from '../src/components/ui/motion';
import { RESTART_SHORT, SetupStepList, useSetupActions } from '../src/components/setup/SetupSteps';
import { color as C, weight } from '../src/theme/tokens';
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

  const finished = !!steps && !current;
  const tone = finished ? 'navy' : 'lavender';
  const h = HERO[tone];
  const stepNo = steps ? Math.min(doneCount + 1, steps.length) : 0;

  return (
    <AppFrame
      title="Set up your phone"
      activeTab={null}
      hideBack
      tone={tone}
      showTitle={false}
      heroTop={
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: h.ink }, weight(800)]}>
          Set up your phone
        </Text>
      }
      hero={
        <Swap id={current ? 'todo' : 'done'}>
          {finished ? (
            <View
              accessible
              accessibilityLabel={'Your phone is set up. Everything MBOS needs is allowed. ' + RESTART_ANSWER}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 }}>
                {finishedHere ? (
                  <DrawnTick size={56} color={C.navy} background={C.lime} />
                ) : (
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: C.lime,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    <Icon name="tick" size={26} color={C.navy} strokeWidth={2.6} />
                  </View>
                )}
                <Text style={[{ flex: 1, fontSize: 24, lineHeight: 28, letterSpacing: -0.48, color: '#FFFFFF' }, weight(800)]}>
                  Your phone is set up
                </Text>
              </View>
              <Text style={{ fontSize: 13, lineHeight: 19, color: '#C9D1E0', marginTop: 10 }}>
                {'Everything MBOS needs is allowed. ' + RESTART_SHORT}
              </Text>
            </View>
          ) : (
            <View>
              <View
                accessible
                accessibilityLabel="Set this up once. It takes one minute. Android asks for each of these one by one. MBOS cannot turn them on for you. Do each step below. Each button opens the right place.">
                <Text style={[{ fontSize: 15, lineHeight: 20, color: h.ink, marginTop: 14 }, weight(700)]}>
                  Once, about a minute.
                </Text>
                <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 2 }}>
                  Android asks one by one; MBOS cannot switch them on for you. Each button opens the right place.
                </Text>
              </View>
              {steps && current ? (
                <View
                  accessible
                  accessibilityLabel={`Step ${stepNo} of ${steps.length}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
                  {steps.map((st) => (
                    <View
                      key={st.key}
                      style={{
                        flex: 1,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor:
                          st.tone === 'done' ? C.success : st.key === current.key ? C.primary : C.primaryEdge,
                      }}
                    />
                  ))}
                  <Text style={[{ fontSize: 12, lineHeight: 17, color: C.primaryDeep, marginLeft: 4 }, weight(800)]}>
                    {`${stepNo} / ${steps.length}`}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </Swap>
      }
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      {steps === null ? (
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 8, textAlign: 'center' }}>Checking your phone…</Text>
      ) : (
        <>
          <SetupStepList steps={steps} openKey={current?.key ?? null} actions={actions} />

          {current ? (
            <Pressable
              onPress={leave}
              accessibilityRole="button"
              style={{ alignSelf: 'stretch', marginTop: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, weight(600)]}>Do this later</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={leave}
              accessibilityRole="button"
              accessibilityLabel="Start using MBOS"
              style={({ pressed }) => ({
                marginTop: 14,
                minHeight: 60,
                paddingVertical: 8,
                borderRadius: 30,
                backgroundColor: C.navy,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: pressed ? 0.88 : 1,
              })}>
              <Text style={[{ flexShrink: 1, fontSize: 17, lineHeight: 22, color: '#FFFFFF', textAlign: 'center' }, weight(700)]}>Start using MBOS</Text>
              <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.lime, justifyContent: 'center' }}>
                <Icon name="forward" size={14} color={C.navy} strokeWidth={2.6} />
              </View>
            </Pressable>
          )}
        </>
      )}
    </AppFrame>
  );
}
