import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, PrimaryButton } from '../src/components/ui/primitives';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { plural, pretty } from '../src/lib/format';
import { OUTCOMES } from '../src/data/fixtures';
import { pendingCount } from '../src/sync/queue';
import { nextStop } from '../src/data/journey';

/**
 * The receipt for a visit.
 *
 * Every line is honest about what actually happened, and the dot beside it
 * carries the difference: green means done, amber means saved but not finished
 * yet. A photograph still in the queue and a photograph on the server are not
 * the same thing, and telling the salesman they are is how trust in the sync
 * indicator goes.
 */

export default function Saved() {
  const c = useCustomer();
  const outcome = useStore((s) => s.outcome);
  const shots = useStore((s) => s.shots);
  const voice = useStore((s) => s.voice);
  const gps = useStore((s) => s.gps);
  const nextDate = useStore((s) => s.nextDate);
  const visitSpent = useStore((s) => s.visitSpent);

  const picked = OUTCOMES.find((o) => o.k === outcome) ?? OUTCOMES[0];
  const shotCount = (shots.shop ? 1 : 0) + (shots.cust ? 1 : 0);
  const spent = visitSpent ?? '';

  /*
   * THE MANAGER HAS NOT BEEN TOLD UNTIL THE OUTBOX HAS DRAINED.
   *
   * Saving a visit ENQUEUES it; nothing reaches the office until the queue
   * goes out, which on a day with no signal is hours. This card asserted "Your
   * manager notified" in green — done — unconditionally, on the same list
   * where it correctly draws a queued photograph and a queued voice note in
   * amber, under a header saying exactly what the two colours mean. So a
   * salesman walked away from a shop believing the office knew, with the
   * status strip at the top of the same screen counting the very record that
   * had not gone.
   *
   * It reads the same outbox the strip does. It starts TRUE — assumed still
   * queued — because at the moment this screen opens that is simply what is
   * true, and the safe direction for a wrong first paint is amber: "saved, not
   * finished yet" is never a lie about a visit written a second ago, and green
   * would be.
   */
  /*
   * Whether there is a route to go back to. Null while it is being read, and
   * read as "no route" until it answers — the Customers list is the answer
   * that is never wrong, only sometimes longer than it needs to be, and a
   * button that changed its own label a beat after the screen opened would be
   * worse than either.
   */
  const [hasRoute, setHasRoute] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    /* `nextStop` and not a count: what makes this button worth pressing is a
       stop still to walk to, and a route whose every stop is done sends him
       back to a screen with nothing on it. It is the same definition the route
       screen's own Next-stop card uses, so the two cannot disagree. */
    void nextStop()
      .then((stop) => {
        if (live) setHasRoute(!!stop);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const [queued, setQueued] = React.useState(true);
  React.useEffect(() => {
    let live = true;
    const tick = () => {
      void pendingCount()
        .then((n) => {
          if (live) setQueued(n > 0);
        })
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const items = [
    gps === 'locked'
      ? { l: 'Location and time recorded', ok: true }
      : { l: 'Saved without a location — flagged for your manager', ok: false },
    shotCount ? { l: plural(shotCount, 'photo') + ' compressed and queued', ok: false } : null,
    /* Two different facts, and the old code could report neither: `done` was
       never set by anything and a successful recording set `failed`, so a
       voice note that had uploaded perfectly said it was waiting for signal. */
    voice === 'dictated'
      ? { l: 'What you said is in the note, and the recording goes with it', ok: true }
      : voice === 'queued'
        ? { l: 'Voice note kept — the office writes it out when you are back on', ok: false }
        : null,
    { l: 'Follow-up set for ' + pretty(nextDate), ok: true },
    queued
      ? { l: 'Your manager sees it the next time this phone sends', ok: false }
      : { l: 'Your manager notified', ok: true },
  ].filter((x): x is { l: string; ok: boolean } => x !== null);

  return (
    <AppFrame title="Visit saved" activeTab="customers" contentStyle={{ paddingHorizontal: 16, paddingVertical: 24 }}>
      <Card style={{ padding: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: C.successBg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="tick" size={20} color={C.success} strokeWidth={2} />
          </View>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Visit saved</Text>
        </View>

        <Text style={[type.small, { color: C.body, marginTop: 10 }]}>
          {[c?.name, picked.label, spent ? spent + ' in the shop' : null].filter(Boolean).join(' · ')}
        </Text>

        <View style={{ marginTop: 14 }}>
          {items.map((s) => (
            <View key={s.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.wash }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.ok ? C.success : C.warn }} />
              <Text style={{ fontSize: 15, color: C.body, flex: 1 }}>{s.l}</Text>
            </View>
          ))}
        </View>

        {/*
          THE NEXT VISIT IS PLANNED FROM THE ROUTE, where there is one.
          This always went to the Customers list — the whole book, A to Z —
          which is the right answer for a walk-in and the wrong one for a man
          working a route he agreed on Sunday: his next stop is already chosen,
          and he was being asked to find it again among two thousand shops. The
          label says which screen it opens, because "Next stop" meaning two
          different destinations on two different days is how somebody learns
          not to trust a button.
        */}
        <PrimaryButton
          label={hasRoute ? 'Next stop on your route' : 'Pick the next shop'}
          onPress={() => router.replace(hasRoute ? '/journey' : '/customers')}
          style={{ marginTop: 16, borderRadius: radius.sm }}
        />
        <Pressable
          onPress={() => router.replace('/home')}
          style={{ width: '100%', height: HIT, marginTop: 8, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Back to home</Text>
        </Pressable>
      </Card>
    </AppFrame>
  );
}
