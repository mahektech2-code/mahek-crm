import React from 'react';
import { View, Pressable, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import {
  pickCandidates,
  pickShops,
  pickedFor,
  planDay,
  type Candidate,
  type PlanDay,
} from '../src/data/journey';
import { dayLabel, inr, isoDate, plural } from '../src/lib/format';
import { daysSince } from '../src/data/customers';
import { pickOrigin } from '../src/engines/route';
import { haversineMetres } from '../src/engines/geo';
import { ShopMap } from '../src/components/ui/shop-map';
import { useStore } from '../src/state/store';

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
  const params = useLocalSearchParams<{ day?: string }>();
  const planDayId = typeof params.day === 'string' ? params.day : '';
  const notify = useStore((s) => s.notify);

  const [day, setDay] = React.useState<PlanDay | null>(null);
  const [rows, setRows] = React.useState<Candidate[]>([]);
  const [total, setTotal] = React.useState(0);
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
  const [picked, setPicked] = React.useState<string[]>([]);
  const [q, setQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  /* The same two ways of looking at the same list the customers screen offers.
     The tap means something different HERE — it picks a stop rather than opening
     a record — and that difference lives in this caller rather than in the map. */
  const [asMap, setAsMap] = React.useState(false);
  const [today] = React.useState(() => isoDate(new Date()));
  /* The freshest fix already known, which costs no battery and no wait —
     `whereNow` never asks the radio. Null is ordinary and handled: see
     `pickOrigin`, which then measures from the city instead. */
  const [fix, setFix] = React.useState<{ lat: number; lng: number } | null>(null);

  React.useEffect(() => {
    let live = true;
    void import('../src/native/where')
      .then((m) => m.whereNow())
      .then((w) => {
        if (live && w?.lat != null && w?.lng != null) setFix({ lat: w.lat, lng: w.lng });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const d = await planDay(planDayId);
      if (!live) return;
      setDay(d);
      /* Whatever was picked before, so reopening the screen is a correction
         rather than starting again. */
      setPicked(await pickedFor(planDayId));
    })();
    return () => {
      live = false;
    };
  }, [planDayId]);

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
    let live = true;
    setLoading(true);
    void pickCandidates(day?.city ?? null, q, pickedRef.current, {
      forToday: day?.planDate === today,
      fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
    }).then((r) => {
      if (!live) return;
      setRows(r.rows);
      /* The count the cap sentence reads. Lost in a merge once — without it
         `total` stays 0, `total > rows.length` is never true, and a capped list
         silently stops saying it is capped. */
      setTotal(r.total);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [day?.city, day?.planDate, today, fix, q]);

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  const save = async () => {
    setSaving(true);
    const out = await pickShops(planDayId, picked);
    setSaving(false);
    if (!out.ok) return notify(out.message ?? 'Pick at least one shop.');
    notify(plural(picked.length, 'shop') + ' picked. Your manager can see the day now.');
    router.back();
  };

  /* The same origin the sort used, so the numbers on screen and the order they
     are in cannot disagree — measured once here rather than recomputed per row. */
  const origin = React.useMemo(
    () =>
      pickOrigin({
        fix,
        forToday: day?.planDate === today,
        cityShops: rows
          .filter((r) => r.gpsLat != null && r.gpsLng != null)
          .map((r) => ({ lat: r.gpsLat as number, lng: r.gpsLng as number })),
      }),
    [fix, day?.planDate, today, rows],
  );

  const away = React.useCallback(
    (c: Candidate): string => {
      if (c.gpsLat == null || c.gpsLng == null) return 'no pin';
      if (!origin) return '';
      const m = haversineMetres(origin, { lat: c.gpsLat, lng: c.gpsLng });
      return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
    },
    [origin],
  );

  if (!day) {
    return (
      <AppFrame title="Pick your shops" contentStyle={{ padding: 16 }}>
        <T s="small" style={{ color: C.muted }}>
          That day is not on this handset. Pull down on the route screen to fetch it.
        </T>
      </AppFrame>
    );
  }

  const here = (day.city ?? '').trim().toLowerCase();


  return (
    <AppFrame
      title={'Pick your shops'}
      contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}
      /*
       * The save bar is the FRAME's, not a floating view of this screen's own.
       *
       * It was `position: absolute, bottom: 20` inside the frame's scroll
       * area — and an absolute child of a ScrollView's content container is
       * positioned against the CONTENT, not the window. So the button was not
       * pinned to anything: it sat twenty points above the end of the list,
       * which on the whole customer book meant thousands of rows below the
       * fold. The one control that saves the day was the last thing on the
       * screen you could reach, and the comment above it said it was fixed to
       * the bottom. `footer` is the frame's own pinned bar — the visit screen
       * has used it for its save bar since it was written.
       */
      footer={
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 10,
            gap: 8,
            backgroundColor: C.canvas,
            borderTopWidth: 1,
            borderTopColor: C.hairline,
          }}>
          <PrimaryButton
            label={
              saving
                ? 'Sending…'
                : picked.length
                  ? 'Plan the day · ' + plural(picked.length, 'shop')
                  : 'Pick at least one shop'
            }
            fullWidth
            disabled={saving || picked.length === 0}
            onPress={() => void save()}
          />
          <SecondaryButton label="Not now" fullWidth onPress={() => router.back()} />
        </View>
      }>
      <View
        style={{
          backgroundColor: C.surface,
          borderRadius: radius.card,
          borderLeftWidth: 3,
          borderLeftColor: C.primary,
          padding: 14,
          marginBottom: 12,
          boxShadow: shadow.card,
        }}>
        <T style={[type.body, weight(600), { color: C.ink }]}>{dayLabel(day.planDate)}</T>
        <T s="small" style={{ color: C.body, marginTop: 2 }}>
          {day.city ? day.city + ' — you agreed this day' : 'You agreed this day'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 6 }}>
          Tick them in the order you mean to walk them. You can change the order on the morning,
          from wherever you actually are.
        </T>
      </View>

      <View style={{ position: 'relative', marginBottom: 10 }}>
        <View style={{ position: 'absolute', left: 14, top: 16, zIndex: 1 }}>
          <Icon name="search" size={20} color={C.muted} strokeWidth={1.5} />
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search a shop, an area, a city"
          placeholderTextColor={C.muted}
          style={{
            height: 48,
            paddingLeft: 44,
            paddingRight: 14,
            borderRadius: radius.card,
            backgroundColor: C.surface,
            color: C.ink,
            fontSize: 15,
            boxShadow: shadow.card,
          }}
        />
      </View>

      {/* LIST OR MAP. On a day in one city the map is often the faster way to
          choose: the shops are a walk apart and their arrangement is the plan.
          A tap PICKS rather than opens — the number on a picked row is where it
          sits in the day, and the map shows the same state filled in. */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        {([
          { key: false, label: 'List' },
          { key: true, label: 'Map' },
        ] as const).map((chip) => {
          const on = asMap === chip.key;
          return (
            <Pressable
              key={String(chip.key)}
              onPress={() => setAsMap(chip.key)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: on ? C.ink : C.border,
                backgroundColor: on ? C.ink : C.surface,
              }}>
              <T style={[{ fontSize: 13, color: on ? C.surface : C.body }, weight(500)]}>
                {chip.label}
              </T>
            </Pressable>
          );
        })}
      </View>

      {asMap ? (
        <ShopMap
          height={440}
          pins={rows.map((c) => ({
            id: c.id,
            name: c.name,
            lat: c.gpsLat ?? NaN,
            lng: c.gpsLng ?? NaN,
            picked: picked.includes(c.id),
          }))}
          onPress={(pin) => toggle(pin.id)}
        />
      ) : (
        /* No inner ScrollView. The frame already scrolls, and a vertical one
           nested in another has no height of its own to scroll within — it grew
           to its content and handed the gesture back, which is why the list read
           as one long page rather than a pane. */
        <View>
          {rows.length === 0 ? (
          <T s="small" style={{ color: C.muted, paddingVertical: 24, textAlign: 'center' }}>
            {loading
              ? 'Looking…'
              : q
                ? 'No shop matches that.'
                : 'There are no shops on this handset yet — pull down on the route screen to fetch your book.'}
          </T>
        ) : null}

        {rows.map((c) => {
          const at = picked.indexOf(c.id);
          const on = at >= 0;
          const gap = daysSince(c.lastVisitDate, today);
          const elsewhere = !!here && (c.city ?? '').trim().toLowerCase() !== here;
          /* The city only where it DIFFERS from the day's — repeating
             "bengaluru" on forty rows of a bengaluru day says nothing, and
             the right-hand "elsewhere" tag already carries the exception. */
          const area = [c.area, elsewhere ? c.city : null].filter(Boolean).join(' · ');

          return (
            <Pressable
              key={c.id}
              onPress={() => toggle(c.id)}
              hitSlop={HIT}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                backgroundColor: C.surface,
                borderRadius: radius.card,
                padding: 14,
                marginBottom: 8,
                borderWidth: on ? 1 : 0,
                borderColor: on ? C.primary : 'transparent',
                boxShadow: shadow.card,
              }}>
              {/* The number, not a tick: where it sits in the day is the thing
                  that is being decided, and a tick would hide it.

                  Unticked it draws a faint `+` rather than nothing. An empty
                  grey circle on every row of a fresh book read as a broken
                  avatar or a control still loading — nothing about it said
                  "tap this to add the shop", which is the only thing this
                  screen asks anybody to do. */}
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: on ? 0 : 1,
                  borderColor: C.border,
                  backgroundColor: on ? C.primary : C.canvas,
                }}>
                {on ? (
                  <T style={[type.small, weight(600), { color: '#fff' }]}>{String(at + 1)}</T>
                ) : (
                  <Icon name="add" size={16} color={C.muted} strokeWidth={1.8} />
                )}
              </View>

              <View style={{ flex: 1 }}>
                <T style={[type.body, weight(on ? 600 : 500), { color: C.ink }]} numberOfLines={1}>
                  {c.name}
                </T>
                {/* Dropped where there is nothing to say. On this book almost
                    no shop has an area, so every row carried an identical
                    third line of "No area recorded" — three lines of which two
                    were boilerplate, and the shop's own name lost among them.
                    An absent area is not a fact worth a line each time. */}
                {area ? (
                  <T s="small" style={{ color: C.muted, marginTop: 2 }} numberOfLines={1}>
                    {area}
                  </T>
                ) : null}
                <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                  {gap == null
                    ? 'Never visited'
                    : gap === 0
                      ? 'Visited today'
                      : 'Last seen ' + plural(gap, 'day') + ' ago'}
                  {/* `inr` takes RUPEES — see its own note. Handed paise it
                      reported ₹2,36,000 owing against a bill of ₹2,360, on a
                      row somebody decides a morning from. */}
                  {c.outstandingPaise > 0 ? ' · ' + inr(c.outstandingPaise / 100) + ' owing' : ''}
                </T>
              </View>

              {/* The distance, because "nearest first" that does not say the
                  distances is an order somebody has to take on trust. A shop
                  with no pin says so rather than showing nothing: it sorts last,
                  and the reason it does is worth one word. */}
              <T s="small" style={{ color: C.muted }}>
                {away(c)}
              </T>
            </Pressable>
          );
        })}
          {/*
            What the list is a slice OF.
            A capped list that counts itself is how a screen reports sixty shops
            on a book of five thousand and says nothing about the rest. The way
            past it is the search box above, so the sentence names it.

            Inside the LIST branch: the map draws every pin it is given and is
            not capped by the same read, so a count of what was left out belongs
            with the list it was left out of.
          */}
          {total > rows.length ? (
            <T s="small" style={{ color: C.muted, paddingVertical: 14, textAlign: 'center' }}>
              {rows.length + ' of ' + total + ' shops — search for one that is not here'}
            </T>
          ) : null}
        </View>
      )}
    </AppFrame>
  );
}
