import React from 'react';
import { View, Pressable, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Input, T } from '../src/components/ui/primitives';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { color as C, weight } from '../src/theme/tokens';
import { Pill, PillButton } from '../src/components/ui/v3';
import {
  pickCandidates,
  pickShops,
  pickedFor,
  planDay,
  type Candidate,
  type PlanDay,
} from '../src/data/journey';
import { dayLabel, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { daysSince } from '../src/data/customers';
import { haversineMetres } from '../src/engines/geo';
import { ShopMap } from '../src/components/ui/shop-map';
import { useStore } from '../src/state/store';
import { Pop, PressableScale, Stagger } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';

/**
 * Picking the shops for a day you have agreed.
 *
 * The other half of the negotiation, and the half that was missing. The office
 * proposes a city; you pick the doors, because you are the one who knows which
 * of them are worth a Tuesday morning. Until this screen existed you could
 * agree to a day and then had no way to fill it, so the office arranged the
 * stops — which is still available to them, as the exception it should be.
 *
 * **The order you tick is the order you walk.** No optimiser here: reordering
 * lives on the route screen and runs against where you actually are on the
 * morning, which is not knowable the evening before. The number on each ticked
 * row says where it sits, so the list is the plan rather than a set.
 *
 * **The agreed city is a HARD FILTER**, on Mahek's instruction. It used to rise
 * to the top without filtering, on the reasoning that a man going to Nagpur
 * often has one call to make on the way — that reasoning was not wrong, it was
 * overruled: a day is a city, and the call on the road is added from the
 * customers list or made unplanned with a deviation reason, which is what that
 * field exists for.
 *
 * **Nearest sorts first**, also on instruction, and it replaced "who you have
 * not seen longest". Both answer real questions; a man filling a Tuesday
 * morning in one town is choosing a walking order, and distance is what he is
 * deciding on.
 *
 * **What it is measured FROM is the part worth knowing.** For today it is where
 * he is standing. For any other day it is the middle of our shops in that city,
 * because he picks tomorrow's doors at home — and sorting Wardha by distance
 * from a sofa in Nagpur puts the list very nearly upside down. With neither, it
 * keeps the old order rather than inventing a point.
 *
 * **The list is CAPPED and the save bar is pinned to the frame.** Those two
 * are the same bug from either end: the read had no LIMIT, so a book of
 * thousands rendered as thousands of cards, and the save bar was
 * `position: absolute` inside the frame's scroll area — which positions
 * against the CONTENT rather than the window. The one control that saves the
 * day sat below every row, and its own comment claimed it was fixed to the
 * bottom.
 *
 * **Also: the day is named, and the money is in rupees.** The card printed the
 * raw `2026-09-09` while the route screen one tap away said `Wed 9 Sep`, and
 * `inr` — which takes rupees — was handed paise, so a shop owing ₹2,360 was
 * listed as owing ₹2,36,000. */
export default function PickScreen() {
  const params = useLocalSearchParams<{ day?: string; fresh?: string }>();
  const planDayId = typeof params.day === 'string' ? params.day : '';
  /* "Start over" from the day's sheet: the same screen, nothing ticked. The
     old picks stand until Plan the day is pressed, so backing out loses
     nothing. */
  const fresh = params.fresh === '1';
  const notify = useStore((s) => s.notify);
  /* Every other sub-screen draws the chevron and a link naming where it goes
     back to. This one had neither, so its only exit was a footer button reading
     "Not now" — which sounds like it throws away the twelve shops just ticked,
     and is the reason somebody hesitates over the only way off the screen. */
  const back = useCameFrom('journey');

  const [day, setDay] = React.useState<PlanDay | null>(null);
  /*
   * THE SAME BUG AS THE LIST BELOW, on the branch that takes the whole screen.
   *
   * `day` is null until an effect fills it, so the FIRST PAINT of every visit
   * rendered "That day is not on this handset" — the one sentence that sends
   * somebody back to the Journey tab to fetch a day that was never missing.
   * Not a flicker either: it draws inside the frame's `Appear`, so it fades in
   * and is read. Still looking, genuinely not here, and could not be read are
   * three answers, exactly as they are for the rows.
   */
  const [dayLoading, setDayLoading] = React.useState(true);
  const [dayFailed, setDayFailed] = React.useState(false);
  /** Bumped by the retry on that branch. Its own, deliberately: `attempt` below
      re-reads the list, and re-reading the DAY re-reads what was picked, which
      would take back ticks somebody had just made. Reachable only where there
      is no day, so there are none. */
  const [dayAttempt, setDayAttempt] = React.useState(0);
  const [rows, setRows] = React.useState<Candidate[]>([]);
  const [total, setTotal] = React.useState(0);
  /* The point the distances on the rows are measured from, as the READ used
     it. Derived here once, it was the centroid of whatever had just come back
     — so typing in the search box moved the origin and the figure against an
     untouched shop changed with it. It comes back from `pickCandidates` now,
     which is also what orders the page, so the numbers and the order they are
     in cannot disagree. */
  const [origin, setOrigin] = React.useState<{ lat: number; lng: number } | null>(null);
  /*
   * AN EMPTY LIST MEANS THREE DIFFERENT THINGS, and it said two.
   *
   * Before the read resolves `rows` is `[]`, so the screen opened on "There
   * are no customers on this handset yet" for a frame or two — which is the
   * worst of the three sentences to show wrongly, because an empty book is a
   * real failure this app has actually had and that is exactly how it reads.
   * Still looking, nothing matched, and nothing here are three answers.
   */
  const [loading, setLoading] = React.useState(true);
  /* A read that threw. Without it the `.then` never ran, `loading` stayed true
     and the screen said "Looking…" for ever — which reads as a broken handset
     and leaves nothing on the screen to press. */
  const [readFailed, setReadFailed] = React.useState(false);
  const [picked, setPicked] = React.useState<string[]>([]);
  /* What the day held when the screen opened. Emptying a day that HAD shops
     is a real answer — the day goes back to agreed — so the button stays live
     for it; on a day with nothing picked yet, nothing is not an answer. */
  const [hadPicks, setHadPicks] = React.useState(false);
  const [q, setQ] = React.useState('');
  /*
   * WHAT THE READ SEARCHES FOR, a beat behind what he is typing.
   *
   * Every character used to fire a `COUNT(*)` and a leading-wildcard `LIKE`
   * over the whole book, then a haversine sort of the answer. On a mid-range
   * phone with a few thousand shops the field lags behind the thumb — which is
   * the friction the cap on this list exists to avoid, arriving from the other
   * end. `q` is what the box shows; this is what SQLite is asked.
   */
  const [search, setSearch] = React.useState('');
  /** Bumped by the retry, so a failed read has something to press. */
  const [attempt, setAttempt] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  /* The same two ways of looking at the same list the customers screen offers.
     The tap means something different HERE — it picks a stop rather than opening
     a record — and that difference lives in this caller rather than in the map. */
  const [asMap, setAsMap] = React.useState(false);
  const [today] = React.useState(() => isoDate(new Date()));
  /* A fix no older than the office calls fresh — `measureFrom` refuses
     yesterday's last shop rather than sorting today around it. Null is
     ordinary and handled: see `pickOrigin`, which then measures from the city
     instead. */
  const [fix, setFix] = React.useState<{ lat: number; lng: number } | null>(null);

  React.useEffect(() => {
    let live = true;
    void import('../src/native/where')
      .then((m) => m.measureFrom())
      .then((w) => {
        if (live && !('reason' in w)) setFix({ lat: w.lat, lng: w.lng });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    let live = true;
    setDayLoading(true);
    setDayFailed(false);
    void (async () => {
      try {
        const d = await planDay(planDayId);
        if (!live) return;
        setDay(d);
        /* Whatever was picked before, so reopening the screen is a correction
           rather than starting again. */
        const before = await pickedFor(planDayId);
        if (!live) return;
        setHadPicks(before.length > 0);
        setPicked(fresh ? [] : before);
      } catch {
        if (live) setDayFailed(true);
      } finally {
        if (live) setDayLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [planDayId, dayAttempt, fresh]);

  /*
   * The ticked ids go INTO the read, not just out of it.
   *
   * The list is capped, so a shop picked and then searched past has to come
   * back with its number intact — `pickCandidates` reads those by id whatever
   * the page or the search would have shown. `picked` is deliberately not a
   * dependency: re-reading the whole list on every tick would reorder the rows
   * under the finger doing the ticking.
   */
  const pickedRef = React.useRef<string[]>([]);
  pickedRef.current = picked;

  React.useEffect(() => {
    const t = setTimeout(() => setSearch(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setReadFailed(false);
    void pickCandidates(day?.city ?? null, search, pickedRef.current, {
      forToday: day?.planDate === today,
      fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
    })
      .then((r) => {
        if (!live) return;
        setRows(r.rows);
        /* The count the cap sentence reads. Lost in a merge once — without it
           `total` stays 0, `total > rows.length` is never true, and a capped list
           silently stops saying it is capped. */
        setTotal(r.total);
        setOrigin(r.origin);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setLoading(false);
        setReadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [day?.city, day?.planDate, today, fix, search, attempt]);

  /* A tick for every shop added or taken off — the thumb is choosing doors
     one after another, often without looking, and the tick is what says each
     one landed. The map's pins go through the same function, so they tick too. */
  const toggle = (id: string) => {
    feedback('select');
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  };

  /* The write is local first, so it fails only where SQLite itself does — and
     when it did, `saving` stayed true for good and the one control on the
     screen read "Sending…" and was disabled. A dead end on the screen's only
     action. `finally` is what makes the button come back. */
  const save = async () => {
    setSaving(true);
    try {
      const out = await pickShops(planDayId, picked);
      if (!out.ok) return notify(out.message ?? 'Pick at least one shop.', 'error');
      notify(
        picked.length
          ? plural(picked.length, 'shop') + ' picked. Your manager can see the day now.'
          : 'The day is cleared. Pick shops again when you know where you are going.',
      );
      router.back();
    } catch {
      notify('The day could not be saved on this phone. Nothing is lost. Try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const away = React.useCallback(
    (c: Candidate): string => {
      if (c.gpsLat == null || c.gpsLng == null) return 'no location';
      if (!origin) return '';
      const m = haversineMetres(origin, { lat: c.gpsLat, lng: c.gpsLng });
      return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
    },
    [origin],
  );

  if (!day) {
    return (
      <AppFrame title="Pick your shops" onBack={back.go} contentStyle={{ paddingHorizontal: 14, paddingTop: 16 }}>
        {dayFailed ? (
          <View style={errorBox}>
            <Icon name="warn" size={20} color={C.danger} strokeWidth={2} />
            <T style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.danger }, weight(600)]}>
              The day could not be read off this phone.
            </T>
            <PillButton label="Try again" variant="white" height={44} onPress={() => setDayAttempt((a) => a + 1)} />
          </View>
        ) : (
          <View style={noteBox}>
            <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>
              {dayLoading
                ? 'Looking…'
                : /* "The route screen" is not a thing anybody can find: the tab is
                     labelled Journey, and a sentence that names a screen by a word
                     nowhere on the app sends him looking for it. */
                  'That day is not on this phone. Pull down on the Journey tab to get it.'}
            </T>
          </View>
        )}
      </AppFrame>
    );
  }

  const here = (day.city ?? '').trim().toLowerCase();
  const capLine = total > rows.length ? rows.length + ' of ' + total + ' · search for the rest' : null;

  const hero = (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 }}>
        <Icon name="cal" size={14} color={C.lavenderMuted} strokeWidth={2} />
        <T style={[{ flexShrink: 1, fontSize: 13, color: C.lavenderMuted }, weight(700)]}>{dayLabel(day.planDate) + ' · agreed'}</T>
      </View>
      <Text
        accessibilityRole="header"
        accessibilityLabel={'Pick shops. ' + (day.city ? day.city + ' · ' : '') + 'you agreed this day'}
        style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: C.lavenderInk }, weight(800)]}>
        {'Pick shops' + (day.city ? ' · ' + day.city : '')}
      </Text>
      <T style={{ fontSize: 13, lineHeight: 18, color: C.lavenderMuted, marginTop: 2 }}>
        Tick in walking order. Reorder on the day.
      </T>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
        {/*
          THE DESIGN'S OWN BOX. It was a raw `TextInput` with Android's
          autocapitalise and autocorrect both on — which fights a transliterated
          shop name character by character. There is a ×, because backspacing a
          wrong search one key at a time is the friction this screen is capped
          to avoid.
        */}
        <View
          style={{
            flex: 1,
            minHeight: 52,
            paddingVertical: 4,
            borderRadius: 26,
            backgroundColor: C.surface,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingLeft: 16,
            paddingRight: 6,
          }}>
          <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
          <View style={{ flex: 1 }}>
            <Input
              value={q}
              onChangeText={setQ}
              accessibilityLabel="Search a shop, an area, a city"
              placeholder="Shop, area, city"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{ borderWidth: 0, minHeight: 48, paddingHorizontal: 0, backgroundColor: 'transparent', fontSize: 15 }}
            />
          </View>
          {q ? (
            <Pressable
              onPress={() => setQ('')}
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
              hitSlop={4}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.wash, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="close" size={16} color={C.muted} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
        {/* LIST OR MAP. On a day in one city the map is often the faster way to
            choose: the shops are a walk apart and their arrangement is the
            plan. A tap PICKS rather than opens. Two 44 round buttons that
            announce themselves, so a one-handed tap lands and a screen reader
            hears which view it is. */}
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: 'row', gap: 2, padding: 4, borderRadius: 26, backgroundColor: C.surface }}>
          {([
            { key: false, label: 'List', icon: 'grid' },
            { key: true, label: 'Map', icon: 'map' },
          ] as const).map((v) => {
            const on = asMap === v.key;
            return (
              <Pressable
                key={v.label}
                accessibilityRole="tab"
                accessibilityLabel={v.label}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  if (!on) feedback('select');
                  setAsMap(v.key);
                }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? C.navy : 'transparent',
                }}>
                <Icon name={v.icon} size={18} color={on ? C.lime : C.muted} strokeWidth={2} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );

  return (
    <AppFrame
      title={'Pick your shops'}
      onBack={back.go}
      showTitle={false}
      hero={hero}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 24 }}
      /*
       * The save bar is the FRAME's, not a floating view of this screen's own.
       *
       * It was `position: absolute, bottom: 20` inside the frame's scroll
       * area — and an absolute child of a ScrollView's content container is
       * positioned against the CONTENT, not the window. So the button sat
       * twenty points above the end of the list, which on the whole customer
       * book meant thousands of rows below the fold. `footer` is the frame's
       * own pinned bar.
       */
      footerBg={C.canvas}
      footerInsetBg={C.navy}
      footer={
        <View
          style={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: 16,
            backgroundColor: C.navy,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
          }}>
          <T style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: '#FFFFFF' }, weight(800)]}>
            {plural(picked.length, 'shop')}
          </T>
          <T style={{ marginTop: 4, fontSize: 13, lineHeight: 18, color: C.onNavyMuted }}>
            {picked.length
              ? 'Your manager sees the day'
              : hadPicks
                ? 'Nothing ticked. Saving clears the day'
                : 'Tick at least one to plan the day'}
          </T>
          <PillButton
            label={
              saving
                ? 'Sending…'
                : picked.length
                  ? 'Plan the day'
                  : hadPicks
                    ? 'Clear the day'
                    : 'Pick at least one shop'
            }
            a11y={picked.length && !saving ? 'Plan the day · ' + plural(picked.length, 'shop') : undefined}
            variant="lime"
            height={56}
            disabled={saving || (picked.length === 0 && !hadPicks)}
            onPress={() => void save()}
            style={{ marginTop: 12 }}
          />
        </View>
      }>
      {asMap ? (
        <View>
          <ShopMap
            height={440}
            pins={rows.map((c) => ({
              id: c.id,
              name: c.name,
              lat: c.gpsLat ?? NaN,
              lng: c.gpsLng ?? NaN,
              picked: picked.includes(c.id),
              /* The visiting order, so a picked pin carries its number. */
              order: picked.includes(c.id) ? picked.indexOf(c.id) + 1 : null,
            }))}
            onPress={(pin) => toggle(pin.id)}
          />
          {/*
            What this screen is a slice OF — in BOTH views. The map is handed the
            same `rows`, the same capped page, and on the map the ARRANGEMENT of
            the pins is the plan, so laying out a morning over a town with most
            of it missing has to be said on the map itself.
          */}
          {capLine ? (
            <View pointerEvents="none" style={{ position: 'absolute', left: 12, top: 12 }}>
              <Pill text={capLine} bg={C.navy} fg="#FFFFFF" />
            </View>
          ) : null}
          <View pointerEvents="none" style={{ position: 'absolute', left: 12, bottom: 12 }}>
            <Pill text="Tap a pin to pick · no-pin shops not drawn" bg={C.surface} fg={C.body} />
          </View>
        </View>
      ) : (
        /* No inner ScrollView. The frame already scrolls, and a vertical one
           nested in another has no height of its own to scroll within. */
        <View style={{ gap: 8 }}>
          {rows.length === 0 && readFailed ? (
            /* A READ THAT FAILED IS NOT AN EMPTY BOOK. Said plainly, with the
               one thing to press. */
            <View style={errorBox}>
              <Icon name="warn" size={20} color={C.danger} strokeWidth={2} />
              <T style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.danger }, weight(600)]}>
                The shop list could not be read off this phone.
              </T>
              <PillButton label="Try again" variant="white" height={44} onPress={() => setAttempt((a) => a + 1)} />
            </View>
          ) : rows.length === 0 ? (
            <View style={noteBox}>
              <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>
                {/* `search` lags `q` by the debounce, so a keystroke ahead of the
                    read must still read as "looking". */}
                {loading || q !== search
                  ? 'Looking…'
                  : q
                    ? 'No shop matches that.'
                    : day.city
                      ? 'None of your shops on this phone are in ' + day.city + '. A shop elsewhere can be visited from the Customers tab.'
                      : 'No shops on this phone yet. Pull down on the Journey tab to get your shops.'}
              </T>
            </View>
          ) : null}

          {rows.map((c, i) => {
            const at = picked.indexOf(c.id);
            const on = at >= 0;
            const gap = daysSince(c.lastVisitDate, today);
            const elsewhere = !!here && (c.city ?? '').trim().toLowerCase() !== here;
            /* The city only where it DIFFERS from the day's — repeating
               "bengaluru" on forty rows of a bengaluru day says nothing. An
               elsewhere shop gets the amber tag instead. */
            const area = [c.area, elsewhere ? c.city : null].filter(Boolean).join(' · ');
            const seen =
              gap == null ? 'Never visited' : gap === 0 ? 'Visited today' : 'Last seen ' + plural(gap, 'day') + ' ago';
            const dist = away(c);

            return (
              <Stagger key={c.id} index={i}>
                <PressableScale
                  onPress={() => toggle(c.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={
                    (on ? 'Stop ' + (at + 1) + ', ' : 'Add ') +
                    c.name +
                    (area ? ', ' + area : '') +
                    ', ' +
                    seen +
                    (c.outstandingPaise > 0 ? ', ' + inrFromPaise(c.outstandingPaise) + ' outstanding' : '') +
                    (dist ? ', ' + dist : '')
                  }
                  /* NO HIT SLOP. It was `hitSlop={HIT}` on a card about 74dp tall
                     with 8 between rows, so two rows claimed the same band and a
                     tap on one shop's last line ticked the shop underneath — and
                     the number on the badge IS the walking order. The card is
                     past the 48dp floor on its own. */
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    backgroundColor: C.surface,
                    borderRadius: 20,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderWidth: 2,
                    borderColor: on ? C.primary : 'transparent',
                  }}>
                  {/* The number, not a tick: where it sits in the day is the thing
                      being decided. Unticked it draws a `+` — an empty circle read
                      as a broken avatar. It pops on whether it is picked, not on
                      its number: unticking renumbers every one after it. */}
                  <Pop trigger={on}>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: on ? C.primary : C.primaryTint,
                      }}>
                      {on ? (
                        <T style={[{ fontSize: 15, color: '#FFFFFF' }, weight(800)]}>{String(at + 1)}</T>
                      ) : (
                        <Icon name="add" size={18} color={C.primaryDeep} strokeWidth={2.2} />
                      )}
                    </View>
                  </Pop>

                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(on ? 700 : 600)]}>
                      {c.name}
                    </T>
                    {/* One line of facts. An absent area is not a fact worth
                        saying on every row of a book where almost none have one. */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, marginTop: 2 }}>
                      {area ? (
                        elsewhere ? (
                          <Pill text={area} bg={C.warnBg} fg={C.warnInk} height={20} />
                        ) : (
                          <Meta icon="visit" text={area} />
                        )
                      ) : null}
                      {gap === 0 ? (
                        <T style={[{ fontSize: 12, color: C.success }, weight(600)]}>Visited today</T>
                      ) : gap == null ? (
                        <T style={{ fontSize: 12, color: C.muted }}>Never visited</T>
                      ) : (
                        <Meta icon="clock" text={gap + ' d'} />
                      )}
                      {/* `inr` takes RUPEES. Handed paise it reported ₹2,36,000
                          owing against a bill of ₹2,360. */}
                      {c.outstandingPaise > 0 ? (
                        <Meta icon="wallet" text={inrFromPaise(c.outstandingPaise)} color={C.danger} bold />
                      ) : null}
                    </View>
                  </View>

                  {/* The distance, because "nearest first" that does not say the
                      distances is an order somebody has to take on trust. A shop
                      with no pin says so: it sorts last, and why is worth a word. */}
                  {c.gpsLat == null || c.gpsLng == null ? (
                    <Meta icon="visit" text="no pin" color={C.faint} bold />
                  ) : dist ? (
                    <T style={[{ fontSize: 13, color: C.ink }, weight(700)]}>{dist}</T>
                  ) : null}
                </PressableScale>
              </Stagger>
            );
          })}

          {capLine ? (
            <T style={[{ fontSize: 13, color: C.muted, paddingVertical: 8, textAlign: 'center' }, weight(600)]}>
              {capLine}
            </T>
          ) : null}
        </View>
      )}
    </AppFrame>
  );
}

/** A small icon-and-word fact on a row. */
function Meta({ icon, text, color = C.muted, bold = false }: { icon: IconName; text: string; color?: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Icon name={icon} size={12} color={color} strokeWidth={2} />
      <T numberOfLines={1} style={[{ fontSize: 12, color }, weight(bold ? 700 : 400)]}>
        {text}
      </T>
    </View>
  );
}

const noteBox = { backgroundColor: C.surface, borderRadius: 20, padding: 14 } as const;
const errorBox = {
  backgroundColor: C.dangerBg,
  borderRadius: 20,
  padding: 14,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
} as const;
