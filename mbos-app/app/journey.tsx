import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { abandonLeg, openLegOf, type TravelLeg } from '../src/data/travel';
import { legLine, travellingFor } from '../src/lib/travel-leg';
import { Badge, Card, DashedButton, Input, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { ActionSheet, BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { color as C, HIT, radius, shadow, type, weight, type BadgeTone } from '../src/theme/tokens';
import {
  createDay,
  agreeDay,
  planDays,
  refuseDay,
  saveStopOrder,
  stopCountsSince,
  todayStops,
  type JourneyStop,
  type PlanDay,
} from '../src/data/journey';
import { listTours, requestTour, type Tour } from '../src/data/requests';
import { getCustomer, type Customer } from '../src/data/customers';
import { getConfig } from '../src/data/config';
import { optimiseRoute } from '../src/engines/route';
import { fixOf, getFix } from '../src/native/location';
import { dayLabel, dayLabelRelative, dmy, inr, isoDate, plural } from '../src/lib/format';
import { openMaps, openRoute, shareText } from '../src/lib/messaging';
import { NavigateButton } from '../src/components/ui/navigate';
import { useBoot } from '../src/state/boot';
import { useStore } from '../src/state/store';

/**
 * The day's route.
 *
 * The pips are the day at a glance; the Next stop card is the only thing on
 * the screen that has to be read while walking. Everything below it is the
 * plan in order, and the dashed button at the bottom exists because the plan
 * is regularly wrong — going off it is allowed, and saying why is the price.
 *
 * Reordering runs `optimiseRoute` on the handset, offline, on straight-line
 * distance. A shop with no coordinate is appended and flagged, never dropped:
 * a stop missing from the day because a lat/long was never captured is a shop
 * nobody visits and nobody ever finds out why.
 */

/**
 * How long a proposal has been waiting on him, in words.
 *
 * Null where the office did not record when it asked — every plan written
 * before the negotiation existed is in that state, and "proposed 20,214 days
 * ago" from a null read as an epoch is worse than saying nothing.
 *
 * `now` is passed in rather than read here: this is called during render, and
 * the clock is state on the screen already. Reading `Date.now()` from inside
 * a render is what the React Compiler rules in this app forbid, and it also
 * meant this label was measured against a different instant from every other
 * figure on the screen.
 */
function waitingLabel(proposedAt: number | null, now: number): string | null {
  if (!proposedAt) return null;
  const days = Math.floor((now - proposedAt) / 86_400_000);
  if (days <= 0) return 'asked today';
  if (days === 1) return 'asked yesterday';
  return 'waiting ' + days + ' days';
}

export default function JourneyScreen() {
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  const set = useStore((s) => s.set);
  const askTravel = useStore((s) => s.askTravel);
  /* Still needed for the Continue button below: the leg is already open, so
     that path only prepares the visit screen — it does not ask again. */
  const beginVisit = useStore((s) => s.beginVisit);
  /* The reason typed for an off-plan stop, waiting for a shop to be chosen.
     Read here so the screen that TOOK it can show it is still pending and let
     it go — see the strip below. */
  const offPlanReason = useStore((s) => s.offPlanReason);
  const boot = useBoot();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [tourOpen, setTourOpen] = React.useState(false);
  const [tour, setTour] = React.useState({ from: '', to: '', cities: '', purpose: '', cost: '' });
  const [tourPick, setTourPick] = React.useState<'from' | 'to' | null>(null);
  const [tourErr, setTourErr] = React.useState<string | null>(null);
  const [tourBusy, setTourBusy] = React.useState(false);
  /* Starting a day, as against answering one. `own` is the form; the date
     defaults to nothing rather than to today, because a day planned by
     accident is worse than one not planned yet. */
  const [ownOpen, setOwnOpen] = React.useState(false);
  const [own, setOwn] = React.useState({ date: '', city: '' });
  const [ownPick, setOwnPick] = React.useState(false);
  const [ownErr, setOwnErr] = React.useState<string | null>(null);
  const [ownBusy, setOwnBusy] = React.useState(false);
  const [stops, setStops] = React.useState<JourneyStop[]>([]);
  /*
   * The journey he is on, if he is on one.
   *
   * Read from SQLite rather than from React state, because Android reaps this
   * app on the road constantly and a flag held in memory would be gone by the
   * time he arrived — with the departure photograph already taken and nothing
   * left to attach it to. Coming back to this screen and finding "On your way
   * to Sai Paint Depot · 14 min" is what tells him the app has not lost its
   * place.
   */
  const [leg, setLeg] = React.useState<TravelLeg | null>(null);
  const [days, setDays] = React.useState<PlanDay[]>([]);
  const [tours, setTours] = React.useState<Tour[]>([]);
  const [pastCounts, setPastCounts] = React.useState<Record<string, { total: number; done: number }>>({});
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const today = isoDate(new Date(now));
  /* A fortnight back, matching the server's own PLAN_HISTORY_DAYS — the two
     have to agree, or this screen would ask for history the pull never sent. */
  const historyFrom = isoDate(new Date(now - 15 * 86_400_000));

  const load = React.useCallback(() => {
    let live = true;
    void todayStops().then((r) => {
      if (live) setStops(r);
    });
    const uid = boot.session?.user.id;
    if (uid) {
      void openLegOf(uid).then((r) => {
        if (live) setLeg(r);
      });
    }
    /* The whole window — past and future both — read once and sliced below,
       rather than three separate reads that could disagree about "now". */
    void planDays(historyFrom).then((r) => {
      if (live) setDays(r);
    });
    void stopCountsSince(historyFrom).then((r) => {
      if (live) setPastCounts(r);
    });
    /* The answer to a tour request comes down the sync onto `tours.state`, and
       until now nothing read the row back — so he asked and never found out. */
    void listTours().then((r) => {
      if (live) setTours(r);
    });
    return () => {
      live = false;
    };
  }, [historyFrom, boot.session?.user.id]);

  useFocusEffect(load);

  /*
   * The days the office has asked about.
   *
   * A plan is AGREED, not issued: they propose a city, and you are the one who
   * knows whether that market is open on a Wednesday. Only the proposed ones
   * appear — a day already agreed is waiting on you to pick shops, and one
   * already planned is simply the route.
   */
  const asking = days.filter((d) => d.dayState === 'proposed' && d.planDate >= today);

  /*
   * The two live lists below are TODAY ONWARDS, and the filter is not a
   * tidiness point.
   *
   * The screen reads a fortnight back so it can show a history, and both of
   * these were reading that whole window — so a day agreed and never filled
   * three weeks ago sat in "shops to pick" for ever, offering a pick screen
   * for a morning that has already happened, and appeared a second time in
   * Recently saying nobody ever picked any. One day, two rows, one of them a
   * form for a day nobody can walk.
   */
  const toPick = days.filter((d) => d.dayState === 'agreed' && d.planDate >= today);
  const sentBack = days.filter((d) => d.dayState === 'refused' && d.planDate >= today);

  /*
   * Today's day, once it HAS been routed.
   *
   * `pickShops` moves the day to `planned` on this handset immediately, and
   * the stops behind it are minted by the office — they arrive on the next
   * pull. In between, today's plan was in none of the four lists on this
   * screen: not a question, not agreed, not "coming up" (that is strictly
   * after today) and not history. So somebody picked twelve shops, was told
   * the day was planned, came back here and read "0 of 0 done · Nothing
   * planned for today", with the day itself gone from the screen. Saying what
   * is actually true — picked, waiting for the office — is the whole fix; the
   * alternative is inventing stop rows the office has not issued.
   */
  /**
   * Start a day the office never proposed.
   *
   * Straight on to the shops afterwards. The day is `agreed` and empty, which
   * is the one state on this screen with nothing to walk — leaving him on the
   * Journey tab would mean reading his own new day back and tapping it, to get
   * where he was already going.
   */
  const startOwnDay = async () => {
    if (ownBusy) return;
    setOwnBusy(true);
    setOwnErr(null);
    const out = await createDay(own.date, own.city);
    setOwnBusy(false);

    if (!out.ok) return setOwnErr(out.message);

    setOwnOpen(false);
    setOwn({ date: '', city: '' });
    load();
    notify(dayLabel(own.date) + ' is yours. Pick the shops.');
    router.push({ pathname: '/pick', params: { day: out.id } });
  };

  const todayPlanned = days.find((d) => d.planDate === today && d.dayState === 'planned');

  /* Future days already routed — tomorrow's plan and beyond, distinct from
     "agreed, not yet picked" above. Without this a day picked three weeks
     ago had nowhere on this screen to be seen again until it became today. */
  const comingUp = days
    .filter((d) => d.dayState === 'planned' && d.planDate > today)
    .sort((a, b) => a.planDate.localeCompare(b.planDate));

  /* Everything before today, most recent first — what was asked, what was
     said, and for a planned day, how much of it actually happened. */
  const recent = days
    .filter((d) => d.planDate < today)
    .sort((a, b) => b.planDate.localeCompare(a.planDate));

  const say = React.useCallback(
    async (day: PlanDay, yes: boolean) => {
      if (yes) {
        await agreeDay(day.id);
        /* The SAME window the screen loaded with. `planDays()` defaults to
           today, so re-reading it bare threw away the fortnight of history
           underneath — answering one question emptied the Recently list. */
        setDays(await planDays(historyFrom));
        notify(dayLabel(day.planDate) + ' agreed. Pick your shops when you are ready.');
        return;
      }
      askConfirm({
        title: 'Not ' + dayLabel(day.planDate) + '?',
        body:
          (day.city ?? 'That day') +
          ' was proposed. Say why it will not work — without a reason your manager has nothing to go on, and the day stays unplanned. Name somewhere you would rather go if you have one.',
        reasonLabel: 'Why, and where instead',
        confirmLabel: 'Send it back',
        run: async (reason: string) => {
          const out = await refuseDay(day.id, reason);
          if (!out.ok) return notify(out.message ?? 'Say why it will not work.');
          setDays(await planDays(historyFrom));
          notify('Sent back to your manager.');
        },
      });
    },
    [askConfirm, notify, historyFrom],
  );

  const doneCount = stops.filter((x) => x.status === 'visited').length;
  const next = stops.find((x) => x.status === 'planned');
  /* A type GUARD rather than `filter(Boolean)` and a cast downstream: TS does
     not narrow on `Boolean`, and a cast across that gap is the shape of bug
     AGENTS.md names — the compiler stops looking exactly where the value is
     wrong. */
  const areas = Array.from(
    new Set(
      stops
        .filter((x) => x.status === 'planned')
        .map((x) => x.area)
        .filter((a): a is string => !!a),
    ),
  );

  /* Late against the plan, not against a constant — a stop whose planned time
     has passed and which has not been made yet is the definition of behind. */
  const late = !!next?.plannedAt && next.plannedAt < hhmm(now);

  /* Picked, and the office has not issued the stops back yet. See
     `todayPlanned` — it is the difference between "nothing planned" and
     "planned, not yet arrived", and only one of those two is true.
     The DAY rather than a boolean, so the two lines that read its city and
     its count narrow on it instead of asserting past it. */
  const awaitingRoute = stops.length === 0 ? todayPlanned : undefined;

  const reorder = async () => {
    /* Nothing to reorder is not an empty reorder. It toasted
       "Reordered · 0 km and 0 minutes on the plan", which is a confident
       answer to a question that was never askable. */
    if (!stops.some((x) => x.status === 'planned')) {
      return notify('There are no stops left to reorder today.');
    }
    const [speed, passes, maxStops, perStop] = await Promise.all([
      getConfig<number>('mbos.route.averageSpeedKmph', 22),
      getConfig<number>('mbos.route.maxTwoOptPasses', 4),
      getConfig<number>('mbos.route.maxStopsForTwoOpt', 40),
      getConfig<number>('mbos.route.minutesPerStop', 20),
    ]);
    /* Start from where he actually is. Without a fix the first stop in the
       list seeds the tour — a stated arbitrary rather than a pretend one. */
    const here = fixOf(await getFix({ accuracyThresholdM: await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100) }));
    const pending = stops.filter((x) => x.status === 'planned');

    const result = optimiseRoute(
      pending.map((s) => ({ id: s.id, coords: s.gpsLat != null && s.gpsLng != null ? { lat: s.gpsLat, lng: s.gpsLng } : null })),
      here ? { lat: here.lat, lng: here.lng } : null,
      { averageSpeedKmph: speed, maxTwoOptPasses: passes, maxStopsForTwoOpt: maxStops, minutesPerStop: perStop },
    );

    const done = stops.filter((x) => x.status !== 'planned').map((x) => x.id);
    await saveStopOrder([...done, ...result.ordered.map((leg) => leg.stop.id)]);
    load();
    notify(
      'Reordered · ' +
        Math.round(result.totalDistanceMetres / 100) / 10 +
        ' km and ' +
        Math.round(result.estimatedDayMinutes) +
        ' minutes on the plan' +
        (result.unlocated.length ? ' · ' + plural(result.unlocated.length, 'stop') + ' has no location' : ''),
    );
  };

  /*
   * Going somewhere that is not on the plan.
   *
   * It raised a toast — "Added off-plan · <reason>" — and wrote NOTHING. No
   * stop, no visit, no reason anywhere; the sentence on the button says "your
   * manager sees the reason" and no manager has ever seen one. `visits` has
   * carried `deviationReason` and `wasPlanned` from the day it was written and
   * `app/visit.tsx` sent a hardcoded null for the first.
   *
   * An off-plan stop IS a visit to a shop that is not on today's route, so
   * there is nothing to invent: the reason is taken here, the shop is chosen
   * on the Customers list — which already offers Visit on every row — and the
   * visit carries both. `wasPlanned` is already derived from whether the shop
   * turns out to be on the plan, so a shop that IS on it drops the reason
   * rather than filing an honest stop as a deviation.
   */
  const deviate = () =>
    askConfirm({
      title: 'Add an off-plan stop?',
      body: 'Say why, then pick the shop. The visit is recorded against today and marked off-plan, so your manager can see why the day changed.',
      reasonLabel: 'Why this stop · required',
      confirmLabel: 'Say why, then pick the shop',
      run: (reason) => {
        set({ offPlanReason: reason });
        notify('Now open the shop and press Visit — your reason goes with it.');
        router.push('/customers?from=journey');
      },
    });

  const sendTour = async () => {
    if (!tour.from || !tour.to) return setTourErr('Pick the dates you would be away.');
    if (!tour.purpose.trim()) return setTourErr('Say why — your manager decides on this alone.');

    setTourBusy(true);
    setTourErr(null);
    const cities = tour.cities.split(',').map((c) => c.trim()).filter(Boolean);
    const costRupees = Number(tour.cost.replace(/[^\d]/g, ''));
    const result = await requestTour({
      userId: boot.session?.user.id ?? '',
      startDate: tour.from,
      endDate: tour.to,
      cities,
      purpose: tour.purpose.trim(),
      estimatedCostPaise: costRupees > 0 ? costRupees * 100 : null,
    });
    setTourBusy(false);

    if (!result.ok) return setTourErr(result.message);
    setTourOpen(false);
    setTour({ from: '', to: '', cities: '', purpose: '', cost: '' });
    notify('Tour request sent to your manager · ' + dmy(tour.from) + ' to ' + dmy(tour.to));
  };

  return (
    <AppFrame title="Today’s route" activeTab="journey" contentStyle={{ padding: 16, paddingBottom: 24 }}>
      {/*
        The days you have been asked about, above today's route.
        Above, because a question somebody is waiting on you to answer outranks
        a list you already know — and because it is the only thing on this
        screen that goes away once you deal with it.
      */}
      {asking.length ? (
        <View style={{ marginBottom: 16 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            {asking.length === 1 ? 'A day to agree' : plural(asking.length, 'day') + ' to agree'}
          </T>
          {asking.map((d) => {
            /* Worked out once. It used to be called twice in one expression —
               and both calls read the clock, so the two halves of one sentence
               could be measured against different instants. */
            const waiting = waitingLabel(d.proposedAt, now);
            return (
            <View
              key={d.id}
              style={{
                backgroundColor: C.surface,
                borderRadius: radius.card,
                borderLeftWidth: 3,
                borderLeftColor: C.primary,
                padding: 14,
                marginBottom: 8,
                boxShadow: shadow.card,
              }}>
              <T style={[type.body, weight(600), { color: C.ink }]}>
                {dayLabelRelative(d.planDate, today)}
              </T>
              <T s="small" style={{ color: C.body, marginTop: 2 }}>
                {d.city ? d.city + ' was proposed' : 'A day was proposed'}
                {d.proposedBy ? ' by ' + d.proposedBy : ''}
                {/* HOW LONG IT HAS BEEN SITTING. The office is waiting on this
                    answer to plan a week, and "proposed" with no age reads as
                    something that arrived a moment ago — so a request four days
                    old looks identical to one from this morning, and gets the
                    same non-answer. */}
                {waiting ? ' · ' + waiting : ''}
              </T>
              <T s="small" style={{ color: C.muted, marginTop: 6 }}>
                You pick the shops once you agree — you know the city.
              </T>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <View style={{ flex: 1 }}>
                  <PrimaryButton label="Yes, that works" fullWidth onPress={() => void say(d, true)} />
                </View>
                <View style={{ flex: 1 }}>
                  <SecondaryButton label="Not that day" fullWidth onPress={() => void say(d, false)} />
                </View>
              </View>
            </View>
            );
          })}
        </View>
      ) : null}

      {/*
        Days you have agreed and not yet filled.

        Between the two states there is nothing to walk: the office knows you
        will be in Nagpur and does not know which doors. This is the only
        prompt that gets somebody from one to the other, so it sits directly
        under the questions rather than at the bottom of the screen.
      */}
      {toPick.length ? (
        <View style={{ marginBottom: 16 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            Agreed — shops to pick
          </T>
          {toPick
            .map((d) => (
              <Pressable
                key={d.id}
                onPress={() => router.push({ pathname: '/pick', params: { day: d.id } })}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  backgroundColor: C.surface,
                  borderRadius: radius.card,
                  padding: 14,
                  marginBottom: 8,
                  boxShadow: shadow.card,
                }}>
                <View style={{ flex: 1 }}>
                  <T style={[type.body, weight(600), { color: C.ink }]}>
                    {dayLabelRelative(d.planDate, today)}
                  </T>
                  <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                    {(d.city ? d.city + ' · ' : '') + 'no shops picked yet'}
                  </T>
                  {/* A day back here because the office REFUSED the pick has
                      to say so. Without it the card is identical to one nobody
                      has touched, and the salesman picks the same shops again
                      into the same refusal. */}
                  {d.syncState === 'rejected' ? (
                    <T s="small" style={{ color: C.warnInk, marginTop: 4 }}>
                      {d.syncMessage ?? 'The office did not accept the shops you picked.'}
                    </T>
                  ) : null}
                </View>
                <Icon name="forward" size={20} color={C.muted} strokeWidth={1.5} />
              </Pressable>
            ))}
        </View>
      ) : null}

      {/* Days already routed, beyond today — a picked plan for next Tuesday
          had nowhere to be seen again on this screen until it WAS Tuesday. */}
      {comingUp.length ? (
        <View style={{ marginBottom: 16 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            Coming up
          </T>
          {comingUp.map((d) => (
            <Pressable
              key={d.id}
              onPress={() => router.push({ pathname: '/pick', params: { day: d.id } })}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                backgroundColor: C.surface,
                borderRadius: radius.card,
                padding: 14,
                marginBottom: 8,
                boxShadow: shadow.card,
              }}>
              <View style={{ flex: 1 }}>
                <T style={[type.body, weight(600), { color: C.ink }]}>
                  {dayLabelRelative(d.planDate, today)}
                </T>
                <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                  {(d.city ? d.city + ' · ' : '') + plural(d.picked, 'shop') + ' picked'}
                </T>
              </View>
              <Icon name="forward" size={20} color={C.muted} strokeWidth={1.5} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* What you have already sent back, so a refusal does not vanish. */}
      {sentBack.length ? (
        <View style={{ marginBottom: 16 }}>
          {sentBack
            .map((d) => (
              <View
                key={d.id}
                style={{
                  backgroundColor: C.warnBg,
                  borderRadius: radius.card,
                  padding: 12,
                  marginBottom: 8,
                }}>
                <T s="small" style={{ color: C.warnInk }}>
                  {dayLabelRelative(d.planDate, today)} — sent back
                  {d.syncState === 'queued' ? ', waiting for signal' : ''}
                </T>
                {d.refusalReason ? (
                  <T s="small" style={{ color: C.body, marginTop: 2 }}>
                    “{d.refusalReason}”
                  </T>
                ) : null}
              </View>
            ))}
        </View>
      ) : null}

      {/*
        A day nobody proposed.

        Under the questions and the agreed days rather than above them: what
        the office has asked is the first thing to answer, and this is what to
        do when it has asked nothing. It is always drawn — a salesman whose
        manager plans nothing would otherwise find an empty tab with no way
        forward, which is exactly the case it exists for.
      */}
      <DashedButton
        label="Plan a day"
        onPress={() => {
          setOwn({ date: '', city: '' });
          setOwnErr(null);
          setOwnOpen(true);
        }}
        style={{ marginBottom: 16 }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ minWidth: 0, flex: 1 }}>
          <T style={type.h1}>
            {awaitingRoute
              ? plural(awaitingRoute.picked, 'shop') + ' picked'
              : doneCount + ' of ' + stops.length + ' done'}
          </T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {awaitingRoute
              ? (awaitingRoute.city ? awaitingRoute.city + ' · ' : '') +
                'sent to the office — the stops arrive on the next sync'
              : areas.length
                ? saidAsList(areas)
                : 'Nothing planned for today'}
          </T>
        </View>
        {/* `Icon name="dots"`, not the character `⋯`.
            A text ellipsis renders at whatever weight and baseline the font
            feels like, next to twenty controls drawn from the same stroked
            icon set — it read as a typo rather than a button. */}
        <Pressable
          onPress={() => setMoreOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Route actions"
          hitSlop={HIT}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? C.wash : 'transparent',
          })}>
          <Icon name="dots" size={22} color={C.body} strokeWidth={1.5} />
        </Pressable>
      </View>

      {/* Drawn only where there is a day to draw. At zero stops this was an
          empty 6pt row plus its margin — twenty points of nothing between the
          headline and whatever came next. */}
      {stops.length ? (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 14 }}>
          {stops.map((x) => (
            <View
              key={x.id}
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                backgroundColor:
                  x.status === 'visited' ? C.primary : next && x.id === next.id ? C.primaryEdge : C.hairline,
              }}
            />
          ))}
        </View>
      ) : null}

      {next ? (
        <View
          style={{
            backgroundColor: C.surface,
            borderWidth: 1,
            borderColor: C.primaryEdge,
            borderRadius: radius.card,
            boxShadow: shadow.nextStop,
            padding: 16,
            marginTop: 16,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary }} />
            <T
              style={[
                { fontSize: 12, lineHeight: 16, letterSpacing: 0.48, textTransform: 'uppercase', color: C.primaryDeep },
                weight(600),
              ]}>
              Next stop
            </T>
            <View style={{ flex: 1 }} />
            <T style={[{ fontSize: 13, color: late ? C.warn : C.success }, weight(500)]}>
              {late ? 'Running late' : 'On time'}
            </T>
          </View>
          <T style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.3, color: C.ink, marginTop: 10 }, weight(600)]}>
            {next.customerName}
          </T>
          {/* Only where there is one. An empty `<T>` still occupies its line
              height, so a shop with no area left a blank gap that read as a
              missing value rather than an absent one. */}
          {next.area ? (
            <T s="small" style={{ color: C.muted, marginTop: 2 }}>
              {next.area}
            </T>
          ) : null}
          <T s="small" style={{ marginTop: 10 }}>
            {(next.plannedAt ? 'Planned ' + next.plannedAt + '. ' : '') +
              (next.outstandingPaise > 0
                ? 'They owe ' + inr(next.outstandingPaise / 100) + ' — collection is the reason this stop is on the list.'
                : 'Nothing outstanding against them.')}
          </T>
          {/*
            ON THE ROAD, this card stops offering to start a journey and
            reports the one he is on.

            Two buttons both reading "Start visit" — one for the shop he is
            riding towards and one for the next stop — is how a second leg gets
            opened by accident, and opening one closes the first. So while a
            leg is running the card says where he is going, how long he has
            been going there, and gives him the two things he can actually do.
          */}
          {leg ? (
            <View style={{ marginTop: 14, gap: 10 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: C.primaryTint,
                  borderRadius: radius.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}>
                <Icon name="nav" size={18} color={C.primaryDeep} strokeWidth={1.8} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(600)]}>
                    {'On your way to ' + (leg.toLabel ?? 'the shop')}
                  </T>
                  <T style={{ fontSize: 12, lineHeight: 16, color: C.primaryDeep }}>
                    {legLine({
                      modeLabel: leg.modeKey,
                      odometerStartKm: null,
                      odometerEndKm: null,
                      ticketAmountPaise: null,
                    }) +
                      ' · ' +
                      travellingFor(leg.startedAt ?? Date.now(), now) +
                      (leg.odometerStartKm != null
                        ? ' · set off on ' + leg.odometerStartKm.toLocaleString('en-IN') + ' km'
                        : '')}
                  </T>
                </View>
              </View>
              {/*
                NAVIGATION SURVIVES THE DEPARTURE, which it did not until now.
                The Navigate button below is in the other arm of this ternary —
                the one that draws BEFORE he sets off — so pressing "Start
                visit" swapped this card in and took navigation away with it.
                It was offered at every moment except the one where somebody is
                actually on the road.
              */}
              <NavigateButton
                variant="button"
                lat={next.gpsLat}
                lng={next.gpsLng}
                name={leg.toLabel ?? next.customerName}
                city={next.area}
                style={{ marginTop: 12 }}
              />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                <SecondaryButton
                  label="Call it off"
                  onPress={() =>
                    askConfirm({
                      title: 'Not going after all?',
                      body:
                        'The trip stays on your record with the reason you give, measuring nothing — the meter has already moved, and a journey that vanished would leave the next one following on from a gap.',
                      reasonLabel: 'Why · required',
                      confirmLabel: 'Call off the trip',
                      run: (reason) => {
                        void abandonLeg(leg.id, reason).then(() => {
                          setLeg(null);
                          notify('Trip called off');
                        });
                      },
                    })
                  }
                  style={{ flex: 1, borderRadius: radius.xl }}
                />
                <PrimaryButton
                  label="Continue"
                  onPress={() => {
                    beginVisit(leg.customerId ?? next.customerId);
                    router.push('/visit');
                  }}
                  style={{ flex: 1, borderRadius: radius.xl }}
                />
              </View>
            </View>
          ) : (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <NavigateButton
              variant="button"
              lat={next.gpsLat}
              lng={next.gpsLng}
              name={next.customerName}
              city={next.area}
              style={{ flex: 1 }}
            />
            <PrimaryButton
              label="Start visit"
              /* Asks how he is getting there and takes the meter photograph
                 before anything opens — see `TravelGate`. */
              onPress={() =>
                askTravel({ customerId: next.customerId, customerName: next.customerName })
              }
              style={{ flex: 1, borderRadius: radius.xl }}
            />
          </View>
          )}
        </View>
      ) : null}

      {/* Guarded like the pips: an empty container still spends its top
          margin, and this screen's commonest state has nothing in it. */}
      {stops.length ? (
        <View style={{ marginTop: 20 }}>
          {stops.map((x, i) => {
            const isNext = !!next && x.id === next.id;
            const done = x.status === 'visited';
            const last = i === stops.length - 1;
            return (
              <View key={x.id} style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
                <View style={{ width: 28, alignItems: 'center' }}>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 1,
                      backgroundColor: done ? C.primaryTint : isNext ? C.primary : C.surface,
                      borderColor: done ? C.primaryEdge : isNext ? C.primary : C.border,
                    }}>
                    {done ? (
                      <Icon name="task" size={14} color={C.primaryDeep} strokeWidth={2.4} />
                    ) : (
                      <T style={[{ fontSize: 13, color: isNext ? C.surface : C.muted }, weight(600)]}>{String(i + 1)}</T>
                    )}
                  </View>
                  {last ? null : (
                    <View style={{ width: 2, flex: 1, minHeight: 12, backgroundColor: done ? C.primaryEdge : C.hairline }} />
                  )}
                </View>

                <Pressable
                  onPress={async () => {
                    /* A stop already walked answers with what happened; one still
                       ahead answers by opening the way to it. Both used to answer
                       with a toast. */
                    if (done) return notify(x.customerName + ' · visit already logged today');
                    const out = await openMaps({
                      lat: x.gpsLat,
                      lng: x.gpsLng,
                      name: x.customerName,
                      city: x.area,
                    });
                    if (out.status !== 'opened') notify(out.reason);
                  }}
                  accessibilityRole="button"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    marginBottom: 8,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: isNext ? C.primaryEdge : C.hairline,
                    backgroundColor: isNext ? C.primaryTint : C.surface,
                  }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T
                      numberOfLines={1}
                      style={[{ fontSize: 15, color: done ? C.muted : C.ink }, weight(isNext ? 600 : 500)]}>
                      {x.customerName}
                    </T>
                    {/* Joined rather than concatenated. With no area recorded —
                        which is most of an imported book — these read
                        " · arrived 10:15", opening on a separator with nothing
                        in front of it. */}
                    <T s="caption" style={{ marginTop: 1 }}>
                      {[
                        x.area,
                        done
                          ? 'arrived ' + (x.actualAt ? hhmm(x.actualAt) : '—')
                          : x.plannedAt
                            ? 'planned ' + x.plannedAt
                            : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </T>
                  </View>
                  {done || isNext ? (
                    <T style={[{ fontSize: 13, color: done ? C.success : C.primaryDeep }, weight(500)]}>
                      {done ? 'Done' : 'Now'}
                    </T>
                  ) : null}
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      {/*
        A DAY WITH NOTHING ON IT IS THE COMMONEST STATE THIS SCREEN HAS, and it
        was drawn as nothing at all: a headline, one muted line, and then six
        hundred points of empty canvas above a dashed button. Every other empty
        state in this app says what to do next; this one — the tab a salesman
        opens first every morning — said the least of any of them, on the days
        it mattered most.

        What it says depends on which nothing it is, because they need
        different things done: a day agreed and unfilled is HIS to fill, a day
        proposed is his to answer, and no day at all is the office's move and
        worth saying so rather than leaving him wondering whether the app is
        broken.
      */}
      {!stops.length && !awaitingRoute ? (
        <View
          style={{
            marginTop: 20,
            backgroundColor: C.surface,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: C.hairline,
            paddingVertical: 26,
            paddingHorizontal: 20,
            alignItems: 'center',
            boxShadow: shadow.card,
          }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: C.primaryTint,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}>
            <Icon name="route" size={22} color={C.primaryDeep} strokeWidth={1.6} />
          </View>
          <T style={[type.body, weight(600), { color: C.ink, textAlign: 'center' }]}>
            {toPick.length
              ? 'A day is waiting for its shops'
              : asking.length
                ? 'A day is waiting for your answer'
                : 'No route for today'}
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6, maxWidth: 280 }}>
            {toPick.length
              ? 'You have agreed ' +
                dayLabel(toPick[0]!.planDate) +
                '. Pick the shops and it becomes a route.'
              : asking.length
                ? 'Say yes or send it back — either answer lets your manager get on with it.'
                : 'Your manager has not proposed one. You can still walk in and log a visit — anything you do today is recorded against it.'}
          </T>
          {toPick.length ? (
            <View style={{ marginTop: 14, alignSelf: 'stretch' }}>
              <PrimaryButton
                label="Pick your shops"
                fullWidth
                onPress={() =>
                  router.push({ pathname: '/pick', params: { day: toPick[0]!.id } })
                }
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {/*
        Going off the plan.
        The label is a CONTROL now rather than a two-line sentence centred in a
        dashed box — that read as body copy with a border round it, which is
        exactly how somebody scrolls past the only escape hatch on the screen.
        What it costs is said in the dialog, where the reason is typed.
      */}
      <DashedButton
        label="Add a stop that is not on the plan"
        onPress={deviate}
        style={{ marginTop: 16 }}
      />

      {/* The last fortnight, most recent first — what was asked, what was
          said, and for a day that was actually routed, how much of it got
          walked. Read-only: a day that has passed is a record, not a form. */}
      {recent.length ? (
        <View style={{ marginTop: 24 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            Recently
          </T>
          {recent.map((d) => (
            <View
              key={d.id}
              style={{
                borderBottomWidth: 1,
                borderBottomColor: C.hairline,
                paddingVertical: 10,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <T style={[{ fontSize: 14, color: C.ink }, weight(500)]}>{dayLabel(d.planDate)}</T>
                <T s="caption" style={{ color: C.muted }}>{d.city ?? ''}</T>
              </View>
              <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                {recentSummary(d, pastCounts[d.planDate])}
              </T>
            </View>
          ))}
        </View>
      ) : null}

      {/* ---------------------------------------------------- tour requests --

          Asking to work away for a few days was a one-way door: `requestTour`
          wrote the row, raised the approval and sent both, the manager decided,
          `applyApprovals` wrote the verdict and the reason onto `tours` — and
          no screen in the app had ever selected from that table. So the answer
          to "can I go to Nashik next week" arrived on the handset, was stored
          correctly, and was invisible. He asked again, or he did not go. */}
      {tours.length ? (
        <View style={{ marginTop: 24 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            Your tour requests
          </T>
          {tours.map((t) => {
            const tone: BadgeTone =
              t.state === 'Approved' ? 'success' : t.state === 'Rejected' ? 'danger' : 'amber';
            /* Stored as JSON because a tour covers several towns. A row that
               cannot be parsed shows the dates rather than breaking the list —
               this is the office's string, and the phone is the wrong place to
               find out it was malformed. */
            let cities: string[] = [];
            try {
              const parsed: unknown = JSON.parse(t.cities);
              if (Array.isArray(parsed)) cities = parsed.map(String);
            } catch {
              cities = [];
            }
            return (
              <Card key={t.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <T style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(500)]}>
                    {dmy(t.startDate) + ' to ' + dmy(t.endDate)}
                  </T>
                  <Badge tone={tone}>{t.syncState === 'queued' ? 'Not sent' : t.state}</Badge>
                </View>
                <T s="caption" style={{ marginTop: 3 }}>
                  {[cities.join(', ') || null, t.purpose].filter(Boolean).join(' · ')}
                </T>
                {/* The manager's own words. A refusal with no reason is one he
                    will simply put in again next week. */}
                {t.decisionNote ? (
                  <T
                    style={{
                      fontSize: 13,
                      lineHeight: 19,
                      color: t.state === 'Rejected' ? C.danger : C.muted,
                      marginTop: 4,
                    }}>
                    {t.decisionNote}
                  </T>
                ) : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      {/* ------------------------------------------------- plan your own day */}
      <BottomSheet open={ownOpen} onClose={() => setOwnOpen(false)} scroll>
        <T s="h2">Plan a day</T>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          Your manager is told. Pick the shops on the next screen.
        </T>

        <View style={{ marginTop: 16 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            Which day
          </T>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOwnPick(true)}
            style={{
              minHeight: HIT,
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
            }}>
            <T style={{ fontSize: 16, color: own.date ? C.ink : C.muted }}>
              {own.date ? dmy(own.date) : 'Pick a date'}
            </T>
          </Pressable>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            Which city
          </T>
          <Input
            value={own.city}
            onChangeText={(v) => {
              setOwn((d) => ({ ...d, city: v }));
              setOwnErr(null);
            }}
            placeholder="Nagpur"
          />
          {/* Said before the picker opens, not after it has drawn the wrong
              list: the shop list is filtered by this and by nothing else. */}
          <T s="caption" style={{ marginTop: 6 }}>
            You will be offered the shops in this city.
          </T>
        </View>

        {ownErr ? (
          <T style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{ownErr}</T>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setOwnOpen(false)} style={{ flex: 1 }} />
          <PrimaryButton
            label={ownBusy ? 'Saving…' : 'Plan it'}
            onPress={startOwnDay}
            style={{ flex: 1 }}
          />
        </View>
      </BottomSheet>

      <BottomSheet open={ownPick} onClose={() => setOwnPick(false)}>
        <T s="h3" style={{ marginBottom: 10 }}>
          Which day
        </T>
        <Calendar
          selected={own.date}
          onPick={(iso) => {
            setOwn((d) => ({ ...d, date: iso }));
            setOwnErr(null);
            setOwnPick(false);
          }}
        />
      </BottomSheet>

      <ActionSheet
        open={moreOpen}
        title="Today’s route"
        items={[
          {
            glyph: 'route',
            label: 'Reorder the route',
            sub: 'Nearest first, from where you are',
            run: () => {
              void reorder();
            },
          },
          { glyph: 'add', label: 'Add an off-plan stop', sub: 'Needs a reason', run: deviate },
          {
            glyph: 'nav',
            label: 'Navigate the whole day',
            sub: 'Opens the route in order, up to ten stops',
            run: async () => {
              const out = await openRoute(
                stops.map((st) => ({ lat: st.gpsLat, lng: st.gpsLng })),
              );
              if (out.status !== 'opened') return notify(out.reason);
              /* Said plainly rather than hidden: a route that quietly stops at
                 lunchtime is worse than one that says where it stops. */
              if (out.dropped > 0) {
                notify(
                  `Maps takes ten stops — the last ${out.dropped} are not in this route.`,
                );
              }
            },
          },
          {
            glyph: 'share',
            label: 'Share the plan',
            sub: 'Pick who, in the share sheet',
            run: async () => {
              if (!stops.length) return notify('There are no stops to share yet.');
              const lines = stops.map(
                (st, i) =>
                  `${i + 1}. ${st.customerName}` +
                  (st.area ? ` — ${st.area}` : '') +
                  (st.plannedAt ? ` (${st.plannedAt})` : ''),
              );
              const out = await shareText(
                [`Plan for ${today} — ${plural(stops.length, 'stop')}`, ...lines].join('\n'),
              );
              if (out.status === 'copied') notify(out.reason);
            },
          },
          {
            glyph: 'cal',
            label: 'Request a tour',
            sub: 'Working away from the usual beat for a few days',
            run: () => setTourOpen(true),
          },
        ]}
        onClose={() => setMoreOpen(false)}
      />

      {/* ---- requesting a tour ---- */}
      <BottomSheet open={tourOpen} onClose={() => setTourOpen(false)} scroll>
        <T s="h2">Request a tour</T>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          Working away from the usual beat for a few days. Your manager decides — this is not the
          same as agreeing a day already proposed to you.
        </T>

        {tourErr ? <T style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{tourErr}</T> : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T s="label" style={{ marginBottom: 6 }}>From</T>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTourPick('from')}
              style={{
                width: '100%', minHeight: 52, justifyContent: 'center', paddingHorizontal: 12,
                borderWidth: 1, borderColor: tourPick === 'from' ? C.primary : C.border,
                borderRadius: radius.lg, backgroundColor: C.surface,
              }}>
              <T style={{ fontSize: 16, color: tour.from ? C.ink : C.muted }}>
                {tour.from ? dmy(tour.from) : 'Pick a date'}
              </T>
            </Pressable>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T s="label" style={{ marginBottom: 6 }}>To</T>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTourPick('to')}
              style={{
                width: '100%', minHeight: 52, justifyContent: 'center', paddingHorizontal: 12,
                borderWidth: 1, borderColor: tourPick === 'to' ? C.primary : C.border,
                borderRadius: radius.lg, backgroundColor: C.surface,
              }}>
              <T style={{ fontSize: 16, color: tour.to ? C.ink : C.muted }}>
                {tour.to ? dmy(tour.to) : 'Pick a date'}
              </T>
            </Pressable>
          </View>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>Where — one or more cities</T>
          <Input
            value={tour.cities}
            onChangeText={(v) => setTour((t) => ({ ...t, cities: v }))}
            placeholder="Nagpur, Amravati"
          />
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>Why</T>
          <VoiceField
            value={tour.purpose}
            onChangeText={(v) => setTour((t) => ({ ...t, purpose: v }))}
            placeholder="A new dealer to open in Amravati, and three accounts overdue for a visit"
          />
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>Estimated cost (₹) — optional</T>
          <Input
            value={tour.cost}
            onChangeText={(v) => setTour((t) => ({ ...t, cost: v.replace(/[^0-9]/g, '') }))}
            keyboardType="number-pad"
            placeholder="4500"
          />
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setTourOpen(false)} style={{ flex: 1 }} />
          <PrimaryButton
            label={tourBusy ? 'Sending…' : 'Send request'}
            onPress={() => void sendTour()}
            disabled={tourBusy}
            style={{ flex: 1 }}
          />
        </View>
      </BottomSheet>

      <BottomSheet open={!!tourPick} onClose={() => setTourPick(null)}>
        <T s="h3" style={{ marginBottom: 10 }}>
          {tourPick === 'to' ? 'Last day away' : 'First day away'}
        </T>
        <Calendar
          key={tourPick ?? 'from'}
          selected={tourPick === 'to' ? tour.to : tour.from}
          rangeFrom={tour.from}
          rangeTo={tour.to}
          onPick={(iso) => {
            if (tourPick === 'to') setTour((t) => ({ ...t, to: iso }));
            /* A start after the end is not a range — carry the end with it. */
            else setTour((t) => ({ ...t, from: iso, to: t.to && iso > t.to ? iso : t.to }));
            setTourPick(null);
          }}
        />
      </BottomSheet>
    </AppFrame>
  );
}

/** 09:41 — the plan's own vocabulary for a time of day. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}


/**
 * `Dharampeth, Sitabuldi and Itwari` — a list said the way somebody says it.
 *
 * It was `areas.join(' and ')`, which on a five-area day produced
 * "A and B and C and D and E". Four stops is an ordinary morning, so this was
 * not an edge case; it read as a bug in the sentence.
 */
function saidAsList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/** What a past day comes down to, in one line. */
function recentSummary(d: PlanDay, counts: { total: number; done: number } | undefined): string {
  if (d.dayState === 'refused') return 'Sent back' + (d.refusalReason ? ' — ' + d.refusalReason : '');
  if (d.dayState === 'proposed') return 'Proposed, never answered';
  if (d.dayState === 'agreed') return 'Agreed, no shops were ever picked';
  // 'planned' — the day was routed, so what happened is what the stops say.
  if (!counts || counts.total === 0) return 'Planned, but nothing was logged';
  return counts.done + ' of ' + counts.total + (counts.done === counts.total ? ' visited' : ' visited — the rest skipped or missed');
}
