import React from 'react';
import { AppState, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { Card, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, weight } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { acknowledgePhoneSetup } from '../src/data/day-gate';
import {
  askBackgroundLocation,
  askPopups,
  confirmAutostart,
  markWalkthroughShown,
  readSetupSteps,
} from '../src/data/setup-walkthrough';
import { currentStep, type Step } from '../src/engines/setup-walkthrough';
import { RESTART_ANSWER } from '../src/engines/oem-keepalive';
import {
  openAppSettings,
  openAutostartSettings,
  openLocationSettings,
  requestBatteryExemption,
} from '../src/native/phone-setup';

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
  const [steps, setSteps] = React.useState<Step[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  /* Whether he has been sent to the autostart screen on this visit. The
     confirmation is offered only after the trip, or "I have switched it on"
     becomes the first button and the setting never gets touched. */
  const [sentToAutostart, setSentToAutostart] = React.useState(false);

  const load = React.useCallback(() => {
    void readSetupSteps()
      .then(setSteps)
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

  const run = React.useCallback(
    async (step: Step) => {
      setBusy(true);
      try {
        switch (step.action) {
          case 'ask_popups':
            await askPopups();
            break;
          case 'location_settings':
            if (!(await openLocationSettings())) notify('Could not open it. Open Settings → Location by hand.');
            break;
          case 'ask_background':
            await askBackgroundLocation();
            break;
          case 'battery':
            await requestBatteryExemption();
            break;
          case 'app_settings':
            if (!(await openAppSettings())) notify('Could not open the settings. Ring the office.');
            break;
          case 'autostart': {
            const opened = await openAutostartSettings();
            /* Said honestly when the phone's own screen would not open: most
               of these menus are not public, and landing on MBOS's own page
               looks like the app opened the wrong thing unless it says so. */
            if (opened === 'opened_app_settings') {
              notify('Your phone’s own screen would not open. Look for: ' + step.title);
            } else if (opened === 'failed') {
              notify('Could not open it. The steps are on this screen — find it by hand.');
            }
            setSentToAutostart(true);
            break;
          }
          default:
            break;
        }
      } finally {
        setBusy(false);
        load();
      }
    },
    [load, notify],
  );

  const confirm = React.useCallback(async () => {
    await confirmAutostart();
    /* The same claim the start-of-day gate spends, so a phone whose last day
       recorded nothing is not asked a second time on the next screen. */
    await acknowledgePhoneSetup(['autostart']).catch(() => undefined);
    load();
  }, [load]);

  const current = steps ? currentStep(steps) : null;
  const doneCount = steps ? steps.filter((s) => s.state === 'done').length : 0;

  return (
    <AppFrame title="Set up your phone" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <Card>
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          {current ? 'A minute, once, and your day records itself' : 'Your phone is set up'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          {current
            ? 'Android makes every app ask for these one by one — MBOS cannot switch them on for you. ' +
              'Do each step below; it takes you straight to the right place.'
            : 'Everything MBOS needs is allowed. ' + RESTART_ANSWER}
        </T>
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

          <ListCard style={{ marginTop: 8 }}>
            {steps.map((step, i) => {
              const open = current?.key === step.key;
              const done = step.state === 'done';
              return (
                <View
                  key={step.key}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: C.wash,
                    backgroundColor: open ? C.canvas : undefined,
                  }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: done ? C.successBg : C.wash,
                      }}>
                      {done ? (
                        <Icon name="tick" size={14} color={C.success} strokeWidth={2} />
                      ) : (
                        <T s="caption" style={[{ color: C.ink }, weight(600)]}>
                          {String(i + 1)}
                        </T>
                      )}
                    </View>
                    <T
                      style={[
                        { flex: 1, fontSize: 15, color: done ? C.muted : C.ink },
                        weight(open ? 600 : 500),
                      ]}>
                      {step.title}
                    </T>
                  </View>

                  {open ? (
                    <>
                      <T s="small" style={{ color: C.muted, marginTop: 6, marginLeft: 34 }}>
                        {step.detail}
                      </T>
                      {step.action && step.button ? (
                        <PrimaryButton
                          label={busy ? 'Waiting for your phone…' : step.button}
                          disabled={busy}
                          whyDisabled="Your phone is still answering the last step."
                          onPress={() => void run(step)}
                          style={{ marginTop: 12, borderRadius: radius.md }}
                        />
                      ) : null}
                      {step.key === 'autostart' && sentToAutostart ? (
                        <SecondaryButton
                          label="I have switched it on"
                          onPress={() => void confirm()}
                          style={{ marginTop: 8, borderRadius: radius.md }}
                        />
                      ) : null}
                    </>
                  ) : null}
                </View>
              );
            })}
          </ListCard>

          {current?.key === 'autostart' && !sentToAutostart ? (
            <T s="caption" style={{ marginTop: 10 }}>
              Open the setting first. You can tell us you have done it once you come back.
            </T>
          ) : null}

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
