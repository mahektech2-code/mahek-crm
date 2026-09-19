import React from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { keepAliveSteps, type KeepAliveStep } from '../src/engines/oem-keepalive';
import {
  markAsked,
  openAutostartSettings,
  requestBatteryExemption,
  thisOem,
} from '../src/native/keepalive';
import { batteryExemption } from '../src/native/phone-setup';
import type { BatteryExemption } from '../src/engines/phone-readiness';
import { useStore } from '../src/state/store';
import { color as C, radius, weight } from '../src/theme/tokens';

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
  const [steps, setSteps] = React.useState<KeepAliveStep[]>([]);
  const [opened, setOpened] = React.useState<Record<string, boolean>>({});
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

  const reread = React.useCallback(() => {
    void batteryExemption()
      .then(setExemption)
      .catch(() => setExemption('unknown'));
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      setSteps(keepAliveSteps(thisOem()));
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

  const run = async (step: KeepAliveStep) => {
    const ok =
      step.key === 'battery' ? await requestBatteryExemption() : await openAutostartSettings();
    setOpened((o) => ({ ...o, [step.key]: true }));
    if (!ok) {
      /* Every rung of the ladder failed, which on a real handset means the
         settings app itself refused an intent. Saying so beats a button that
         appears to do nothing. */
      notify('Could not open that screen — you can reach it from Android Settings');
    }
  };

  return (
    <AppFrame title="Keep tracking on" activeTab="more" onBack={back.go} contentStyle={{ padding: 16 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card style={{ gap: 8 }}>
        <T style={[{ fontSize: 16, color: C.ink }, weight(600)]}>Why this matters</T>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>
          Your phone tries to save battery by stopping apps you are not looking at. When it stops
          MahekOne, your route stops being recorded — and the office sees you standing still
          somewhere you left hours ago.
        </T>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>
          These two settings tell your phone to leave it alone while your day is open. It still
          stops the moment you check out.
        </T>
      </Card>

      {steps.map((step, i) => (
        <Card key={step.key} style={{ marginTop: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: opened[step.key] ? C.primary : C.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <T style={[{ fontSize: 13, color: opened[step.key] ? '#FFFFFF' : C.body }, weight(600)]}>
                {i + 1}
              </T>
            </View>
            <T style={[{ fontSize: 15, color: C.ink, flex: 1 }, weight(600)]}>{step.title}</T>
          </View>

          <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>{step.detail}</T>

          {step.grantable ? (
            <PrimaryButton
              label={opened.battery ? 'Open it again' : 'Allow it'}
              onPress={() => void run(step)}
              style={{ borderRadius: radius.xl }}
            />
          ) : (
            <SecondaryButton
              label={opened.autostart ? 'Open that screen again' : 'Open that screen'}
              onPress={() => void run(step)}
              style={{ borderRadius: radius.xl }}
            />
          )}

          {/* THE ONE STEP THE PHONE WILL ANSWER, and the answer said plainly.
              `exempt` is not a claim about the tracker working — autostart is
              still unreadable and still matters — so it states only what was
              asked and what the phone said back. */}
          {step.grantable && exemption !== 'unknown' ? (
            <T
              style={{
                fontSize: 13,
                lineHeight: 18,
                color: exemption === 'exempt' ? C.muted : C.danger,
              }}>
              {exemption === 'exempt'
                ? 'Your phone says battery saving is off for MahekOne. That part is done.'
                : 'Your phone still has battery saving switched on for MahekOne — it can stop your route being recorded at any time.'}
            </T>
          ) : null}

          {opened[step.key] && !step.grantable ? (
            /* NOT A TICK. The phone cannot learn what was tapped on an OEM's
               own page, and a tick here would be the app asserting something
               it has no way to know. */
            <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>
              We cannot tell from here whether that switch is on — if the office says your route is
              still going quiet, come back and check it.
            </T>
          ) : null}
        </Card>
      ))}

      <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 14 }}>
        Nothing here is compulsory and skipping it blocks nothing. Your day is still recorded while
        the app is open either way.
      </T>
    </AppFrame>
  );
}
