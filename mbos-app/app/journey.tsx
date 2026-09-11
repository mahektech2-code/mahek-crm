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
  const offPlanReasonAt = useStore((s) => s.offPlanReasonAt);
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
  /*
   * The shop that leg is heading for, as a RECORD rather than as a label.
   *
   * Navigate used to pass `next.gpsLat`/`next.gpsLng` — the coordinates of the
   * planned stop — under `leg.toLabel`, the name of the shop he actually set
   * off for. `openMaps` prefers coordinates over a name, so the label was
   * ignored and Maps started turn-by-turn to the shop the plan had queued. The
   * leg's own `toLat`/`toLng` cannot answer it either: those are the ARRIVAL
   * fix, written when he gets there, and they are null for the whole of the
   * journey this button exists for. The shop's own pin is the answer.
   */
  const [legShop, setLegShop] = React.useState<Customer | null>(null);
  const [days, setDays] = React.useState<PlanDay[]>([]);
  const [tours, setTours] = React.useState<Tour[]>([]);
  const [pastCounts, setPastCounts] = React.useState<Record<string, { total: number; done: number }>>({});
  /* In flight, and it has to be state rather than a ref: the sheet item reads
     it, and nothing else on the screen would re-render to notice. */
  const [reordering, setReordering] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const today = isoDate(new Date(now));
  /* A fortnight back, matching the server's own PLAN_HISTORY_DAYS — the two
     have to agree, or this screen would ask for history the pull never sent. */
  const historyFrom = isoDate(new Date(now - 15 * 86_400_000));
  /*
   * Local midnight, derived from the DATE STRING rather than from `now`.
   *
   * `now` ticks every minute, so a boundary computed off it directly would be a
   * fresh number sixty times an hour and would re-run the read below with it.
   * `today` is stable across those ticks, and `<date>T00:00:00` with no zone on
   * it is local time — the same midnight `runDayBoundaryWork` and
   * `minutesSinceMidnight` use, and deliberately not `Date.parse` of a bare
   * date, which the spec reads as UTC.
   */
  const dayStart = React.useMemo(() => new Date(today + 'T00:00:00').getTime(), [today]);

  const load = React.useCallback(() => {
    let live = true;
    void todayStops().then((r) => {
      if (live) setStops(r);
    });
    const uid = boot.session?.user.id;
    if (uid) {
      /*
       * TODAY'S journey, and the bound is the fix.
       *
       * Nothing closes a leg but arriving or calling it off, so one he set off
       * on yesterday and never arrived at stayed open for ever — and this
       * screen read it as this morning's, greeting him with "On your way to
       * <yesterday's shop> · 19h 47m" and replacing today's first "Start visit"
       * with a "Continue" into the wrong shop. `closeStaleLegs` tidies those at
       * launch; the bound is what makes the card honest in between.
       */
      void openLegOf(uid, dayStart).then((r) => {
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
  }, [historyFrom, dayStart, boot.session?.user.id]);

  useFocusEffect(load);

  /*
   * The shop behind the open leg, read once per leg rather than on every focus.
   *
   * Keyed on the customer id alone: the leg row itself is re-read constantly
   * (the clock ticks, the screen refocuses) and the shop behind it changes only
   * when he sets off for a different one. Clearing it where there is no leg is
   * the same shape `useCustomer` uses — an id that has gone must not leave the
   * previous shop's pin sitting under the next leg's name, which is the exact
   * failure this state exists to correct.
   */
  const legCustomerId = leg?.customerId ?? null;
  React.useEffect(() => {
    let live = true;
    if (!legCustomerId) {
      setLegShop(null);
      return;
    }
    void getCustomer(legCustomerId).then((c) => {
      if (live) setLegShop(c);
    });
    return () => {
      live = false;
    };
  }, [legCustomerId]);

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
   * TODAY'S agreed day, if there is one, and it is not the same question as
   * `toPick`.
   *
   * The empty state at the bottom of this screen answers "what about today",
   * and it was reading `toPick` — any agreed day from today onward. So with a
   * day agreed for next Tuesday and nothing at all today, the card under
   * "0 of 0 done" read "A day is waiting for its shops · You have agreed Tue 15
   * Sep" with a Pick button, about the same day already listed as a tappable
   * row two inches above it. One day offered twice, and the only sentence that
   * says what to do TODAY suppressed by a card about next week.
   */
  const pickToday = toPick.find((d) => d.planDate === today);

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
    /*
     * WHICH DAY, FIRST.
     *
     * `own.date` starts empty and `createDay` checks the city before the date,
     * so pressing "Plan it" with a city typed and nothing picked came back
     * "That day has already gone. Pick today or a day ahead." — a refusal
     * naming a cause that was not his, about a day he had never chosen.
     */
    if (!own.date) return setOwnErr('Pick which day first.');
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
  /* Opening the shop is what a row tap means. A visited stop used to answer
     with a toast and nothing else, so the route was a dead end the moment the
     work was done — and the record behind it is where the phone number, the
     outstanding and the last visit's note actually live. */
  const openStop = (x: JourneyStop) => {
    set({ custId: x.customerId });
    router.push('/customer?from=journey');
  };

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
    /*
     * THE SHEET CLOSES BEFORE THIS RUNS, and everything below is awaited.
     *
     * `ActionSheet` dismisses and then calls the item, and this reads four
     * configuration values and then waits on `getFix`, which sits for up to ten
     * seconds looking for a satellite. Nothing was drawn in between — no
     * spinner, no toast, no disabled state — so he tapped, the sheet shut, and
     * the screen sat there long enough for him to open it and tap again; two
     * passes then raced to rewrite the same `seq`.
     */
    if (reordering) return notify('Still working out the order…');
    /* Nothing to reorder is not an empty reorder. It toasted
       "Reordered · 0 km and 0 minutes on the plan", which is a confident
       answer to a question that was never askable. */
    if (!stops.some((x) => x.status === 'planned')) {
      return notify('There are no stops left to reorder today.');
    }
    setReordering(true);
    notify('Finding where you are…');
    try {
      await runReorder();
    } finally {
      setReordering(false);
    }
  };

  const runReorder = async () => {
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
              : routeSubline(stops.length, doneCount, areas)}
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

      {/*
        ON THE ROAD — ITS OWN CARD, AND THAT IS THE FIX.

        This block used to live INSIDE the Next stop card, in one arm of a
        ternary that only draws when there is a planned stop left. A leg is
        routinely open when there is not: going off the plan is exactly what
        this screen's own dashed button pushes him into, and visiting the last
        planned stop leaves `next` undefined too. In both cases the whole card
        was skipped and the screen underneath said "No route for today" while he
        was mid-journey with the meter already photographed — no "Call it off",
        no "Continue", and if Android had reaped the app the store's `custId`
        was gone with it, so `/visit` could not be reached from anywhere. The
        only way out was to start a SECOND journey to the same shop from the
        Customers list, which re-opens the odometer camera and throws the
        reading away.

        It is keyed on the leg alone now, and the Next stop card below is
        suppressed while it is drawn: two cards each offering to start a visit
        is how a second leg gets opened by accident, and opening one closes the
        first.
      */}
      {leg ? (
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
            <Icon name="nav" size={18} color={C.primaryDeep} strokeWidth={1.8} />
            <T
              style={[
                { fontSize: 12, lineHeight: 16, letterSpacing: 0.48, textTransform: 'uppercase', color: C.primaryDeep },
                weight(600),
              ]}>
              On your way
            </T>
          </View>
          <T style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.3, color: C.ink, marginTop: 10 }, weight(600)]}>
            {leg.toLabel ?? legShop?.name ?? 'The shop'}
          </T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {legLine({
              modeLabel: leg.modeKey,
              odometerStartKm: null,
              odometerEndKm: null,
              ticketAmountPaise: null,
            }) +
              ' · ' +
              /* `now`, not `Date.now()`. The clock is state on this screen and
                 reading it again inside the render is what the React Compiler
                 rules here forbid — it also meant this duration was measured
                 against a different instant from the "waiting N days" labels
                 above it. A leg with no start reads as nothing elapsed, which
                 is the honest answer: there is no departure to count from. */
              travellingFor(leg.startedAt ?? now, now) +
              (leg.odometerStartKm != null
                ? ' · set off on ' + leg.odometerStartKm.toLocaleString('en-IN') + ' km'
                : '')}
          </T>
          {/*
            NAVIGATION SURVIVES THE DEPARTURE, and it goes where HE is going.
            It was in the other arm of the old ternary — the one drawn BEFORE he
            sets off — so pressing "Start visit" took navigation away at the one
            moment it is for. Worse, when it was first moved in here it kept
            reading the planned stop's coordinates under the leg's shop name,
            and `openMaps` prefers a coordinate to a name: he pressed the one
            button that says it will take him there and rode to the shop the
            plan had queued. The shop's own pin answers it; with no pin at all
            the name and the town are passed instead, which is a worse answer
            and an honest one.
          */}
          <NavigateButton
            variant="button"
            lat={legShop?.gpsLat}
            lng={legShop?.gpsLng}
            name={leg.toLabel ?? legShop?.name}
            city={legShop?.area ?? legShop?.city}
            style={{ marginTop: 14 }}
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
              /* A leg with no shop against it cannot open a visit screen, and
                 the button says so rather than acknowledging the tap and doing
                 nothing. Every leg this screen can draw is one `departForVisit`
                 wrote, which always names a shop — this is the guard, not the
                 expected case. */
              disabled={!legCustomerId}
              whyDisabled="This journey has no shop recorded against it. Call it off and set off again from the shop."
              onPress={() => {
                if (!legCustomerId) return;
                beginVisit(legCustomerId);
                router.push('/visit');
              }}
              style={{ flex: 1, borderRadius: radius.xl }}
            />
          </View>
        </View>
      ) : null}

      {/*
        PICKED, AND NOT YET ROUTED — a headline with no way back into it.

        `pickShops` moves the day to `planned` on this handset the moment he
        saves, and the office mints the stops on the next pull. In between, the
        twelve shops he had just chosen could not be seen or changed from
        anywhere: the empty-state card is suppressed by `!awaitingRoute`, the
        pips and the Next stop card by there being no stops, and today's day
        appears in none of `toPick`, `comingUp` or `recent`. A morning without
        signal can last hours.
      */}
      {awaitingRoute ? (
        <View style={{ marginTop: 16 }}>
          <SecondaryButton
            label="See the shops you picked"
            onPress={() =>
              router.push({ pathname: '/pick', params: { day: awaitingRoute.id } })
            }
          />
        </View>
      ) : null}

      {/*
        THE DAY IS DONE, and the screen used to go quiet at exactly this point:
        `next` is undefined so the Next stop card is gone, and the empty state
        is suppressed because there ARE stops. Every stop walked is the one
        moment this screen has something unambiguous to say — and closing the
        day was reachable only from More → Your day, which is two taps and a
        guess away from the tab he is looking at.

        Not while a leg is open: "every stop is visited, close the day off" is
        the wrong sentence to put in front of somebody who is on a bike on his
        way to an off-plan shop.
      */}
      {!leg && !next && stops.length ? (
        <Card style={{ marginTop: 16 }}>
          <T style={[type.body, weight(600), { color: C.ink }]}>Day done</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {'Every stop on the plan is visited. Close the day off while it is fresh.'}
          </T>
          <PrimaryButton
            label="Close the day"
            onPress={() => router.push('/eod')}
            style={{ marginTop: 12 }}
          />
        </Card>
      ) : null}

      {/*
        NOT WHILE HE IS TRAVELLING. The On-your-way card above is the same
        journey at a later moment, and two cards on one screen each offering to
        start a visit is how a second leg gets opened by accident — opening one
        closes the first, and the meter photograph taken for it is thrown away.
      */}
      {next && !leg ? (
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

                {/*
                  THE ROW OPENS THE SHOP, and the glyph beside it opens maps.

                  It was one unlabelled `Pressable` with no chevron and no map
                  glyph on it, whose press threw him out of the app into Google
                  Maps — and a stop already visited answered with a toast and
                  nothing else, so a done stop was a dead end with no route to
                  the record, the outstanding or the phone number. A tap on a
                  name should open the thing it names; leaving the app is a
                  control that says so.
                */}
                <View
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: 'row',
                    alignItems: 'stretch',
                    marginBottom: 8,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: isNext ? C.primaryEdge : C.hairline,
                    backgroundColor: isNext ? C.primaryTint : C.surface,
                    overflow: 'hidden',
                  }}>
                  <Pressable
                    onPress={() => openStop(x)}
                    accessibilityRole="button"
                    accessibilityLabel={'Open ' + x.customerName}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingVertical: 12,
                      paddingLeft: 14,
                      paddingRight: 6,
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
                    <Icon name="forward" size={18} color={C.muted} strokeWidth={1.5} />
                  </Pressable>
                  <StopMapButton lat={x.gpsLat} lng={x.gpsLng} name={x.customerName} city={x.area} />
                </View>
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

      {/*
        A REASON TYPED AND NOT YET SPENT, SAID OUT LOUD.

        `deviate` above takes the sentence and sends him to the Customers list
        to choose the shop, and nothing anywhere showed that it was still
        waiting — so backing out without visiting left it sitting in the store,
        to attach itself to the next unplanned visit he logged, hours later and
        about a different shop. The manager then read a deviation reason
        belonging to somewhere else, on a record whose own words are "your
        manager sees the reason".

        Here, under the button that took it, with the time it was typed and a
        way to let it go. It survives the app being killed now — see
        `restoreOffPlanReason` — and expires at the day boundary, so the other
        half of the leak, a Tuesday sentence arriving on Wednesday, is closed by
        the store rather than by this screen remembering to check.
      */}
      {offPlanReason ? (
        <View
          style={{
            marginTop: 12,
            backgroundColor: C.warnBg,
            borderRadius: radius.card,
            padding: 14,
          }}>
          <T s="small" style={[{ color: C.warnInk }, weight(600)]}>
            An off-plan reason is waiting for a shop
          </T>
          <T s="small" style={{ color: C.body, marginTop: 4 }}>
            “{offPlanReason}”
          </T>
          <T s="caption" style={{ marginTop: 4 }}>
            {(offPlanReasonAt ? 'Typed at ' + hhmm(offPlanReasonAt) + '. ' : '') +
              'It goes onto the next visit you log at a shop that is not on today’s plan.'}
          </T>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <SecondaryButton
              label="Let it go"
              onPress={() => {
                set({ offPlanReason: null });
                notify('Off-plan reason dropped.');
              }}
              style={{ flex: 1 }}
            />
            <PrimaryButton
              label="Pick the shop"
              onPress={() => router.push('/customers?from=journey')}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}

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
          /* Refused AT THE CELL, which is the only place a refusal costs
             nothing. Every past day was selectable and the form then took the
             city, the date and a press of "Plan it" before saying the day had
             gone — refused after doing the work rather than before it. */
          disabledReason={(iso) => (iso < today ? 'That day has gone' : null)}
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

/**
 * THE LINE UNDER THE COUNT, AND WHY IT LEADS ON STOPS RATHER THAN AREAS.
 *
 * It used to be `areas.length ? saidAsList(areas) : 'Nothing planned for
 * today'`, and `areas` is built only from stops still PLANNED that carry a
 * non-null `area`. Most of this imported book has no area recorded, so an
 * ordinary route printed "Nothing planned for today" directly beneath "2 of 8
 * done" — and once the last stop was visited `areas` was empty by
 * construction, so every finished day ended on that same sentence too.
 *
 * The stop count is the fact that is always true, so it answers first. The
 * areas are the detail, appended only when there are any.
 */
function routeSubline(total: number, done: number, areas: string[]): string {
  if (total === 0) return 'Nothing planned for today';
  if (done >= total) return 'All ' + plural(total, 'stop') + ' done';
  const left = total - done + ' still to go';
  return areas.length ? left + ' · ' + saidAsList(areas) : left;
}

/**
 * The map affordance on a stop row.
 *
 * The row itself opens the shop — it is a record with a phone number, an
 * outstanding and a history, and tapping an unlabelled row used to throw him
 * out of the app into Google Maps instead. Navigating is its own control,
 * drawn as one, and it goes through `NavigateButton` rather than calling
 * `openMaps` here: a second inline call site is how the failure message on one
 * of them stops matching the other, which is the whole reason that component
 * exists.
 */
function StopMapButton({
  lat,
  lng,
  name,
  city,
}: {
  lat: number | null;
  lng: number | null;
  name: string;
  city: string | null;
}) {
  return (
    <View
      style={{
        width: 104,
        borderLeftWidth: 1,
        borderLeftColor: C.hairline,
        justifyContent: 'center',
        paddingHorizontal: 8,
      }}>
      <NavigateButton lat={lat} lng={lng} name={name} city={city} variant="button" />
    </View>
  );
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
