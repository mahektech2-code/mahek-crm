import React from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Presence, animateLayout } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { SetupStepList, useSetupActions } from '../src/components/setup/SetupSteps';
import { color as C, radius, weight } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { readReadiness } from '../src/data/phone-readiness';
import { readSetupSteps } from '../src/data/setup-walkthrough';
import { RESTART_ANSWER } from '../src/engines/oem-keepalive';
import { outstandingChecks, stepsForEntry } from '../src/engines/setup-steps';
import type { Readiness } from '../src/engines/phone-readiness';
import type { Step } from '../src/engines/setup-walkthrough';

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

/*
 * THE SAME LIST as the walkthrough and Keep tracking on (`engines/setup-steps.ts`),
 * with this screen's one addition laid over it: which steps hold the day. The
 * rule for that is `phone-readiness.ts` and has not moved; what changed is that
 * a salesman sent here from either of the other two now reads the same five
 * steps under the same five titles.
 */
export default function PhoneSetupScreen() {
  const back = useCameFrom('home');
  const notify = useStore((s) => s.notify);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;

  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  const [steps, setSteps] = React.useState<Step[] | null>(null);
  const [readFailed, setReadFailed] = React.useState(false);

  const load = React.useCallback(() => {
    let alive = true;
    setReadFailed(false);
    void Promise.all([readReadiness(userId), readSetupSteps()])
      .then(([r, list]) => {
        if (!alive) return;
        /* A row done on the trip to Settings loses its button on the way back;
           the list closes the gap rather than jumping under his thumb. */
        animateLayout();
        setReadiness(r);
        setSteps(list);
      })
      /* "Checking your phone…" that never resolves reads as a hung app. */
      .catch(() => alive && setReadFailed(true));
    return () => {
      alive = false;
    };
  }, [userId]);

  useFocusEffect(load);

  /* Settings is left by the APP, not this screen, so focus never fires on the
     way back. A row still saying "not allowed" after he allowed it is the app
     calling him a liar about what he just did. */
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  /*
   * WHAT WAS STILL OUTSTANDING travels with the claim. "He said he did the
   * battery steps" and "he said it while three rows were still red" are
   * different facts about the same press, and only the second one explains a
   * day that then recorded nothing.
   */
  const ackItems = React.useCallback(() => outstandingChecks(readiness), [readiness]);
  const actions = useSetupActions({ notify, reload: load, ackItems });

  /*
   * THE GATE OPENING IS THE ONE THING HERE THAT IS FINISHED, so it is the one
   * thing that buzzes. Only on the change, seen on this visit — a phone that
   * was already ready when the screen opened has finished nothing just now.
   */
  const mayCheckIn = readiness ? readiness.mayCheckIn : null;
  const wasReady = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (wasReady.current === false && mayCheckIn === true) feedback('success');
    if (mayCheckIn !== null) wasReady.current = mayCheckIn;
  }, [mayCheckIn]);

  const views = steps ? stepsForEntry('gate', steps, readiness) : null;

  return (
    <AppFrame
      title="Before you start"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          Set up your phone to record your day
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          Some phones turn MBOS off in your pocket to save battery. Then the office sees nothing
          you did all day. Your phone will not warn you. These few settings stop this.
        </T>
        {/* THE QUESTION THIS SCREEN MADE PEOPLE RING THE OFFICE WITH.
            
            It walks a man to an autostart switch and said nothing about what to
            do afterwards, so the team worked it out between themselves and
            arrived at rebooting the handset — which is not the step, costs him
            ten minutes of a morning, and teaches him that none of this makes a
            difference. The sentence is `RESTART_ANSWER` and it lives in
            `engines/oem-keepalive.ts`, because the Keep tracking on screen asks
            for the same switches and two screens answering this differently is
            how a team ends up trusting neither. */}
        <T s="small" style={{ color: C.muted, marginTop: 6 }}>
          {RESTART_ANSWER}
        </T>
      </Card>

      {readiness === null || steps === null ? (
        readFailed ? (
          <View style={{ marginTop: 16, gap: 10 }}>
            <T s="caption" style={{ textAlign: 'center', color: C.danger }}>
              Could not check your phone. Try again.
            </T>
            <SecondaryButton label="Check again" onPress={load} />
          </View>
        ) : (
          <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
            Checking your phone…
          </T>
        )
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
            <T style={[{ fontSize: 15, color: C.danger }, weight(600)]}>Call the office</T>
          </View>
          {/* NO WAY PAST, and no pretending there is one. Somebody at a desk
              has to walk him through his phone's own settings, and saying that
              plainly is more use than a button that cannot work. */}
          <T s="small" style={{ color: C.danger, marginTop: 6 }}>
            Your phone will not ask again for something MBOS needs. MBOS cannot fix this.
            Call the office before you start the day. They will help you.
          </T>
        </View>
      ) : null}

      {views ? <SetupStepList steps={views} actions={actions} /> : null}

      {/* Arrives in place rather than appearing, so the way out reads as the
          result of the last row turning green. */}
      <Presence show={!!readiness?.mayCheckIn} distance={8}>
        <PrimaryButton
          label="Done. Go and punch in"
          onPress={back.go}
          style={{ marginTop: 16, borderRadius: radius.xl }}
        />
      </Presence>

      {readiness && !readiness.mayCheckIn && !readiness.deadEnd ? (
        <T s="caption" style={{ marginTop: 16, textAlign: 'center' }}>
          Finish the steps marked “Needed before you punch in”. Then you can start your day.
        </T>
      ) : null}
    </AppFrame>
  );
}
