import React from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { GLYPH, Glyph } from '../src/components/me/kit';
import { Icon } from '../src/components/ui/Icon';
import { Presence, animateLayout } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { RestartLine, SetupStepList, useSetupActions } from '../src/components/setup/SetupSteps';
import { color as C, weight } from '../src/theme/tokens';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { readReadiness } from '../src/data/phone-readiness';
import { readSetupSteps } from '../src/data/setup-walkthrough';
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

  const needed = views ? views.filter((v) => v.blocksDay && v.tone !== 'done').length : 0;
  const doneN = views ? views.filter((v) => v.tone === 'done').length : 0;

  return (
    <AppFrame
      title="Before you start"
      activeTab={null}
      onBack={back.go}
      showTitle={false}
      hero={
        <Text
          accessibilityRole="header"
          style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: HERO.lavender.ink, marginTop: 14 }, weight(800)]}>
          Before you start
        </Text>
      }
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <View style={{ backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: C.limeOnNavy,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Glyph shapes={GLYPH.shieldTick} size={22} color={C.lime} />
          </View>
          <Text style={[{ flex: 1, fontSize: 17, lineHeight: 22, color: '#FFFFFF' }, weight(800)]}>
            Set up your phone to record your day
          </Text>
        </View>
        <Text
          accessibilityLabel="Some phones turn MBOS off in your pocket to save battery. Then the office sees nothing you did all day. Your phone will not warn you. These few settings stop this."
          style={{ fontSize: 13, lineHeight: 19, color: '#C9D1E0', marginTop: 10 }}>
          Some phones turn MBOS off in your pocket to save battery — then the office sees nothing all day, and the
          phone never warns you.
        </Text>
        {/* THE QUESTION THIS SCREEN MADE PEOPLE RING THE OFFICE WITH.

            It walks a man to an autostart switch and said nothing about what to
            do afterwards, so the team worked it out between themselves and
            arrived at rebooting the handset — which is not the step, costs him
            ten minutes of a morning, and teaches him that none of this makes a
            difference. The sentence is `RESTART_ANSWER` and it lives in
            `engines/oem-keepalive.ts`, because the Keep tracking on screen asks
            for the same switches and two screens answering this differently is
            how a team ends up trusting neither. */}
        <RestartLine color={C.onNavyMuted} style={{ marginTop: 8 }} />
        {views ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
            {needed > 0 ? (
              <View
                style={{
                  height: 30,
                  paddingHorizontal: 12,
                  borderRadius: 15,
                  backgroundColor: C.dangerBg,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                }}>
                <Icon name="lock" size={12} color={C.danger} strokeWidth={2.2} />
                <Text style={[{ fontSize: 12, color: C.danger }, weight(800)]}>{needed + ' needed before punch-in'}</Text>
              </View>
            ) : null}
            {doneN > 0 ? (
              <View style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: C.limeOnNavy, justifyContent: 'center' }}>
                <Text style={[{ fontSize: 12, color: C.lime }, weight(800)]}>{doneN + ' done'}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {readiness === null || steps === null ? (
        readFailed ? (
          <View style={{ marginTop: 14, backgroundColor: C.dangerBg, borderRadius: 20, padding: 12, alignItems: 'center' }}>
            <Text style={[{ fontSize: 12, color: C.danger, textAlign: 'center' }, weight(700)]}>
              Could not check your phone. Try again.
            </Text>
            <Pressable
              onPress={load}
              accessibilityRole="button"
              style={({ pressed }) => ({
                marginTop: 8,
                height: 44,
                paddingHorizontal: 16,
                borderRadius: 22,
                backgroundColor: C.surface,
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}>
              <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>Check again</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ marginTop: 14, backgroundColor: C.surface, borderRadius: 20, padding: 16 }}>
            <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center' }}>Checking your phone…</Text>
          </View>
        )
      ) : null}

      {readiness?.deadEnd ? (
        <View style={{ marginTop: 12, padding: 18, borderRadius: 24, backgroundColor: C.danger }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: 'rgba(255,255,255,0.18)',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <Icon name="lock" size={20} color="#FFFFFF" strokeWidth={2} />
            </View>
            <Text style={[{ fontSize: 18, color: '#FFFFFF' }, weight(800)]}>Call the office</Text>
          </View>
          {/* NO WAY PAST, and no pretending there is one. Somebody at a desk
              has to walk him through his phone's own settings, and saying that
              plainly is more use than a button that cannot work. */}
          <Text style={{ fontSize: 13, lineHeight: 19, color: '#FFFFFF', opacity: 0.92, marginTop: 8 }}>
            Your phone will not ask again for something MBOS needs. MBOS cannot fix this. Call before you start the
            day — they will help.
          </Text>
        </View>
      ) : null}

      {views ? <SetupStepList steps={views} actions={actions} /> : null}

      {/* Arrives in place rather than appearing, so the way out reads as the
          result of the last row turning green. */}
      <Presence show={!!readiness?.mayCheckIn} distance={8}>
        <Pressable
          onPress={back.go}
          accessibilityRole="button"
          accessibilityLabel="Done. Go and punch in"
          style={({ pressed }) => ({
            marginTop: 14,
            height: 60,
            borderRadius: 30,
            backgroundColor: C.navy,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            opacity: pressed ? 0.88 : 1,
          })}>
          <Text style={[{ fontSize: 17, color: '#FFFFFF' }, weight(700)]}>Done. Go and punch in</Text>
          <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.lime, justifyContent: 'center' }}>
            <Icon name="forward" size={14} color={C.navy} strokeWidth={2.6} />
          </View>
        </Pressable>
      </Presence>

      {readiness && !readiness.mayCheckIn && !readiness.deadEnd ? (
        <Text
          accessibilityLabel="Finish the steps marked “Needed before you punch in”. Then you can start your day."
          style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 14, textAlign: 'center' }}>
          Finish the steps marked “Needed before you punch in” to start your day.
        </Text>
      ) : null}
    </AppFrame>
  );
}
