import React from 'react';
import { View } from 'react-native';
import * as Location from 'expo-location';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { acknowledgePhoneSetup } from '../src/data/day-gate';
import { readReadiness } from '../src/data/phone-readiness';
import type { ItemState, Readiness, ReadinessItem } from '../src/engines/phone-readiness';
import {
  openAppSettings,
  openAutostartSettings,
  openLocationSettings,
  requestBatteryExemption,
} from '../src/native/phone-setup';

/**
 * Whether this phone will actually record the day, asked BEFORE the day.
 *
 * A salesman on a vivo checked in at 04:16 and posted not one position all
 * day. Everything on his handset read correct — the permissions, the
 * registered background task, the check-in's own GPS fix — and the phone's
 * battery manager killed the service behind all of it. The office saw a man
 * who appeared not to have left home, and nobody found out for a fortnight.
 *
 * So this screen stands in front of the check-in. It is a CHECKLIST and not a
 * warning: every row says what is true right now, what it means in words a man
 * in a market can read, and the one thing to press. **There is no skip
 * button** — not here and not on the row that nobody can verify. AGENTS.md
 * records why the attendance selfie lost its "Start the day without a photo"
 * button, and the reasoning is the same one: a day started past a warning and
 * a day started properly are two kinds of day with nothing on the record
 * saying which, and the second kind is worthless the moment the first exists.
 *
 * **THE DEAD END IS SAID IN WORDS.** Where Android has stopped offering to ask
 * and MBOS has run out of ways to help, the screen says so and says to ring
 * the office. Inventing a button there would be worse than the dead end.
 *
 * **Every fact is re-read when the screen comes back into focus.** He leaves
 * for Settings and returns, and a row still saying "not allowed" after he
 * allowed it is the single most damaging thing this feature could do: it is
 * the app calling him a liar about something he has just done, and the next
 * thing he does is stop believing the rest of the screen.
 */

const TONE: Record<ItemState, BadgeTone> = {
  ok: 'success',
  todo: 'danger',
  unknowable: 'neutral',
  dead_end: 'danger',
};

const STATE_WORD: Record<ItemState, string> = {
  ok: 'Done',
  todo: 'To do',
  /* Not "Unknown", which reads as a fault. Nobody can check it, including us,
     and the row says whose limitation that is. */
  unknowable: 'Cannot check',
  dead_end: 'Stuck',
};

/**
 * What the one button on a row says.
 *
 * A switch over quoted values rather than a `Record` keyed by them, because
 * `src/data/reachable.test.ts` sweeps this tree for the NAME of every function
 * in `src/data` and one of them is called `acknowledge` — an object key or a
 * property access reads to that sweep exactly like a call, and would take a
 * genuinely unreachable function off its allowlist. The words are the same
 * either way; this shape is the one that does not lie to the test next door.
 */
function buttonLabel(action: NonNullable<ReadinessItem['action']>): string {
  switch (action) {
    case 'location_settings':
      return 'Open location settings';
    case 'ask_permission':
      return 'Ask for permission';
    case 'app_settings':
      return 'Open app settings';
    case 'battery':
      return 'Allow MBOS to keep running';
    case 'autostart':
      return 'Open the setting';
    default:
      return 'I have done it';
  }
}

