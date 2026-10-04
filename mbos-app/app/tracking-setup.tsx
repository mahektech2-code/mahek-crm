import React from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import {
  RESTART_ANSWER,
  trackingVerdict,
  type CaptureMode,
  type TrackingVerdict,
} from '../src/engines/oem-keepalive';
import { SetupStepList, useSetupActions } from '../src/components/setup/SetupSteps';
import { readSetupSteps } from '../src/data/setup-walkthrough';
import { stepsForEntry, type SetupStepView } from '../src/engines/setup-steps';
import { captureMode } from '../src/sync/trail';
import { canRestart, restartApp } from '../src/native/updates';
import { markAsked } from '../src/native/keepalive';
import { batteryExemption } from '../src/native/phone-setup';
import type { BatteryExemption } from '../src/engines/phone-readiness';
import { useStore } from '../src/state/store';
import { color as C, radius, weight } from '../src/theme/tokens';
import { Swap } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';

/**
 * KEEPING THE ROUTE RECORDING WHEN THE PHONE IS IN A POCKET.
 *
 * Android says a foreground service with an ongoing notification keeps
 * running. Every OEM in this market breaks that, and the app is never told:
 * `startLocationUpdatesAsync` answers yes and then nothing arrives. A salesman
 * checked in at 04:16 and by half past twelve had posted not one position,
 * with every permission reading granted.
 *
 * There is no API that asks "may I keep running", so this screen is the only
 * honest thing available: walk him through the two switches that decide it,
 * in his own phone's words, once.
 *
 * IT IS NOT A PERMISSION SCREEN AND MUST NOT READ AS ONE. Nothing here is
 * required to use the app, nothing is blocked by skipping it, and the day
 * records either way — at the foreground floor, which is what the watchdog
 * falls back to. What is lost without it is the part of the day his phone is
 * in his pocket, which is most of it.
 *
 * WHAT IT REFUSES TO CLAIM is the other half. The battery step is granted by
 * a system dialog and comes back with an answer; autostart is a page we open
 * and a sentence we print, and nothing tells this app what was tapped there.
 * So one step can be ticked and the other cannot, and the screen says which
 * is which rather than drawing two ticks and meaning one.
 */
