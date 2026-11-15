import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { color as C, HIT, weight } from '../src/theme/tokens';
import { DrawnTick, Stagger } from '../src/components/ui/motion';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { plural, pretty } from '../src/lib/format';
import { FOLLOW_UP_MODES, OUTCOMES } from '../src/data/fixtures';
import { visitSendState } from '../src/data/visits';
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
  const nextMode = useStore((s) => s.nextMode);
  const visitSpent = useStore((s) => s.visitSpent);
  const saved = useStore((s) => s.visitSaved);

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

  /* THIS visit's outbox row, not the whole outbox — see `visitSendState`.
     "Your manager is told" went green the moment the queue was empty, so a
     visit the office REFUSED read as told, and one sitting behind somebody's
     photograph read as unsent. */
  const [sent, setSent] = React.useState<'sent' | 'waiting' | 'refused'>('waiting');
  const visitId = saved?.id ?? null;
  React.useEffect(() => {
    let live = true;
    if (!visitId) return;
    const tick = () => {
      void visitSendState(visitId)
        .then((v) => {
          if (live) setSent(v);
        })
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [visitId]);

  const items: { l: string; ok: boolean; icon: IconName }[] = [
    gps === 'locked'
      ? { l: 'Location and time saved', ok: true, icon: 'locate' as IconName }
      : { l: 'Saved without location. Your manager will check it', ok: false, icon: 'locate' as IconName },
    shotCount ? { l: plural(shotCount, 'photo') + ' saved, waiting to send', ok: false, icon: 'image' as IconName } : null,
    /* Two different facts, and the old code could report neither: `done` was
       never set by anything and a successful recording set `failed`, so a
       voice note that had uploaded perfectly said it was waiting for signal. */
    voice === 'dictated'
      ? { l: 'What you said is in the note. The recording goes with it', ok: true, icon: 'mic' as IconName }
      : voice === 'queued'
        ? { l: 'Voice note kept. The office will type it out when you are online', ok: false, icon: 'mic' as IconName }
        : null,
    /* The day the save actually set — none, where he said no follow-up or the
       shop was shut. It printed the form's date whether or not a task was
       raised. */
    saved && saved.followUpDate == null
      ? { l: 'No follow-up set', ok: true, icon: 'cal' as IconName }
      : {
          l: (FOLLOW_UP_MODES.find((m) => m.k === nextMode)?.label ?? 'Visit') + ' set for ' + pretty(saved?.followUpDate ?? nextDate),
          ok: true,
          icon: 'cal' as IconName,
        },
    saved?.unverified
      ? { l: 'Saved as not checked. Your manager will read your reason', ok: false, icon: 'warn' as IconName }
      : null,
    sent === 'refused'
      ? { l: 'The office did not accept it. Open Not accepted', ok: false, icon: 'alert' as IconName }
      : sent === 'sent'
        ? { l: 'Your manager is told', ok: true, icon: 'synced' as IconName }
        : { l: 'Your manager will see it when this phone sends', ok: false, icon: 'upload' as IconName },
  ].filter((x): x is { l: string; ok: boolean; icon: IconName } => x !== null);

  const chip = (text: string, icon?: IconName) => (
    <View
      key={text}
      style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {icon ? <Icon name={icon} size={14} color={C.ink} strokeWidth={2.2} /> : null}
      <Text numberOfLines={1} style={[{ fontSize: 13, color: C.ink, flexShrink: 1 }, weight(700)]}>
        {text}
      </Text>
    </View>
  );

  return (
    <AppFrame
      title="Visit saved"
      activeTab="customers"
      showTitle={false}
      footer={
        <View style={{ backgroundColor: C.canvas, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 }}>
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
          <Pressable
            onPress={() => router.replace(hasRoute ? '/journey' : '/customers')}
            accessibilityRole="button"
            accessibilityLabel={hasRoute ? 'Next stop on your route' : 'Pick the next shop'}
            style={({ pressed }) => ({
              height: 60,
              borderRadius: 30,
              backgroundColor: C.navy,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              opacity: pressed ? 0.88 : 1,
            })}>
            <Text style={[{ fontSize: 17, color: '#FFFFFF' }, weight(700)]}>
              {hasRoute ? 'Next stop on your route' : 'Pick the next shop'}
            </Text>
            <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="forward" size={16} color={C.navy} strokeWidth={2.4} />
            </View>
          </Pressable>
          <Pressable
            onPress={() => router.replace('/home')}
            accessibilityRole="button"
            style={{ width: '100%', height: Math.max(HIT, 48), marginTop: 4, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(700)]}>Back to home</Text>
          </Pressable>
        </View>
      }
      contentStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 }}>
      {/* DRAWN, and the one success buzz of the whole save. The visit
          screen deliberately says nothing as it hands over — no toast, no
          buzz — so this tick landing is the moment the visit is felt to
          be done, once. */}
      <DrawnTick size={64} color={C.success} background={C.successBg} />
      <Text accessibilityRole="header" style={[{ fontSize: 28, lineHeight: 34, letterSpacing: -0.56, color: C.ink, marginTop: 14 }, weight(800)]}>
        Visit saved
      </Text>

      <View
        accessible
        accessibilityLabel={[c?.name, picked.label, spent ? spent + ' in the shop' : null].filter(Boolean).join(' · ')}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {c?.name ? chip(c.name) : null}
        {chip(picked.label, 'tick')}
        {spent ? chip(spent, 'clock') : null}
      </View>

      <View style={{ marginTop: 16, backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 4 }}>
        {/* One after another, under the tick. Keyed on the sentence, so the
            manager line settles in again the moment the outbox drains and it
            turns from amber to green — that line changing IS news. The icon's
            colour carries the difference: green done, amber saved but not
            finished yet. */}
        {items.map((s, i) => (
          <Stagger key={s.l} index={i}>
            <View
              accessible
              accessibilityLabel={s.l + (s.ok ? ', done' : ', not finished yet')}
              style={{
                minHeight: 46,
                paddingVertical: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.hairline,
              }}>
              <Icon name={s.icon} size={18} color={s.ok ? C.success : C.warnInk} strokeWidth={2.2} />
              <Text style={{ fontSize: 14, lineHeight: 19, color: C.ink, flex: 1 }}>{s.l}</Text>
            </View>
          </Stagger>
        ))}
      </View>
    </AppFrame>
  );
}