export default function PhoneSetupScreen() {
  const back = useCameFrom('home');
  const notify = useStore((s) => s.notify);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;

  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  /*
   * Whether he has been SENT to the autostart screen on this visit.
   *
   * The engine cannot know this — it is pure, and being sent somewhere is not
   * a fact about the phone — and the claim must not be offered before the
   * trip, or "I have done it" becomes the first button on the row and the
   * setting never gets touched. So the ordering lives here, where the screen
   * can watch him come back.
   */
  const [sent, setSent] = React.useState(false);

  const load = React.useCallback(() => {
    let alive = true;
    void readReadiness(userId).then((r) => {
      if (alive) setReadiness(r);
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  useFocusEffect(load);

  const run = React.useCallback(
    async (item: ReadinessItem) => {
      switch (item.action) {
        case 'location_settings':
          if (!(await openLocationSettings())) {
            notify('Could not open the settings. Open Settings → Location by hand.');
          }
          break;

        case 'ask_permission': {
          /*
           * Asked here rather than deep-linked to Settings, because the system
           * dialog is the one path that ends in a granted permission with two
           * taps. Background is asked SECOND and separately — Android refuses
           * "all the time" outright until the foreground one is held, so
           * asking for it first spends the prompt for nothing.
           */
          if (item.key === 'foreground') await Location.requestForegroundPermissionsAsync();
          else await Location.requestBackgroundPermissionsAsync();
          break;
        }

        case 'app_settings':
          if (!(await openAppSettings())) {
            notify('Could not open the settings. Ring the office.');
          }
          break;

        case 'battery':
          await requestBatteryExemption();
          break;

        case 'autostart': {
          const opened = await openAutostartSettings();
          /*
           * SAID HONESTLY when his phone's own screen could not be reached.
           * Most of these menus are not public, and on a make nobody has
           * mapped the best MBOS can do is drop him on its own settings page —
           * which looks like the app opened the wrong thing unless it says so
           * and names what he is hunting for.
           */
          if (opened === 'opened_app_settings') {
            notify('Your phone’s own screen would not open. Look for: ' + item.title);
          } else if (opened === 'failed') {
            notify('Could not open it. Find it by hand — the steps are on this screen.');
          }
          setSent(true);
          break;
        }

        case 'acknowledge':
          /*
           * WHAT WAS STILL OUTSTANDING travels with the claim. "He said he did
           * the battery steps" and "he said it while three rows were still
           * red" are different facts about the same press, and only the second
           * one explains a day that then recorded nothing.
           */
          await acknowledgePhoneSetup(
            (readiness?.items ?? []).filter((x) => x.state !== 'ok').map((x) => x.key),
          );
          break;

        default:
          break;
      }
      load();
    },
    [load, notify, readiness],
  );

  const autostartBlocked = readiness?.items.some((i) => i.key === 'autostart' && i.state === 'todo') ?? false;

  return (
    <AppFrame
      title="Before you start"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          Your phone has to be able to record the day
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          Some phones switch MBOS off in your pocket to save battery. When that happens the office cannot
          see a single thing you did all day — and nothing on your phone says so. These few settings stop
          it.
        </T>
      </Card>

      {readiness === null ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          Checking your phone…
        </T>
      ) : null}

      {readiness?.deadEnd ? (
        <View
          style={{
            marginTop: 12,
            padding: 16,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: C.dangerBg,
            backgroundColor: C.dangerBg,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="lock" size={18} color={C.danger} strokeWidth={1.6} />
            <T style={[{ fontSize: 15, color: C.danger }, weight(600)]}>Ring the office</T>
          </View>
          {/* NO WAY PAST, and no pretending there is one. Somebody at a desk
              has to walk him through his phone's own settings, and saying that
              plainly is more use than a button that cannot work. */}
          <T s="small" style={{ color: C.danger, marginTop: 6 }}>
            Your phone has stopped offering to ask for something MBOS needs, and MBOS cannot fix it from
            here. Ring the office before you start the day — they will take you through it.
          </T>
        </View>
      ) : null}

      <ListCard style={{ marginTop: 12 }}>
        {(readiness?.items ?? []).map((item, i) => (
          <View
            key={item.key}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(600)]}>{item.title}</T>
              <Badge tone={TONE[item.state]}>{STATE_WORD[item.state]}</Badge>
            </View>
            <T s="small" style={{ color: C.muted, marginTop: 4 }}>
              {item.detail}
            </T>

            {item.action ? (
              <SecondaryButton
                label={buttonLabel(item.action)}
                onPress={() => void run(item)}
                style={{ marginTop: 10, borderRadius: radius.md }}
              />
            ) : null}

            {/*
              The second half of the autostart step, and only after the first.
              It is a CLAIM — the engine spends it on exactly one day, and if
              tomorrow is silent too the row comes back — so the label says
              what he is asserting rather than pretending it is a tick.
            */}
            {item.key === 'autostart' && item.state === 'todo' && sent ? (
              <SecondaryButton
                label={buttonLabel('acknowledge')}
                onPress={() => void run({ ...item, action: 'acknowledge' })}
                style={{ marginTop: 8, borderRadius: radius.md }}
              />
            ) : null}
          </View>
        ))}
      </ListCard>

      {autostartBlocked && !sent ? (
        <T s="caption" style={{ marginTop: 10 }}>
          Open the setting first. You can tell us you have done it once you come back.
        </T>
      ) : null}

      {readiness?.mayCheckIn ? (
        <PrimaryButton
          label="All set — go back and start the day"
          onPress={back.go}
          style={{ marginTop: 16, borderRadius: radius.xl }}
        />
      ) : null}

      {readiness && !readiness.mayCheckIn && !readiness.deadEnd ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          The day cannot be started until the rows above are done.
        </T>
      ) : null}
    </AppFrame>
  );
}