export default function TrackingSetupScreen() {
  const back = useCameFrom('sync');
  const notify = useStore((s) => s.notify);
  /* The same five steps the walkthrough and the start-of-day gate draw, under
     the same titles — see `engines/setup-steps.ts`. This screen used to keep
     its own two, worded differently, and somebody sent here from the gate was
     reading a second list about the same phone. */
  const [steps, setSteps] = React.useState<SetupStepView[] | null>(null);
  /*
   * WHAT THE PHONE ACTUALLY SAYS ABOUT THE BATTERY STEP.
   *
   * This screen drew a number in a circle for "we opened that screen for you"
   * and nothing whatever for "and did it work" — on the ONE step of the two
   * where Android will answer the question. So a salesman who tapped Allow and
   * one who dismissed the dialog left this screen looking identical, which is
   * the same two-kinds-of-day failure the attendance selfie's skip button
   * produced.
   *
   * `unknown` stays silent rather than guessing: iOS, a build without the
   * native module, a ROM that refuses. Silence is what "we could not check"
   * looks like, and it is never drawn as a tick.
   */
  const [exemption, setExemption] = React.useState<BatteryExemption>('unknown');
  /*
   * WHETHER ANY OF IT WORKED, which this screen could not say.
   *
   * It walked a salesman through two settings screens and stopped. The whole
   * team then asked the office the same question — restart the app, or restart
   * the phone? — because nothing here answered it, and a team guessing at a
   * recovery step does the wrong one and concludes the settings made no
   * difference. `captureMode` is what the trail is actually doing right now and
   * `trackingVerdict` is the one place it becomes words.
   */
  const [capture, setCapture] = React.useState<CaptureMode>(null);
  const [restarting, setRestarting] = React.useState(false);

  const reread = React.useCallback(() => {
    void batteryExemption()
      .then(setExemption)
      .catch(() => setExemption('unknown'));
    /* Read rather than awaited: it is this process's own state, so there is
       nothing to fail and nothing to wait for. */
    setCapture(captureMode());
    void readSetupSteps()
      .then((list) => setSteps(stepsForEntry('tracking', list)))
      .catch(() => setSteps([]));
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      void markAsked();
      reread();
    }, [reread]),
  );

  /*
   * ASKED AGAIN WHEN HE COMES BACK FROM SETTINGS, which is the only moment the
   * answer can have changed. The system dialog puts MBOS in the background, so
   * reading straight after the button press would read the state as it was
   * before he had answered — and a screen still saying "battery saving is on"
   * after he has just switched it off is how somebody concludes the app is
   * wrong about his phone and stops believing the rest of it.
   */
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reread();
    });
    return () => sub.remove();
  }, [reread]);

  const ackItems = React.useCallback(() => ['autostart'], []);
  const actions = useSetupActions({ notify, reload: reread, ackItems });

  /*
   * The battery step turning green under his thumb is the one completion this
   * screen can actually SEE — autostart is unreadable — so it is the one that
   * buzzes. Only on the change: a phone already exempt when the screen opened
   * has done nothing just now. The previous answer is kept by the effect.
   */
  const wasExempt = React.useRef<BatteryExemption | null>(null);
  React.useEffect(() => {
    if (wasExempt.current === 'optimised' && exemption === 'exempt') feedback('success');
    if (exemption !== 'unknown') wasExempt.current = exemption;
  }, [exemption]);

  const verdict: TrackingVerdict = trackingVerdict({ capture, exemption, canRestart: canRestart() });

  /*
   * THE CTA THAT DOES THE THING, rather than a sentence telling him to.
   *
   * `restart_app` really restarts MahekOne; `recheck` re-reads the phone. What
   * neither of them is, ever, is a phone restart — see the engine for why that
   * folk remedy is not offered. A restart that could not be performed says so
   * instead of leaving him watching a button do nothing, which is the one
   * outcome that would teach this screen's whole audience to ignore it.
   */
  const act = async () => {
    if (verdict.action === 'recheck') {
      reread();
      notify('Checked. Nothing has changed on this phone.', 'info');
      return;
    }
    if (verdict.action !== 'restart_app' || restarting) return;
    setRestarting(true);
    if (!(await restartApp())) {
      setRestarting(false);
      notify('Could not restart. Close Mahek MBOS fully and open it again.', 'error');
    }
    /* No `finally`. On the path that worked there is nothing after this: the
       reload is already posted to the main thread and no code here may assume
       it runs. Clearing the flag would be a state update racing a teardown. */
  };

  return (
    <AppFrame title="Keep tracking on" activeTab="more" onBack={back.go} contentStyle={{ padding: 16 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card style={{ gap: 8 }}>
        <T style={[{ fontSize: 16, color: C.ink }, weight(600)]}>Why this matters</T>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>
          Your phone saves battery by stopping apps you are not using. When it stops
          Mahek MBOS, your route is not recorded. Then the office sees you standing still
          at a place you left hours ago.
        </T>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>
          These two settings keep Mahek MBOS running during your work day. It still
          stops when you punch out.
        </T>
      </Card>

      {steps === null ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          Checking your phone…
        </T>
      ) : (
        <SetupStepList steps={steps} actions={actions} />
      )}

      {/* THE ONE STEP THE PHONE WILL ANSWER, and the answer said plainly.
          `exempt` is not a claim about the tracker working — autostart is
          still unreadable and still matters — so it states only what was asked
          and what the phone said back. */}
      {exemption !== 'unknown' ? (
        <Swap id={exemption}>
          <T
            style={{
              fontSize: 13,
              lineHeight: 18,
              marginTop: 10,
              color: exemption === 'exempt' ? C.muted : C.danger,
            }}>
            {exemption === 'exempt'
              ? 'Battery saving is off for Mahek MBOS.'
              : 'Battery saving is still on for Mahek MBOS. It can stop your route at any time.'}
          </T>
        </Swap>
      ) : null}

      {/* AND THEN WHAT — the step the screen stopped one short of.
          
          Both buttons above open a settings screen and come back, and until now
          that was the end of it: nothing said whether it had worked, and
          nothing answered the question the whole team ended up ringing the
          office with. This row is the answer, with the one thing to press on
          it. It is drawn LAST because it is about what the two steps above
          achieved, and it is drawn always — a handset that is recording
          properly is exactly as worth saying out loud as one that is not,
          since "did it work" is the question being asked either way. */}
      <View
        style={{
          marginTop: 14,
          padding: 16,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: verdict.tone === 'act' ? C.danger : C.border,
          backgroundColor: C.surface,
          gap: 8,
        }}>
        {/* The verdict is re-read on every return from Settings; a new one
            settles in where the old one stood. */}
        <Swap id={verdict.title} style={{ gap: 8 }}>
        <T
          style={[
            { fontSize: 15, color: verdict.tone === 'act' ? C.danger : C.ink },
            weight(600),
          ]}>
          {verdict.title}
        </T>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>{verdict.detail}</T>
        </Swap>

        {verdict.action === 'restart_app' ? (
          <PrimaryButton
            label={restarting ? 'Restarting…' : 'Restart Mahek MBOS'}
            onPress={() => void act()}
            disabled={restarting}
            style={{ borderRadius: radius.xl }}
          />
        ) : null}
        {verdict.action === 'recheck' ? (
          <SecondaryButton
            label="Check this phone again"
            onPress={() => void act()}
            style={{ borderRadius: radius.xl }}
          />
        ) : null}

        {/* The phone half, from the one constant both screens read. */}
        <T style={{ fontSize: 13, lineHeight: 19, color: C.muted }}>{RESTART_ANSWER}</T>
      </View>

      {/* WHAT SKIPPING COSTS, said accurately. This read "skipping it blocks
          nothing", which is true of this screen and false of the app: the
          start-of-day gate in `data/day-gate.ts` stops a day opening on a
          handset whose last worked day recorded nothing at all, and that is
          precisely the handset that skipped these steps. Two screens
          disagreeing about whether a setting is compulsory is how a team
          concludes neither of them means anything. */}
      <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 14 }}>
        You only do this once. Your day is still recorded while the app is open. If you skip it,
        the time your phone is in your pocket is not recorded. If a whole day records nothing,
        you may not be able to start the next day until this is fixed.
      </T>
    </AppFrame>
  );
}
