import React from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { Icon } from '../ui/Icon';
import { Pop } from '../ui/motion';
import { color as C, weight } from '../../theme/tokens';
import { RESTART_ANSWER } from '../../engines/oem-keepalive';
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
 * The phone half of "did it work", short, for the screens that set a phone up.
 * `RESTART_ANSWER` is the whole sentence and stays the one copy of it; this is
 * what V3 prints, and every place that prints it hands the long one to a
 * screen reader.
 */
export const RESTART_SHORT = 'No phone restart needed. Battery works at once; autostart from your next start of day.';

/** The same, drawn: the short line on screen and the full one read out. */
export function RestartLine({ color = C.muted, style }: { color?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text accessibilityLabel={RESTART_ANSWER} style={[{ fontSize: 12, lineHeight: 17, color }, style]}>
      {RESTART_SHORT}
    </Text>
  );
}

const BADGE: Record<StepTone, { bg: string; ink: string }> = {
  done: { bg: C.successBg, ink: C.success },
  todo: { bg: C.dangerBg, ink: C.danger },
  unknowable: { bg: C.canvas, ink: C.muted },
  stuck: { bg: C.danger, ink: '#FFFFFF' },
};

/** The round mark at the head of a step: its number, or a tick once done. */
function StepMark({ n, done, state }: { n: number; done: boolean; state: 'current' | 'red' | 'plain' }) {
  return (
    /* The number becomes a tick with a pop when he comes back from Settings
       having done it. Keyed on `done`, so steps already done on arrival
       simply sit there. */
    <Pop trigger={done}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: done ? C.successBg : state === 'current' ? C.primary : state === 'red' ? C.dangerBg : 'transparent',
          borderWidth: !done && state === 'plain' ? 2 : 0,
          borderColor: C.border,
        }}>
        {done ? (
          <Icon name="tick" size={16} color={C.success} strokeWidth={2.6} />
        ) : (
          <Text
            style={[
              { fontSize: 13, lineHeight: 18, color: state === 'current' ? '#FFFFFF' : state === 'red' ? C.danger : C.muted },
              weight(800),
            ]}>
            {String(n)}
          </Text>
        )}
      </View>
    </Pop>
  );
}

/** One done step, said as a green pill. */
function DoneChip({ title, withWord = false }: { title: string; withWord?: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={title + ', done'}
      style={{ minHeight: 30, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 15, backgroundColor: C.successBg, justifyContent: 'center' }}>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.success }, weight(700)]}>{'✓ ' + title + (withWord ? ' · Done' : '')}</Text>
    </View>
  );
}

