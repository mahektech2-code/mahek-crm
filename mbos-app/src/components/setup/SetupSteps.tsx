import React from 'react';
import { View } from 'react-native';

import { Badge, ListCard, PrimaryButton, SecondaryButton, T } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { Pop } from '../ui/motion';
import { color as C, radius, weight, type BadgeTone } from '../../theme/tokens';
import { getKv, setKv } from '../../db';
import { isoDate } from '../../lib/format';
import { acknowledgePhoneSetup } from '../../data/day-gate';
import { askBackgroundLocation, askPopups, confirmAutostart } from '../../data/setup-walkthrough';
import {
  openAppSettings,
  openAutostartSettings,
  openLocationSettings,
  requestBatteryExemption,
} from '../../native/phone-setup';
import type { SetupStepView, StepTone } from '../../engines/setup-steps';
import type { ToastTone } from '../ui/overlays';

/**
 * THE ROWS AND THE BUTTONS, once, for the three screens that set a phone up.
 *
 * Which steps there are and what they are called is `engines/setup-steps.ts`.
 * This is what pressing one does and how a row looks, and it is here for the
 * same reason: the walkthrough, the start-of-day gate and Keep tracking on each
 * had a copy of "open the autostart screen, and say so when the phone's own
 * page would not open", and the three copies disagreed about what to say.
 */

const TONE: Record<StepTone, BadgeTone> = {
  done: 'success',
  todo: 'danger',
  unknowable: 'neutral',
  stuck: 'danger',
};

const TONE_WORD: Record<StepTone, string> = {
  done: 'Done',
  todo: 'To do',
  /* Not "Unknown", which reads as a fault. Nobody can check it, including us. */
  unknowable: 'Cannot check',
  stuck: 'Stuck',
};

/*
 * KEPT FOR THE DAY, not for the life of a screen. The trip to the maker's
 * autostart menu is exactly when Funtouch and MIUI reap the app, and a flag
 * held in memory came back false — so he was sent to Settings a second time
 * before "I turned it on" would appear.
 */
const SENT_KEY = 'phoneSetup.autostartSentOn';

type Notify = (message: string, tone?: ToastTone) => void;

/**
 * What every button on every setup screen does.
 *
 * `ackItems` is what the screen was still asking for when he pressed "I turned
 * it on" — the gate passes its outstanding checks, the others pass autostart
 * alone — because that list travels to the office with the claim.
 */