/** A navy main button, the one thing a step asks to press. */
function StepButton({
  label,
  onPress,
  height = 52,
  variant = 'navy',
  busy = false,
  icon,
  flex,
  hint,
}: {
  label: string;
  onPress: () => void;
  height?: number;
  variant?: 'navy' | 'outline' | 'wash';
  busy?: boolean;
  icon?: 'external' | 'tick';
  flex?: boolean;
  hint?: string;
}) {
  const bg = variant === 'navy' ? C.navy : variant === 'wash' ? C.canvas : C.surface;
  const fg = variant === 'navy' ? '#FFFFFF' : C.ink;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy }}
      accessibilityHint={hint}
      style={({ pressed }) => ({
        flex: flex ? 1 : undefined,
        height,
        borderRadius: height / 2,
        backgroundColor: bg,
        borderWidth: variant === 'outline' ? 2 : 0,
        borderColor: C.navy,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 12,
        opacity: busy ? 0.7 : pressed ? 0.88 : 1,
      })}>
      {icon ? <Icon name={icon} size={18} color={fg} strokeWidth={2.2} /> : null}
      <Text numberOfLines={1} style={[{ flexShrink: 1, fontSize: height >= 56 ? 16 : variant === 'navy' ? 15 : 14, color: fg }, weight(700)]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The list itself.
 *
 * `openKey` set draws one step open at a time — the walkthrough, where the
 * point is the next thing to press. Unset draws every step open with its state
 * beside it — the gate and Keep tracking on, where the point is what is true
 * right now.
 *
 * `extras` puts a screen's own line inside a step's card — Keep tracking on's
 * answer about the battery saver, under the battery step it is about.
 */
export function SetupStepList(props: {
  steps: readonly SetupStepView[];
  openKey?: string | null;
  actions: ReturnType<typeof useSetupActions>;
  extras?: Partial<Record<string, React.ReactNode>>;
  /** Done steps as green pills rather than rows — Keep tracking on. */
  doneAsChips?: boolean;
}) {
  const { steps, openKey, actions, extras, doneAsChips = false } = props;
  const oneAtATime = openKey !== undefined;
  if (oneAtATime) return <Walkthrough steps={steps} openKey={openKey ?? null} actions={actions} />;

  const done = steps.filter((s) => s.tone === 'done' && !(s.key === 'autostart'));
  const rest = steps.filter((s) => !done.includes(s));
  return (
    <View style={{ marginTop: 14, gap: 10 }}>
      {done.length ? (
        doneAsChips ? (
          <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {done.map((st) => (
              <DoneChip key={st.key} title={st.title} withWord />
            ))}
          </View>
        ) : (
          <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16 }}>
            {done.map((st, i) => (
              <View
                key={st.key}
                accessible
                accessibilityLabel={`${st.title}. ${st.detail}. Done`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 60,
                  paddingVertical: 10,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.hairline,
                }}>
                <StepMark n={steps.indexOf(st) + 1} done state="plain" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{st.title}</Text>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{st.detail}</Text>
                </View>
                <ToneBadge tone="done" />
              </View>
            ))}
          </View>
        )
      ) : null}
      {rest.map((step) => {
        const i = steps.indexOf(step);
        const isDone = step.tone === 'done';
        const red = !isDone && (step.blocksDay || (doneAsChips && step.tone !== 'unknowable'));
        return (
          <View
            key={step.key}
            style={{
              backgroundColor: C.surface,
              borderRadius: 22,
              padding: 16,
              borderWidth: step.blocksDay && !isDone ? 2 : 0,
              borderColor: C.danger,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <StepMark n={i + 1} done={isDone} state={red ? 'red' : 'plain'} />
              <Text style={[{ flex: 1, fontSize: 16, lineHeight: 21, color: C.ink }, weight(800)]}>{step.title}</Text>
              <Pop trigger={step.tone}>
                <ToneBadge tone={step.tone} />
              </Pop>
            </View>

            {/* Only the gate sets this. A step it does not hold the day on —
                the camera, say — is still offered, but is not dressed up as
                standing between him and his day. */}
            {step.blocksDay ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, marginLeft: 44 }}>
                <Icon name="lock" size={12} color={C.danger} strokeWidth={2.2} />
                <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.danger }, weight(800)]}>Needed before you punch in</Text>
              </View>
            ) : null}

            {isDone ? null : (
              <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 6, marginLeft: 44 }}>{step.detail}</Text>
            )}
            {step.action && step.button && !isDone ? (
              step.key === 'autostart' && actions.sent ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                  <StepButton label={step.button} variant="wash" flex onPress={() => void actions.run(step)} />
                  {/*
                    The second half of the autostart step, and only after the
                    first. It is a CLAIM — nothing tells the app what was tapped
                    on the maker's own page — so the label says what he is
                    asserting rather than pretending it is a tick.
                  */}
                  <StepButton label="I turned it on" variant="outline" flex onPress={() => void actions.confirm()} />
                </View>
              ) : (
                <View style={{ marginTop: 12 }}>
                  <StepButton label={step.button} onPress={() => void actions.run(step)} />
                </View>
              )
            ) : null}
            {/* Autostart can be opened again after he says it is on, on the
                screens that list everything: confirming it once does not make
                the phone able to read it. */}
            {step.key === 'autostart' && isDone ? (
              <View style={{ marginTop: 12 }}>
                <StepButton
                  label="Open that screen again"
                  variant="wash"
                  height={48}
                  onPress={() => void actions.run({ ...step, action: 'autostart' })}
                />
              </View>
            ) : null}
            {step.key === 'autostart' && !isDone && !actions.sent ? (
              <Text style={{ fontSize: 12, lineHeight: 17, color: C.faint, marginTop: 6, textAlign: 'center' }}>
                Open the setting first. Come back here after you turn it on.
              </Text>
            ) : null}
            {extras?.[step.key] ?? null}
          </View>
        );
      })}
    </View>
  );
}

function ToneBadge({ tone }: { tone: StepTone }) {
  return (
    <View style={{ minHeight: 26, paddingVertical: 3, paddingHorizontal: 9, borderRadius: 13, backgroundColor: BADGE[tone].bg, justifyContent: 'center' }}>
      <Text style={[{ fontSize: 11, color: BADGE[tone].ink }, weight(800)]}>{TONE_WORD[tone]}</Text>
    </View>
  );
}

/**
 * The walkthrough's list: what is done, the one step open, and what comes
 * after. Two or more done steps fold into green pills so the open step stays
 * near the top of the screen.
 */
function Walkthrough({
  steps,
  openKey,
  actions,
}: {
  steps: readonly SetupStepView[];
  openKey: string | null;
  actions: ReturnType<typeof useSetupActions>;
}) {
  const doneSteps = steps.filter((s) => s.tone === 'done');
  const fold = doneSteps.length >= 2 || openKey === null;
  const rows = fold ? steps.filter((s) => s.tone !== 'done') : steps;
  return (
    <View style={{ marginTop: 16, backgroundColor: C.surface, borderRadius: 22, overflow: 'hidden' }}>
      {fold && doneSteps.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 12, paddingHorizontal: 16 }}>
          {doneSteps.map((st) => (
            <DoneChip key={st.key} title={st.title} />
          ))}
        </View>
      ) : null}
      {rows.map((step, idx) => {
        const i = steps.indexOf(step);
        const open = openKey === step.key;
        const done = step.tone === 'done';
        const lineAbove = idx > 0 || (fold && doneSteps.length > 0);
        if (open) {
          return (
            <View
              key={step.key}
              style={{
                padding: 16,
                backgroundColor: '#F7F4FF',
                borderTopWidth: lineAbove ? 1 : 0,
                borderBottomWidth: idx < rows.length - 1 ? 1 : 0,
                borderColor: C.hairline,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <StepMark n={i + 1} done={false} state="current" />
                <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 16, lineHeight: 21, color: C.ink }, weight(800)]}>
                  {step.title}
                </Text>
              </View>
              <Text style={{ fontSize: 13, lineHeight: 19, color: step.key === 'autostart' ? C.body : C.muted, marginTop: step.key === 'autostart' ? 10 : 6, marginLeft: 44 }}>
                {step.detail}
              </Text>
              {step.action && step.button ? (
                <View style={{ marginTop: 12 }}>
                  <StepButton
                    label={actions.busy ? 'Waiting for your phone…' : step.button}
                    height={56}
                    icon="external"
                    busy={actions.busy}
                    hint={actions.busy ? 'Wait. Your phone is still on the last step.' : undefined}
                    onPress={() => {
                      /* Busy is the phone's own dialog or page still up. A
                         second press would open a second one on top. */
                      if (!actions.busy) void actions.run(step);
                    }}
                  />
                </View>
              ) : null}
              {step.key === 'autostart' && actions.sent ? (
                <View style={{ marginTop: 8 }}>
                  <StepButton label="I turned it on" height={56} variant="outline" icon="tick" onPress={() => void actions.confirm()} />
                </View>
              ) : null}
              {step.key === 'autostart' && !actions.sent ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.faint, marginTop: 8, textAlign: 'center' }}>
                  Open the setting first. Come back here after you turn it on.
                </Text>
              ) : null}
            </View>
          );
        }
        return (
          <View
            key={step.key}
            accessible
            accessibilityLabel={`Step ${i + 1}: ${step.title}${done ? ', done' : ''}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 56,
              paddingHorizontal: 16,
              borderTopWidth: lineAbove && !(idx > 0 && openKey === rows[idx - 1]?.key) ? 1 : 0,
              borderTopColor: C.hairline,
            }}>
            <StepMark n={i + 1} done={done} state="plain" />
            <Text style={[{ flex: 1, fontSize: 15, lineHeight: 21, color: done ? C.muted : C.ink }, weight(done ? 400 : 600)]}>{step.title}</Text>
          </View>
        );
      })}
    </View>
  );
}