export function useSetupActions(args: {
  notify: Notify;
  reload: () => void;
  ackItems: () => string[];
}) {
  const { notify, reload, ackItems } = args;
  const [busy, setBusy] = React.useState(false);
  const [sent, setSentState] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void getKv(SENT_KEY)
      .then((day) => alive && day === isoDate(new Date()) && setSentState(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const markSent = React.useCallback(() => {
    setSentState(true);
    void setKv(SENT_KEY, isoDate(new Date())).catch(() => {});
  }, []);

  const run = React.useCallback(
    async (step: SetupStepView) => {
      setBusy(true);
      try {
        switch (step.action) {
          case 'ask_popups':
            await askPopups();
            break;
          case 'location_settings':
            if (!(await openLocationSettings())) {
              notify('Could not open it. Open Settings → Location yourself.', 'error');
            }
            break;
          case 'ask_background':
            await askBackgroundLocation();
            break;
          case 'battery':
            await requestBatteryExemption();
            break;
          case 'app_settings':
            if (!(await openAppSettings())) notify('Could not open the settings. Call the office.', 'error');
            break;
          case 'autostart': {
            const opened = await openAutostartSettings();
            /* Said honestly when the phone's own screen would not open: most
               of these menus are not public, and landing on MBOS's own page
               looks like the app opened the wrong thing unless it says so and
               names what he is hunting for. */
            if (opened === 'opened_app_settings') {
              notify('That phone screen did not open. Look for: ' + step.title, 'warn');
            } else if (opened === 'failed') {
              notify('Could not open it. Follow the steps on this screen yourself.', 'error');
            }
            markSent();
            break;
          }
          default:
            break;
        }
      } finally {
        setBusy(false);
        reload();
      }
    },
    [markSent, notify, reload],
  );

  /*
   * One claim, spent the same way from every screen: he says the switch the
   * phone cannot read is on. The walkthrough's "done once on this install" and
   * the gate's acknowledgement were two records of the same press, so a phone
   * confirmed on one screen was asked again on the next.
   */
  const confirm = React.useCallback(async () => {
    await confirmAutostart().catch(() => undefined);
    await acknowledgePhoneSetup(ackItems()).catch(() => undefined);
    reload();
  }, [ackItems, reload]);

  return { busy, sent, run, confirm };
}

/**
 * The list itself.
 *
 * `openKey` set draws one step open at a time — the walkthrough, where the
 * point is the next thing to press. Unset draws every step open with its state
 * beside it — the gate and Keep tracking on, where the point is what is true
 * right now.
 */
export function SetupStepList(props: {
  steps: readonly SetupStepView[];
  openKey?: string | null;
  actions: ReturnType<typeof useSetupActions>;
}) {
  const { steps, openKey, actions } = props;
  const oneAtATime = openKey !== undefined;

  return (
    <ListCard style={{ marginTop: 8 }}>
      {steps.map((step, i) => {
        const open = oneAtATime ? openKey === step.key : true;
        const done = step.tone === 'done';
        return (
          <View
            key={step.key}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
              backgroundColor: oneAtATime && open ? C.canvas : undefined,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {/* The number becomes a tick with a pop when he comes back from
                  Settings having done it. Keyed on `done`, so steps already
                  done on arrival simply sit there. */}
              <Pop trigger={done}>
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
              </Pop>
              <T
                style={[
                  { flex: 1, fontSize: 15, color: done && oneAtATime ? C.muted : C.ink },
                  weight(open ? 600 : 500),
                ]}>
                {step.title}
              </T>
              {oneAtATime ? null : (
                <Pop trigger={step.tone}>
                  <Badge tone={TONE[step.tone]}>{TONE_WORD[step.tone]}</Badge>
                </Pop>
              )}
            </View>

            {/* Only the gate sets this. A step it does not hold the day on —
                the camera, say — is still offered, but is not dressed up as
                standing between him and his day. */}
            {step.blocksDay ? (
              <T s="caption" style={[{ color: C.danger, marginTop: 4, marginLeft: 34 }, weight(600)]}>
                Needed before you punch in
              </T>
            ) : null}

            {open && !(oneAtATime && done) ? (
              <>
                <T s="small" style={{ color: C.muted, marginTop: 6, marginLeft: 34 }}>
                  {step.detail}
                </T>
                {step.action && step.button && !done ? (
                  oneAtATime ? (
                    <PrimaryButton
                      label={actions.busy ? 'Waiting for your phone…' : step.button}
                      disabled={actions.busy}
                      whyDisabled="Wait. Your phone is still on the last step."
                      onPress={() => void actions.run(step)}
                      style={{ marginTop: 12, borderRadius: radius.md }}
                    />
                  ) : (
                    <SecondaryButton
                      label={step.button}
                      onPress={() => void actions.run(step)}
                      style={{ marginTop: 10, borderRadius: radius.md }}
                    />
                  )
                ) : null}
                {/* Autostart can be opened again after he says it is on, on
                    the screens that list everything: confirming it once does
                    not make the phone able to read it. */}
                {step.key === 'autostart' && done && !oneAtATime ? (
                  <SecondaryButton
                    label="Open that screen again"
                    onPress={() => void actions.run({ ...step, action: 'autostart' })}
                    style={{ marginTop: 10, borderRadius: radius.md }}
                  />
                ) : null}
                {/*
                  The second half of the autostart step, and only after the
                  first. It is a CLAIM — nothing tells the app what was tapped
                  on the maker's own page — so the label says what he is
                  asserting rather than pretending it is a tick.
                */}
                {step.key === 'autostart' && !done && actions.sent ? (
                  <SecondaryButton
                    label="I turned it on"
                    onPress={() => void actions.confirm()}
                    style={{ marginTop: 8, borderRadius: radius.md }}
                  />
                ) : null}
                {step.key === 'autostart' && !done && !actions.sent ? (
                  <T s="caption" style={{ marginTop: 8, marginLeft: 34 }}>
                    Open the setting first. Come back here after you turn it on.
                  </T>
                ) : null}
              </>
            ) : null}
          </View>
        );
      })}
    </ListCard>
  );
}
