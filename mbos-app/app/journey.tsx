import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { HeroButton } from '../src/components/shell/Chrome';
import { abandonLeg, openLegOf, travelModes, type TravelLeg } from '../src/data/travel';
import { legLine, travellingFor } from '../src/lib/travel-leg';
import { Badge, Input, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { color as C, HIT, weight, type BadgeTone } from '../src/theme/tokens';
import {
  createDay,
  agreeDay,
  planDays,
  refuseDay,
  pickedShops,
  saveStopOrder,
  skipStop,
  stopCountsSince,
  todayStops,
  type JourneyStop,
  type PlanDay,
  whereOf,
} from '../src/data/journey';
import { listTours, requestTour, type Tour } from '../src/data/requests';
import { getCustomer, type Customer } from '../src/data/customers';
import { getConfig } from '../src/data/config';
import { optimiseRoute } from '../src/engines/route';
import { fixOf, getFix } from '../src/native/location';
import { dayLabel, dayLabelRelative, dmy, hhmm, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { cleanAmount, paiseFromTyped } from '../src/lib/money-input';
/* No `openMaps` here. Every stop row and every card on this screen navigates
   through `NavigateButton`, which is the one call site. */
import { openRoute, shareText } from '../src/lib/messaging';
import { NavigateButton } from '../src/components/ui/navigate';
import { PastDaySheet, PlannedDaySheet } from '../src/components/journey/day-sheets';
import {
  DAY_FILL,
  DAY_TONE,
  DashedAdd,
  Disc,
  FieldBox,
  GroupCard,
  GroupTitle,
  Pill,
  PillButton,
  Ring,
  SheetActions,
  SquareButton,
  SwitchTabs,
} from '../src/components/ui/v3';
import { Pop, PressableScale, Stagger, Swap, animateLayout } from '../src/components/ui/motion';
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
  const [tab, setTab] = React.useState<'today' | 'ahead' | 'past'>('today');
  const [pastOpen, setPastOpen] = React.useState<PlanDay | null>(null);
  const [plannedOpen, setPlannedOpen] = React.useState<PlanDay | null>(null);
  const [leg, setLeg] = React.useState<TravelLeg | null>(null);
  /* The mode's NAME, for the On-your-way line — `modeKey` is a database key
     ("own_bike") and was printed as one. */
  const [legModeLabel, setLegModeLabel] = React.useState<string | null>(null);
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
  /* A fortnight back. The Journeys screen reads the whole of the server's
     PLAN_HISTORY_DAYS; this one keeps its Recently list short, and links there
     for the rest. */
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
      void Promise.all([openLegOf(uid, dayStart), travelModes()]).then(([r, modes]) => {
        if (!live) return;
        setLeg(r);
        setLegModeLabel(r ? (modes.find((m) => m.key === r.modeKey)?.label ?? null) : null);
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
  /* What the Coming up tab holds, on its label: a question, a day to fill, a
     day planned or a day sent back are all a day ahead somebody has to know
     about. */
  const ahead = asking.length + toPick.length + comingUp.length + sentBack.length;

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
        const fresh = await planDays(historyFrom);
        /* The answered day leaves "to agree" and reappears under "Agreed. Pick
           the shops" — the layout eases between the two so the eye can follow
           it down, rather than the card vanishing and a different one
           appearing. No buzz of its own: the toast below already carries one. */
        animateLayout();
        setDays(fresh);
        notify(dayLabel(day.planDate) + ' agreed. Pick your shops when you are ready.');
        return;
      }
      askConfirm({
        title: 'Not ' + dayLabel(day.planDate) + '?',
        body:
          (day.city ?? 'That day') +
          ' was given to you. Say why it will not work. Without a reason your manager cannot plan, and the day stays empty. If you want to go somewhere else, name it.',
        reasonLabel: 'Why, and where instead',
        confirmLabel: 'Send it back',
        run: async (reason: string) => {
          const out = await refuseDay(day.id, reason);
          if (!out.ok) return notify(out.message ?? 'Say why it will not work.', 'error');
          const fresh = await planDays(historyFrom);
          animateLayout();
          setDays(fresh);
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

  /*
   * THE SHOPS HE PICKED, VISITABLE BEFORE THE OFFICE HAS MINTED THEM.
   *
   * A morning picked without signal waits for the office to issue the stops,
   * and until then the day had no Start visit anywhere — so he either sat at
   * the first shop's door waiting for a bar, or visited off the list and every
   * one of those visits landed as a miss against a plan that named that very
   * shop. The office now matches a visit with no stop id to his plan by shop
   * and date (`handleVisit`), so a visit started from here counts as the
   * planned stop it is. Read here only while the day is still with the office.
   */
  const awaitingId = awaitingRoute?.id ?? null;
  const [picked, setPicked] = React.useState<{ customerId: string; name: string; area: string | null }[]>([]);
  React.useEffect(() => {
    let live = true;
    if (!awaitingId) return;
    void pickedShops(awaitingId)
      .then((r) => {
        if (live) setPicked(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [awaitingId, now]);

  /* TODAY'S DAY IN ANY STATE, for its city. The heading counts stops and the
     subline names areas, so a salesman with a route had no line anywhere on
     this tab saying which city he was meant to be in — and one with a day
     only proposed or agreed read "No route today" with the city nowhere. */
  const todayDay = days.find((d) => d.planDate === today);

  /* Which of the card's states is showing — the key `Swap` animates on. */
  const journeyMoment = leg
    ? 'leg:' + leg.id
    : awaitingRoute
      ? 'awaiting'
      : next
        ? 'next:' + next.id
        : stops.length
          ? 'done'
          : 'none';

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
    if (reordering) return notify('Still finding the best order…', 'info');
    /* Nothing to reorder is not an empty reorder. It toasted
       "Reordered · 0 km and 0 minutes on the plan", which is a confident
       answer to a question that was never askable. */
    if (!stops.some((x) => x.status === 'planned')) {
      return notify('There are no stops left to reorder today.', 'info');
    }
    setReordering(true);
    notify('Finding where you are…', 'info');
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
      'Order changed · ' +
        Math.round(result.totalDistanceMetres / 100) / 10 +
        ' km and ' +
        Math.round(result.estimatedDayMinutes) +
        ' minutes on the plan' +
        (result.unlocated.length ? ' · ' + plural(result.unlocated.length, 'stop') + ' has no location' : ''),
      result.unlocated.length ? 'warn' : 'success',
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
      title: 'Add a stop not in the plan?',
      body: 'Say why, then pick the shop. The visit is saved for today as off-plan. Your manager will see why the day changed.',
      reasonLabel: 'Why this stop · needed',
      confirmLabel: 'Say why, then pick the shop',
      run: (reason) => {
        set({ offPlanReason: reason });
        notify('Now open the shop and press Visit. Your reason goes with it.');
        router.push('/customers?from=journey');
      },
    });

  const sendTour = async () => {
    if (!tour.from || !tour.to) return setTourErr('Pick the dates you would be away.');
    if (!tour.purpose.trim()) return setTourErr('Say why. Your manager decides only on this.');

    setTourBusy(true);
    setTourErr(null);
    const cities = tour.cities.split(',').map((c) => c.trim()).filter(Boolean);
    const costPaise = paiseFromTyped(tour.cost);
    const result = await requestTour({
      userId: boot.session?.user.id ?? '',
      startDate: tour.from,
      endDate: tour.to,
      cities,
      purpose: tour.purpose.trim(),
      estimatedCostPaise: costPaise > 0 ? costPaise : null,
    });
    setTourBusy(false);

    if (!result.ok) return setTourErr(result.message);
    setTourOpen(false);
    setTour({ from: '', to: '', cities: '', purpose: '', cost: '' });
    notify('Tour request sent to your manager · ' + dmy(tour.from) + ' to ' + dmy(tour.to));
  };

  /* The route sheet's actions. `label`/`sub` are the long words a screen
     reader hears; `short`/`shortSub` are what the V3 tiles print. */
  const routeActions: { glyph: IconName; label: string; sub: string; short: string; shortSub: string; run: () => void }[] = [
    {
      glyph: 'route',
      label: 'Reorder the route',
      sub: 'Nearest first, from where you are',
      short: 'Reorder',
      shortSub: 'Nearest first, from here',
      run: () => {
        void reorder();
      },
    },
    { glyph: 'add', label: 'Add an off-plan stop', sub: 'You must give a reason', short: 'Off-plan stop', shortSub: 'Needs a reason', run: deviate },
    {
      glyph: 'nav',
      label: 'Navigate the whole day',
      sub: 'Opens the route in order, up to ten stops',
      short: 'Navigate day',
      shortSub: 'In order, max 10',
      run: () => {
        void (async () => {
          const out = await openRoute(stops.map((st) => ({ lat: st.gpsLat, lng: st.gpsLng })));
          if (out.status !== 'opened') return notify(out.reason, 'error');
          /* Said plainly rather than hidden: a route that quietly stops at
             lunchtime is worse than one that says where it stops. */
          if (out.dropped > 0) {
            notify(`Maps takes only ten stops. The last ${out.dropped} are not in this route.`, 'warn');
          }
        })();
      },
    },
    {
      glyph: 'share',
      label: 'Share the plan',
      sub: 'Pick who, in the share sheet',
      short: 'Share plan',
      shortSub: 'Pick who',
      run: () => {
        void (async () => {
          if (!stops.length) return notify('There are no stops to share yet.', 'info');
          const lines = stops.map(
            (st, i) =>
              `${i + 1}. ${st.customerName}` + (st.area ? ` — ${st.area}` : '') + (st.plannedAt ? ` (${st.plannedAt})` : ''),
          );
          const out = await shareText([`Plan for ${today} — ${plural(stops.length, 'stop')}`, ...lines].join('\n'));
          if (out.status === 'copied') notify(out.reason, 'warn');
        })();
      },
    },
    {
      glyph: 'cal',
      label: 'Request a tour',
      sub: 'Work away from your usual beat for a few days',
      short: 'Request a tour',
      shortSub: 'Away from your beat for a few days',
      run: () => setTourOpen(true),
    },
  ];

  /* The day at a glance, in the hero: the tabs, and on Today the ring, the
     city and the pips. Built here so the frame draws it inside the navy block. */
  const city = whereOf(todayDay);
  const headline = awaitingRoute
    ? plural(awaitingRoute.picked, 'shop') + ' picked'
    : stops.length
      ? doneCount + ' of ' + stops.length + ' done'
      : /* "0 of 0 done" over "Nothing planned for today" was a fraction of
           nothing; the heading says the fact. */
        'No route today';
  const subline = awaitingRoute
    ? (whereOf(awaitingRoute) ? whereOf(awaitingRoute) + ' · ' : '') +
      'sent to the office. The stops come when the phone sends next'
    : !stops.length && todayDay && todayDay.dayState !== 'planned'
      ? (city ?? 'Today') + ' · ' + TODAY_STATE[todayDay.dayState]
      : routeSubline(stops.length, doneCount, areas);
  const nextIndex = next ? stops.findIndex((x) => x.id === next.id) + 1 : 0;
  const laterCount = stops.filter((x) => x.status !== 'visited' && x.id !== next?.id).length;

  const hero = (
    <View>
      {/*
        THREE TABS, AND TODAY IS THE FIRST.

        This was one scroll: the days to agree, the agreed days, the coming
        days, the refusals and "Plan a day" all sat ABOVE today's route, and the
        fortnight behind and the tour requests below it. A salesman opening
        Journey in a market lane wants the next door, and had to scroll past a
        week of planning to reach it. Today is what opens; what is ahead and
        what is behind are one tap away, and a day the office is waiting on him
        to answer is still impossible to miss — the Today tab says so in one
        line that opens it.
      */}
      <SwitchTabs
        tone="hero"
        options={[
          { key: 'today', label: 'Today' },
          { key: 'ahead', label: 'Ahead', a11y: 'Coming up', badge: ahead || null },
          { key: 'past', label: 'Past' },
        ]}
        value={tab}
        onChange={setTab}
        style={{ marginTop: 16 }}
      />
      {tab === 'today' ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18, marginTop: 18 }}>
            {stops.length ? (
              <Ring done={doneCount} total={stops.length} label={doneCount + ' of ' + stops.length + ' stops done'} />
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              {/* TODAY'S DAY IN ANY STATE, for its city. A salesman with a route
                  had no line anywhere on this tab saying which city he was meant
                  to be in. With stops the city is the headline and the ring
                  carries the count; with none the headline says the fact. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="visit" size={14} color={C.onNavyMuted} strokeWidth={2} />
                <T numberOfLines={1} style={[{ flex: 1, fontSize: 13, color: C.onNavyMuted }, weight(600)]}>
                  {'Today' +
                    (!stops.length && city ? ' · ' + city : '') +
                    (todayDay?.beat ? ' · ' + todayDay.beat + ' beat' : '')}
                </T>
              </View>
              <T
                numberOfLines={2}
                style={[{ fontSize: 30, lineHeight: 36, letterSpacing: -0.9, color: C.onNavy }, weight(800)]}>
                {stops.length ? (city ?? headline) : headline}
              </T>
              <T numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: '#C9D1E0', marginTop: 2 }}>
                {subline}
              </T>
            </View>
          </View>
          {/* Drawn only where there is a day to draw. */}
          {stops.length ? (
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={'Stops: ' + doneCount + ' done, ' + (next ? '1 next, ' : '') + laterCount + ' later'}
              style={{ flexDirection: 'row', gap: 4, marginTop: 14 }}>
              {stops.map((x) => (
                <View
                  key={x.id}
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor:
                      x.status === 'visited' ? C.lime : next && x.id === next.id ? '#8E6BFF' : 'rgba(255,255,255,0.14)',
                  }}
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );

  const allJourneysLink = (
    /* Every journey past and coming, as a list or a calendar, each day open
       in full — and the cities and areas allocated to him, to accept or to
       ask to change. */
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="All journeys and your areas. Calendar or list of past and upcoming days, and the cities you work"
      onPress={() => router.push('/journeys?from=journey')}
      style={{
        minHeight: 60,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: C.surface,
        borderRadius: 22,
        paddingHorizontal: 16,
        paddingVertical: 10,
      }}>
      <Icon name="cal" size={20} color={C.primary} strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>All journeys & your areas</T>
        <T style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }}>Calendar or list · cities you work</T>
      </View>
      <Icon name="forward" size={16} color={C.faint} strokeWidth={2} />
    </PressableScale>
  );

  return (
    <AppFrame
      title="Today’s route"
      activeTab="journey"
      tone="navy"
      showTitle={false}
      hero={hero}
      heroActions={
        tab === 'today' ? (
          /* `Icon name="dots"`, not the character `⋯` — a text ellipsis read as
             a typo next to twenty controls drawn from the same icon set. */
          <HeroButton tone="navy" icon="dots" label="Route actions" onPress={() => setMoreOpen(true)} />
        ) : undefined
      }
      overlap={tab === 'today'}
      contentStyle={{ paddingHorizontal: 14, paddingTop: tab === 'today' ? 0 : 16, paddingBottom: 24 }}>
      {tab === 'today' ? (
        <View style={{ gap: 14 }}>
          {/* ONE CARD, FIVE MOMENTS OF ONE DAY: on the road, waiting for the
              office, every stop walked, the next stop, and nothing at all. It
              sits across the hero's edge, and is swapped rather than cut, so a
              visit saved and the card moving on reads as the route advancing. */}
          <Swap id={journeyMoment}>
          {/*
            ON THE ROAD — ITS OWN CARD, AND THAT IS THE FIX.

            This block used to live INSIDE the Next stop card, in one arm of a
            ternary that only draws when there is a planned stop left. A leg is
            routinely open when there is not: going off the plan is exactly what
            this screen's own dashed button pushes him into, and visiting the last
            planned stop leaves `next` undefined too. In both cases the whole card
            was skipped and the screen said "No route for today" while he was
            mid-journey — no "Cancel trip", no "Continue". It is keyed on the leg
            alone now, and the Next stop card is suppressed while it is drawn: two
            cards each offering to start a visit is how a second leg gets opened
            by accident, and opening one closes the first.
          */}
          {leg ? (
            <View style={[heroCard, { borderWidth: 2, borderColor: C.primaryEdge }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pill text="On your way" icon="nav" bg={C.navy} fg={C.lime} height={26} />
                <View style={{ flex: 1 }} />
                {/* `now`, not `Date.now()`. The clock is state on this screen and
                    reading it again inside the render is what the React Compiler
                    rules here forbid. A leg with no start reads as nothing
                    elapsed: there is no departure to count from. */}
                <View
                  accessible
                  accessibilityLabel={'Travelling for ' + travellingFor(leg.startedAt ?? now, now)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name="clock" size={14} color={C.ink} strokeWidth={2} />
                  <T style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>{travellingFor(leg.startedAt ?? now, now)}</T>
                </View>
              </View>
              <T style={[cardName, { marginTop: 12 }]}>{leg.toLabel ?? legShop?.name ?? 'The shop'}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                <Pill
                  text={legLine({
                    modeLabel: legModeLabel ?? leg.modeKey,
                    odometerStartKm: null,
                    odometerEndKm: null,
                    ticketAmountPaise: null,
                  })}
                  icon="route"
                />
                {leg.odometerStartKm != null ? (
                  <Pill
                    text={leg.odometerStartKm.toLocaleString('en-IN') + ' km'}
                    icon="clock"
                    a11y={'Meter at start ' + leg.odometerStartKm.toLocaleString('en-IN') + ' km'}
                  />
                ) : null}
              </View>
              {/*
                NAVIGATION SURVIVES THE DEPARTURE, and it goes where HE is going.
                It used to read the planned stop's coordinates under the leg's
                shop name, and `openMaps` prefers a coordinate to a name: he
                pressed the one button that says it will take him there and rode
                to the shop the plan had queued. The shop's own pin answers it;
                with no pin the name and the town are passed instead.
              */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
                <NavigateButton
                  variant="icon"
                  lat={legShop?.gpsLat}
                  lng={legShop?.gpsLng}
                  name={leg.toLabel ?? legShop?.name}
                  city={legShop?.area ?? legShop?.city}
                />
                <SquareButton
                  icon="close"
                  label="Cancel trip"
                  ink={C.danger}
                  edge="#F3C9C6"
                  onPress={() =>
                    askConfirm({
                      title: 'Not going after all?',
                      body:
                        'The trip stays on your record, with your reason and 0 km. The meter has already moved. Removing the trip would leave a gap before your next one.',
                      reasonLabel: 'Why · needed',
                      confirmLabel: 'Cancel trip',
                      run: (reason) => {
                        void abandonLeg(leg.id, reason).then(() => {
                          setLeg(null);
                          notify('Trip cancelled');
                        });
                      },
                    })
                  }
                />
                <PillButton
                  label="Continue"
                  variant="lime"
                  block
                  height={56}
                  /* A leg with no shop against it cannot open a visit screen, and
                     the button says so rather than acknowledging the tap and doing
                     nothing. Every leg this screen can draw is one `departForVisit`
                     wrote, which always names a shop — this is the guard. */
                  disabled={!legCustomerId}
                  whyDisabled="This trip has no shop saved. Cancel it and start again from the shop."
                  onRefused={(why) => notify(why, 'warn')}
                  onPress={() => {
                    if (!legCustomerId) return;
                    beginVisit(legCustomerId);
                    router.push('/visit');
                  }}
                  style={{ flex: 1 }}
                />
              </View>
              {!legCustomerId ? (
                <T style={{ fontSize: 12, lineHeight: 16, color: C.faint, marginTop: 8 }}>
                  No shop on this trip. Cancel it and start again from the shop.
                </T>
              ) : null}
            </View>
          ) : null}

          {/*
            PICKED, AND NOT YET ROUTED — a headline with no way back into it.

            `pickShops` moves the day to `planned` on this handset the moment he
            saves, and the office mints the stops on the next pull. In between,
            the shops he had just chosen could not be seen or changed from
            anywhere. A morning without signal can last hours.
          */}
          {!leg && awaitingRoute ? (
            <View style={heroCard}>
              <Pill text="With the office" icon="upload" bg={C.primaryTint} fg={C.primaryDeep} height={26} />
              <T style={[cardName, { marginTop: 10 }]}>{plural(awaitingRoute.picked, 'shop') + ' picked'}</T>
              <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>
                {(whereOf(awaitingRoute) ? whereOf(awaitingRoute) + ' · ' : '') + 'you can start visits now'}
              </T>
              {picked.map((shop) => (
                <View key={shop.customerId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{shop.name}</T>
                    {shop.area ? <T numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>{shop.area}</T> : null}
                  </View>
                  <PillButton
                    label="Start visit"
                    variant="lime"
                    a11y={'Start visit to ' + shop.name}
                    onPress={() => askTravel({ customerId: shop.customerId, customerName: shop.name })}
                  />
                </View>
              ))}
              <PillButton
                label="See the shops you picked"
                variant="outline"
                onPress={() => router.push({ pathname: '/pick', params: { day: awaitingRoute.id } })}
                style={{ marginTop: 12 }}
              />
            </View>
          ) : null}

          {/*
            THE DAY IS DONE, and the screen used to go quiet at exactly this point.
            Every stop walked is the moment to log what the day cost him — his
            allowances are worked out at the office, and what is left is the
            bills. Not while a leg is open: "every stop is visited" is the wrong
            sentence for somebody on his way to an off-plan shop.
          */}
          {!leg && !next && stops.length ? (
            <View style={[heroCard, { backgroundColor: C.navy }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Disc icon="tick" size={36} bg={C.lime} ink={C.navy} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 17, lineHeight: 24, color: '#FFFFFF' }, weight(800)]}>
                    {'Day done · ' + doneCount + '/' + stops.length}
                  </T>
                  <T style={{ marginTop: 2, fontSize: 13, lineHeight: 18, color: C.onNavyMuted }}>
                    Add any fare, food or bill you paid today.
                  </T>
                </View>
              </View>
              <PillButton
                label="Add expenses"
                variant="lime"
                a11y={'Add expenses. All ' + plural(stops.length, 'stop') + ' done'}
                onPress={() => router.push({ pathname: '/expenses', params: { add: '1', from: 'journey' } })}
                style={{ marginTop: 12 }}
              />
            </View>
          ) : null}

          {/*
            NOT WHILE HE IS TRAVELLING. The On-your-way card above is the same
            journey at a later moment, and two cards on one screen each offering to
            start a visit is how a second leg gets opened by accident.
          */}
          {next && !leg ? (
            <View style={heroCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pill text={'Next · ' + nextIndex} bg={C.primary} fg="#FFFFFF" height={26} a11y={'Next stop, number ' + nextIndex} />
                <View style={{ flex: 1 }} />
                {/* Only where there is a time to be late against. With no
                    planned time "On time" was a verdict about nothing. */}
                {next.plannedAt ? (
                  late ? (
                    <Pill text="Late" icon="clock" bg={C.warnBg} fg={C.warnInk} height={26} a11y="Running late" />
                  ) : (
                    <Pill text="On time" icon="clock" bg={C.successBg} fg={C.success} height={26} />
                  )
                ) : null}
              </View>
              <T style={[cardName, { marginTop: 12 }]}>{next.customerName}</T>
              {/* Only where there is one — an empty line read as a missing value. */}
              {next.area ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <Icon name="visit" size={14} color={C.muted} strokeWidth={2} />
                  <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>{next.area}</T>
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                {next.plannedAt ? (
                  <Pill text={next.plannedAt} icon="clock" height={32} a11y={'Planned ' + next.plannedAt} />
                ) : null}
                {next.outstandingPaise > 0 ? (
                  <Pill
                    text={'Collect ' + inrFromPaise(next.outstandingPaise)}
                    icon="wallet"
                    bg={C.dangerBg}
                    fg={C.danger}
                    height={32}
                    a11y={'They owe ' + inrFromPaise(next.outstandingPaise) + '. This stop is on the list to collect it.'}
                  />
                ) : (
                  <Pill text="Nothing outstanding" icon="tick" bg={C.successBg} fg={C.success} height={32} a11y="Nothing outstanding for them." />
                )}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
                <NavigateButton
                  variant="icon"
                  lat={next.gpsLat}
                  lng={next.gpsLng}
                  name={next.customerName}
                  city={next.area ?? next.city}
                />
                <PillButton
                  label="Start visit"
                  variant="lime"
                  block
                  height={56}
                  /* Starts the journey to the shop and opens the visit — see
                     `TravelGate`, which also refuses while he is at another shop. */
                  onPress={() => askTravel({ customerId: next.customerId, customerName: next.customerName })}
                  style={{ flex: 1 }}
                />
              </View>
              {/* SKIPPING IS AN ANSWER, and there was no way to give it. A stop
                  he could not make — shut for a wedding, the owner in hospital,
                  the road flooded — stayed "Next" all day, every later stop
                  sat behind it, and the day closed counting it a miss with
                  no reason anywhere. The reason goes to the office with the
                  skip; the card moves on to the stop after it. */}
              <DashedAdd
                label="Skip, with a reason"
                onPress={() =>
                  askConfirm({
                    title: `Skip ${next.customerName}?`,
                    body: 'Your reason goes to your manager. The next stop comes up.',
                    reasonLabel: 'Why · needed',
                    placeholder: 'Shop shut today for a function.',
                    confirmLabel: 'Skip this stop',
                    cancelLabel: 'Back',
                    tone: 'navy',
                    run: (reason) => {
                      void skipStop(next.id, reason)
                        .then((r) => {
                          if (!r.ok) return notify(r.message, 'error');
                          notify('Stop skipped. Your reason is with the office.');
                          load();
                        })
                        .catch(() => notify('The skip could not be saved on this phone. Try again.', 'error'));
                    },
                  })
                }
                style={{ marginTop: 10 }}
              />
            </View>
          ) : null}

          {/*
            A DAY WITH NOTHING ON IT IS THE COMMONEST STATE THIS SCREEN HAS, and it
            was drawn as nothing at all. What it says depends on which nothing it
            is, because they need different things done: a day agreed and
            unfilled is HIS to fill, a day proposed is his to answer, and no day
            at all is the office's move and worth saying so rather than leaving
            him wondering whether the app is broken.

            `pickToday`, never `toPick`: this card answers "what about TODAY", and
            read against any agreed day from today onward it announced next
            Tuesday while suppressing the only sentence about this morning.
          */}
          {!leg && !stops.length && !awaitingRoute ? (
            <View style={[heroCard, { alignItems: 'center', paddingVertical: 20 }]}>
              <Disc
                icon={pickToday ? 'route' : asking.length ? 'cal' : 'route'}
                size={44}
                bg={asking.length && !pickToday ? C.warnBg : C.primaryTint}
                ink={asking.length && !pickToday ? C.warnInk : C.primaryDeep}
              />
              <T style={[{ fontSize: 17, lineHeight: 24, color: C.ink, marginTop: 10, textAlign: 'center' }, weight(800)]}>
                {pickToday ? 'Today needs its shops' : asking.length ? 'Waiting for your answer' : 'No route today'}
              </T>
              <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4, textAlign: 'center', maxWidth: 280 }}>
                {pickToday
                  ? 'Agreed. Pick them and it becomes a route.'
                  : asking.length
                    ? 'Yes or send it back. Both help your manager plan.'
                    : 'None given. Visit shops anyway, all your work is saved.'}
              </T>
              {pickToday ? (
                <PillButton
                  label="Pick your shops"
                  variant="primary"
                  onPress={() => router.push({ pathname: '/pick', params: { day: pickToday.id } })}
                  style={{ marginTop: 12, alignSelf: 'stretch' }}
                />
              ) : asking.length ? (
                <PillButton
                  label="Answer it"
                  variant="navyLime"
                  onPress={() => setTab('ahead')}
                  style={{ marginTop: 12, alignSelf: 'stretch' }}
                />
              ) : null}
            </View>
          ) : null}
          </Swap>

          {asking.length ? (
            <Pressable
              onPress={() => setTab('ahead')}
              accessibilityRole="button"
              style={({ pressed }) => ({
                minHeight: 52,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
              })}>
              <Icon name="cal" size={20} color={C.primaryDeep} strokeWidth={2} />
              <T style={[{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, color: C.primaryDeep }, weight(700)]}>
                {/* WHICH CITIES, not only how many: "a day to agree" sent him
                    to another tab to find out where he was being asked to go. */}
                {'Agree ' +
                  asking.length +
                  ': ' +
                  asking
                    .slice(0, 3)
                    .map((d) => (d.city ?? '?') + ' (' + dayLabelRelative(d.planDate, today) + ')')
                    .join(', ') +
                  (asking.length > 3 ? '…' : '')}
              </T>
              <Icon name="forward" size={16} color={C.primaryDeep} strokeWidth={2} />
            </Pressable>
          ) : null}

          <WeekStrip days={days} today={today} />

          {/* Guarded: an empty container still spends its gap, and this screen's
              commonest state has nothing in it. */}
          {stops.length ? (
            <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 12, paddingVertical: 6, overflow: 'hidden' }}>
              {stops.map((x, i) => {
                const isNext = !!next && x.id === next.id;
                const done = x.status === 'visited';
                const skipped = x.status === 'skipped';
                /* Joined rather than concatenated. With no area recorded — which
                   is most of an imported book — these read " · in 10:15",
                   opening on a separator with nothing in front of it. */
                const line = [
                  isNext ? 'Now' : null,
                  x.area,
                  skipped
                    ? 'skipped' + (x.skipReason ? ': ' + x.skipReason : '')
                    : done
                      ? 'in ' + (x.actualAt ? hhmm(x.actualAt) : '—')
                      : x.plannedAt
                        ? x.plannedAt
                        : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <Stagger
                    key={x.id}
                    index={i}
                    style={[
                      { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60 },
                      i ? { borderTopWidth: 1, borderTopColor: C.hairline } : null,
                      isNext ? { marginHorizontal: -12, paddingHorizontal: 12, backgroundColor: C.primaryTint } : null,
                    ]}>
                    {/*
                      THE ROW OPENS THE SHOP, and the glyph beside it opens maps.

                      It was one unlabelled `Pressable` whose press threw him out
                      of the app into Google Maps — and a stop already visited
                      answered with a toast and nothing else, so a done stop was a
                      dead end with no route to the record, the outstanding or the
                      phone number. A tap on a name opens the thing it names;
                      leaving the app is a control that says so.
                    */}
                    <Pressable
                      onPress={() => openStop(x)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        'Open ' + x.customerName + (done ? ', done' : isNext ? ', next stop' : '') + (line ? '. ' + line : '')
                      }
                      style={({ pressed }) => ({
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        alignSelf: 'stretch',
                        opacity: pressed ? 0.7 : 1,
                      })}>
                      {/* The marker pops as a stop turns from a number into a
                          tick — the one change on this list that is news. */}
                      <Pop trigger={done}>
                        {done ? (
                          <Disc icon="tick" size={30} bg={C.successBg} ink={C.success} a11y="Done" />
                        ) : (
                          <View
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 15,
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: isNext ? C.primary : 'transparent',
                              borderWidth: isNext ? 0 : 2,
                              borderColor: C.line,
                            }}>
                            <T style={[{ fontSize: 12, color: isNext ? '#FFFFFF' : C.muted }, weight(700)]}>{String(i + 1)}</T>
                          </View>
                        )}
                      </Pop>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T
                          numberOfLines={1}
                          style={[{ fontSize: 15, color: done ? C.muted : C.ink }, weight(isNext ? 700 : 600)]}>
                          {x.customerName}
                        </T>
                        {line ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            {skipped ? <Icon name="close" size={12} color={C.danger} strokeWidth={2.4} /> : null}
                            <T
                              numberOfLines={1}
                              style={[
                                {
                                  flex: 1,
                                  fontSize: 12,
                                  lineHeight: 16,
                                  color: skipped ? C.danger : isNext ? C.primaryDeep : done ? C.faint : C.muted,
                                },
                                weight(isNext ? 600 : 400),
                              ]}>
                              {line}
                            </T>
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                    {/* Navigating is its own control and goes through
                        `NavigateButton` — a second inline `openMaps` call site is
                        how the failure message on one stops matching the other. */}
                    <NavigateButton lat={x.gpsLat} lng={x.gpsLng} name={x.customerName} city={x.area ?? x.city} variant="icon" />
                    <Pressable
                      onPress={() => openStop(x)}
                      accessibilityRole="button"
                      accessibilityLabel={'Open ' + x.customerName}
                      hitSlop={8}
                      style={{ width: 20, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="forward" size={16} color={C.faint} strokeWidth={2} />
                    </Pressable>
                  </Stagger>
                );
              })}
            </View>
          ) : null}

          {/*
            Going off the plan. A CONTROL rather than a two-line sentence centred
            in a dashed box, which read as body copy and got scrolled past. What it
            costs is said in the dialog, where the reason is typed.
          */}
          <DashedAdd label="Off-plan stop" a11y="Add a stop that is not on the plan" onPress={deviate} />

          {/*
            A REASON TYPED AND NOT YET SPENT, SAID OUT LOUD.

            `deviate` takes the sentence and sends him to the Customers list to
            choose the shop, and nothing anywhere showed that it was still waiting
            — so backing out left it in the store, to attach itself to the next
            unplanned visit hours later, about a different shop. Here, under the
            button that took it, with the time it was typed and a way to let it
            go. It survives the app being killed — see `restoreOffPlanReason` —
            and expires at the day boundary.
          */}
          {offPlanReason ? (
            <View style={{ backgroundColor: C.warnBg, borderRadius: 20, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="shop" size={16} color={C.warnInk} strokeWidth={2} />
                <T style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.warnInk }, weight(700)]}>Off-plan reason needs a shop</T>
                {offPlanReasonAt ? (
                  <View
                    accessible
                    accessibilityLabel={'Typed at ' + hhmm(offPlanReasonAt)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Icon name="clock" size={12} color={C.warnInk} strokeWidth={2.2} />
                    <T style={[{ fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(600)]}>{hhmm(offPlanReasonAt)}</T>
                  </View>
                ) : null}
              </View>
              <T style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>“{offPlanReason}”</T>
              <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 4 }}>
                Goes with your next off-plan visit today.
              </T>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <PillButton
                  label="Remove"
                  variant="white"
                  height={48}
                  a11y="Remove the off-plan reason"
                  onPress={() => {
                    set({ offPlanReason: null });
                    notify('Off-plan reason removed.');
                  }}
                  style={{ flex: 1 }}
                />
                <PillButton
                  label="Pick the shop"
                  variant="navy"
                  height={48}
                  onPress={() => router.push('/customers?from=journey')}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}
        </View>
      ) : tab === 'ahead' ? (
        <View style={{ gap: 10 }}>
          {/*
            The days you have been asked about, first. A question somebody is
            waiting on you to answer outranks a list you already know — and it is
            the only thing on this tab that goes away once you deal with it.
          */}
          {asking.length ? (
            <>
              <GroupTitle>{'Agree · ' + asking.length}</GroupTitle>
              {asking.map((d, i) => {
                /* Worked out once — two calls in one expression could be
                   measured against different instants. */
                const waiting = waitingChip(d.proposedAt, now);
                return (
                  <Stagger key={d.id} index={i}>
                    <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <T style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }, weight(700)]}>
                          {dayLabelRelative(d.planDate, today)}
                        </T>
                        {/* HOW LONG IT HAS BEEN SITTING. The office is waiting on
                            this answer to plan a week, and "proposed" with no age
                            reads as something that arrived a moment ago. */}
                        {waiting ? (
                          <Pill
                            text={waiting.text}
                            icon={waiting.old ? 'clock' : undefined}
                            bg={waiting.old ? C.warnBg : C.wash}
                            fg={waiting.old ? C.warnInk : C.muted}
                            height={26}
                            a11y={waiting.said}
                          />
                        ) : null}
                      </View>
                      <T style={[cardName, { marginTop: 6 }]}>{d.city ?? 'A day was proposed'}</T>
                      <View
                        accessible
                        accessibilityLabel={
                          (d.city ? d.city + ' was proposed' : 'A day was proposed') +
                          (d.proposedBy ? ' by ' + d.proposedBy : '') +
                          '. You pick the shops after you agree. You know the city best.'
                        }
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <Icon name="person" size={14} color={C.muted} strokeWidth={2} />
                        <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }}>
                          {(d.proposedBy ?? 'The office') + ' · you pick shops after'}
                        </T>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                        <PillButton label="Yes, that works" variant="navyLime" onPress={() => void say(d, true)} style={{ flex: 1 }} />
                        <PillButton label="Not that day" variant="outline" onPress={() => void say(d, false)} style={{ flex: 1 }} />
                      </View>
                    </View>
                  </Stagger>
                );
              })}
            </>
          ) : null}

          {/*
            THE DAYS: agreed and not yet filled, already routed, and sent back.

            Agreed is the only prompt that gets somebody from "Nagpur on Tuesday"
            to which doors, so it leads. A routed day beyond today had nowhere to
            be seen again until it WAS that day. A refusal stays so it does not
            vanish.
          */}
          {toPick.length || comingUp.length || sentBack.length ? (
            <>
              <GroupTitle style={{ paddingTop: asking.length ? 8 : 0 }}>Days</GroupTitle>
              <GroupCard>
                {toPick.map((d) => (
                  <DayRow
                    key={d.id}
                    icon="shop"
                    bg={DAY_FILL.agreed}
                    ink={DAY_TONE.agreed}
                    title={dayLabelRelative(d.planDate, today) + (d.city ? ' · ' + d.city : '')}
                    line="Agreed · pick the shops"
                    lineColor={DAY_TONE.agreed}
                    a11y={'no shops picked yet'}
                    /* A day back here because the office REFUSED the pick has to
                       say so, or he picks the same shops into the same refusal. */
                    warning={
                      d.syncState === 'rejected'
                        ? d.syncMessage ?? 'The office did not accept the shops you picked.'
                        : null
                    }
                    onPress={() => router.push({ pathname: '/pick', params: { day: d.id } })}
                  />
                ))}
                {comingUp.map((d) => (
                  <DayRow
                    key={d.id}
                    icon="route"
                    bg={DAY_FILL.planned}
                    ink={C.primaryDeep}
                    title={dayLabelRelative(d.planDate, today) + (whereOf(d) ? ' · ' + whereOf(d) : '')}
                    line={'Planned · ' + plural(d.picked, 'shop')}
                    /* Opens the day's shops — to see them, take one off, add more
                       or start over — rather than dropping him into the picker,
                       which is the wrong place to READ a plan. */
                    onPress={() => setPlannedOpen(d)}
                  />
                ))}
                {sentBack.map((d) => (
                  <DayRow
                    key={d.id}
                    icon="back"
                    bg={C.warnBg}
                    ink={C.warnInk}
                    title={dayLabelRelative(d.planDate, today) + ' · sent back'}
                    line={d.refusalReason ? '“' + d.refusalReason + '”' : null}
                    warning={d.syncState === 'queued' ? 'Waiting for signal' : null}
                  />
                ))}
              </GroupCard>
            </>
          ) : null}

          {/*
            A day nobody proposed. Under the questions and the agreed days: what
            the office has asked is the first thing to answer, and this is what to
            do when it has asked nothing. Always drawn — a salesman whose manager
            plans nothing would otherwise find an empty tab with no way forward.
          */}
          <DashedAdd
            label="Plan a day"
            onPress={() => {
              setOwn({ date: '', city: '' });
              setOwnErr(null);
              setOwnOpen(true);
            }}
          />

          {/* ---------------------------------------------------- tour requests --

              Asking to work away was a one-way door: the manager decided, the
              verdict and the reason landed on `tours` — and no screen in the app
              had ever selected from that table. So the answer to "can I go to
              Nashik next week" arrived on the handset and was invisible. */}
          {tours.length ? (
            <>
              <GroupTitle style={{ paddingTop: 8 }}>Tours</GroupTitle>
              <GroupCard>
                {tours.map((t) => {
                  const tone: BadgeTone =
                    t.state === 'Approved' ? 'success' : t.state === 'Rejected' ? 'danger' : 'amber';
                  /* Stored as JSON because a tour covers several towns. A row that
                     cannot be parsed shows the dates rather than breaking the list. */
                  let cities: string[] = [];
                  try {
                    const parsed: unknown = JSON.parse(t.cities);
                    if (Array.isArray(parsed)) cities = parsed.map(String);
                  } catch {
                    cities = [];
                  }
                  return (
                    <View key={t.id} style={{ paddingVertical: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Icon name="cal" size={16} color={C.ink} strokeWidth={2} />
                        <T style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>
                          {dmy(t.startDate) + ' – ' + dmy(t.endDate)}
                        </T>
                        <Badge tone={tone}>{t.syncState === 'queued' ? 'Not sent' : t.state}</Badge>
                      </View>
                      <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 4 }}>
                        {[cities.join(', ') || null, t.purpose].filter(Boolean).join(' · ')}
                      </T>
                      {/* The manager's own words. A refusal with no reason is one
                          he will simply put in again next week. */}
                      {t.decisionNote ? (
                        <T
                          style={{
                            fontSize: 13,
                            lineHeight: 18,
                            fontStyle: 'italic',
                            color: t.state === 'Rejected' ? C.danger : C.muted,
                            marginTop: 4,
                          }}>
                          “{t.decisionNote}”
                        </T>
                      ) : null}
                    </View>
                  );
                })}
              </GroupCard>
            </>
          ) : null}

          {allJourneysLink}
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {/* The last fortnight, most recent first — what was asked, what was
              said, and for a day that was routed, how much of it got walked. A
              row opens the day — which shops, and what each came to. It was
              read-only text, so "what happened at Patil's?" had no answer on the
              phone of the man who was there. */}
          {recent.length ? (
            <GroupCard>
              {recent.map((d) => {
                const c = pastCounts[d.planDate];
                const disc = pastDisc(d, c);
                return (
                  <DayRow
                    key={d.id}
                    disc={disc}
                    title={dayLabel(d.planDate) + (whereOf(d) ? ' · ' + whereOf(d) : '')}
                    line={recentSummary(d, c)}
                    onPress={() => setPastOpen(d)}
                  />
                );
              })}
            </GroupCard>
          ) : (
            <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, paddingHorizontal: 6 }}>No past journeys on this phone yet.</T>
          )}
          {allJourneysLink}
        </View>
      )}

      <PastDaySheet key={pastOpen?.id ?? 'none'} day={pastOpen} today={today} onClose={() => setPastOpen(null)} />
      <PlannedDaySheet
        key={plannedOpen?.id ?? 'none'}
        day={plannedOpen}
        today={today}
        onClose={() => setPlannedOpen(null)}
        onChanged={() => void planDays(historyFrom).then(setDays)}
      />

      {/* ------------------------------------------------- plan your own day */}
      <BottomSheet open={ownOpen} onClose={() => setOwnOpen(false)} scroll>
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>Plan a day</T>
        <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2 }}>Manager is told. Shops next.</T>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={own.date ? 'Which day, ' + dmy(own.date) : 'Which day, pick a date'}
            onPress={() => setOwnPick(true)}
            style={{ flex: 1 }}>
            <FieldBox icon="cal">
              <T numberOfLines={1} style={[{ fontSize: 15, color: own.date ? C.ink : C.faint }, weight(600)]}>
                {own.date ? dmy(own.date) : 'Which day'}
              </T>
            </FieldBox>
          </Pressable>
          <FieldBox icon="visit" style={{ flex: 1 }}>
            <Input
              value={own.city}
              accessibilityLabel="Which city"
              onChangeText={(v) => {
                setOwn((d) => ({ ...d, city: v }));
                setOwnErr(null);
              }}
              placeholder="Nagpur"
              style={bareInput}
            />
          </FieldBox>
        </View>
        {/* Said before the picker opens, not after it has drawn the wrong list:
            the shop list is filtered by this and by nothing else. */}
        <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 6 }}>
          Shops are offered from this city. Past days are greyed in the calendar.
        </T>

        {ownErr ? <T style={[{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 8 }, weight(600)]}>{ownErr}</T> : null}

        <SheetActions
          onCancel={() => setOwnOpen(false)}
          label={ownBusy ? 'Saving…' : 'Plan it'}
          onPress={() => void startOwnDay()}
        />
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
          disabledReason={(iso) => (iso < today ? 'That day has passed.' : null)}
          onPick={(iso) => {
            setOwn((d) => ({ ...d, date: iso }));
            setOwnErr(null);
            setOwnPick(false);
          }}
        />
      </BottomSheet>

      {/* ------------------------------------------------- route actions
          Four tiles and a wide one, as V3 draws it. Each closes the sheet
          first and then runs — the order `ActionSheet` keeps. */}
      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)}>
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
          Route
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
          {routeActions.slice(0, 4).map((a, i) => (
            <Pressable
              key={a.label}
              accessibilityRole="button"
              accessibilityLabel={a.label + '. ' + a.sub}
              onPress={() => {
                setMoreOpen(false);
                a.run();
              }}
              style={({ pressed }) => ({
                width: '48%',
                flexGrow: 1,
                minHeight: 96,
                borderRadius: 20,
                padding: 12,
                justifyContent: 'space-between',
                backgroundColor: pressed ? C.primaryEdge : i === 0 ? C.primaryTint : C.wash,
              })}>
              <Icon name={a.glyph} size={22} color={i === 0 ? C.primaryDeep : C.ink} strokeWidth={2} />
              <View>
                <T style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>{a.short}</T>
                <T style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }}>{a.shortSub}</T>
              </View>
            </Pressable>
          ))}
        </View>
        {routeActions.slice(4).map((a) => (
          <Pressable
            key={a.label}
            accessibilityRole="button"
            accessibilityLabel={a.label + '. ' + a.sub}
            onPress={() => {
              setMoreOpen(false);
              a.run();
            }}
            style={({ pressed }) => ({
              marginTop: 10,
              minHeight: 60,
              paddingVertical: 10,
              borderRadius: 20,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              backgroundColor: pressed ? C.primaryEdge : C.wash,
            })}>
            <Icon name={a.glyph} size={22} color={C.ink} strokeWidth={2} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>{a.short}</T>
              <T style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }}>{a.shortSub}</T>
            </View>
          </Pressable>
        ))}
      </BottomSheet>

      {/* ---- requesting a tour ---- */}
      <BottomSheet open={tourOpen} onClose={() => setTourOpen(false)} scroll>
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>Request a tour</T>
        <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2 }}>
          Manager decides. Not the same as agreeing a given day.
        </T>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          {(['from', 'to'] as const).map((k) => (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={(k === 'from' ? 'From' : 'To') + ', ' + (tour[k] ? dmy(tour[k]) : 'pick a date')}
              onPress={() => setTourPick(k)}
              style={{ flex: 1, minWidth: 0 }}>
              <FieldBox focused={tourPick === k}>
                <T style={{ fontSize: 11, color: C.muted }}>{k === 'from' ? 'From' : 'To'}</T>
                <T style={[{ fontSize: 15, lineHeight: 21, color: tour[k] ? C.ink : C.faint }, weight(tour[k] ? 700 : 600)]}>
                  {tour[k] ? dmy(tour[k]) : 'Pick'}
                </T>
              </FieldBox>
            </Pressable>
          ))}
        </View>

        <FieldBox icon="visit" style={{ marginTop: 10 }}>
          <Input
            value={tour.cities}
            accessibilityLabel="Where, one or more cities"
            onChangeText={(v) => setTour((t) => ({ ...t, cities: v }))}
            placeholder="Nagpur, Amravati"
            style={bareInput}
          />
        </FieldBox>

        <View style={{ marginTop: 10 }}>
          <VoiceField
            value={tour.purpose}
            accessibilityLabel="Why"
            onChangeText={(v) => setTour((t) => ({ ...t, purpose: v }))}
            placeholder="Why — open a new dealer, three late accounts"
          />
        </View>

        <FieldBox style={{ marginTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T style={[{ fontSize: 15, color: C.primaryDeep }, weight(700)]}>₹</T>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Input
                value={tour.cost}
                accessibilityLabel="About how much it will cost in rupees, if you know"
                onChangeText={(v) => setTour((t) => ({ ...t, cost: cleanAmount(v) }))}
                keyboardType="decimal-pad"
                placeholder="About 4500, if you know"
                style={bareInput}
              />
            </View>
          </View>
        </FieldBox>

        {tourErr ? <T style={[{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 8 }, weight(600)]}>{tourErr}</T> : null}

        <SheetActions
          onCancel={() => setTourOpen(false)}
          label={tourBusy ? 'Sending…' : 'Send request'}
          busy={tourBusy}
          onPress={() => void sendTour()}
        />
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

/** The white card that sits across the hero's edge. */
const heroCard = {
  backgroundColor: C.surface,
  borderRadius: 24,
  padding: 18,
  boxShadow: '0 14px 34px -12px rgba(15,27,51,0.28)',
} as const;

/** A shop or a city at the top of a card. */
const cardName = [{ fontSize: 22, lineHeight: 28, letterSpacing: -0.44, color: C.ink }, weight(800)];

/** An `Input` sitting inside a `FieldBox`, which draws the edge itself. */
const bareInput = {
  borderWidth: 0,
  minHeight: 54,
  paddingHorizontal: 0,
  backgroundColor: 'transparent',
} as const;

/**
 * How long a proposal has been waiting on him, in words, and whether it is old
 * enough to colour.
 *
 * Null where the office did not record when it asked — every plan written
 * before the negotiation existed is in that state, and "proposed 20,214 days
 * ago" from a null read as an epoch is worse than saying nothing.
 *
 * `now` is passed in rather than read here: this is called during render, and
 * reading `Date.now()` from inside a render is what the React Compiler rules in
 * this app forbid.
 */
function waitingChip(proposedAt: number | null, now: number): { text: string; said: string; old: boolean } | null {
  if (!proposedAt) return null;
  const days = Math.floor((now - proposedAt) / 86_400_000);
  if (days <= 0) return { text: 'Asked today', said: 'asked today', old: false };
  if (days === 1) return { text: '1 day', said: 'asked yesterday', old: true };
  return { text: days + ' days', said: 'waiting ' + days + ' days', old: true };
}

/** A row of the Ahead and Past lists: a disc, a day, a line, and where it opens. */
function DayRow({
  icon,
  bg = C.wash,
  ink = C.muted,
  disc,
  title,
  line,
  lineColor = C.muted,
  warning,
  a11y,
  onPress,
}: {
  icon?: IconName;
  bg?: string;
  ink?: string;
  disc?: React.ReactNode;
  title: string;
  line?: string | null;
  lineColor?: string;
  warning?: string | null;
  a11y?: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      {disc ?? <Disc icon={icon} bg={bg} ink={ink} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(700)]}>
          {title}
        </T>
        {line ? (
          <T style={[{ fontSize: 12, lineHeight: 16, color: lineColor }, weight(lineColor === C.muted ? 400 : 600)]}>{line}</T>
        ) : null}
        {warning ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="warn" size={12} color={C.warnInk} strokeWidth={2.2} />
            <T style={[{ flex: 1, fontSize: 12, lineHeight: 16, color: C.warnInk }, weight(600)]}>{warning}</T>
          </View>
        ) : null}
      </View>
      {onPress ? <Icon name="forward" size={16} color={C.faint} strokeWidth={2} /> : null}
    </>
  );
  const row = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 } as const;
  if (!onPress) return <View style={row}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, line, a11y, warning].filter(Boolean).join('. ')}
      style={({ pressed }) => [row, pressed && { opacity: 0.7 }]}>
      {body}
    </Pressable>
  );
}

/** The disc on a past day: the walked count where there is one, else its state. */
function pastDisc(d: PlanDay, c: { total: number; done: number } | undefined): React.ReactNode {
  if (d.dayState === 'planned' && c && c.total > 0) {
    const all = c.done === c.total;
    return (
      <Disc
        text={c.done + '/' + c.total}
        bg={all ? C.successBg : C.warnBg}
        ink={all ? C.success : C.warnInk}
        a11y={c.done + ' of ' + c.total + ' visited'}
      />
    );
  }
  if (d.dayState === 'refused') return <Disc icon="back" bg={C.dangerBg} ink={C.danger} a11y="Sent back" />;
  if (d.dayState === 'agreed') return <Disc icon="shop" />;
  return <Disc icon="cal" />;
}

/**
 * THE LINE UNDER THE COUNT, AND WHY IT LEADS ON STOPS RATHER THAN AREAS.
 *
 * It used to be `areas.length ? areas : 'Nothing planned for today'`, and
 * `areas` is built only from stops still PLANNED that carry a non-null `area`.
 * Most of this imported book has no area recorded, so an ordinary route
 * printed "Nothing planned for today" directly beneath "2 of 8 done" — and
 * once the last stop was visited `areas` was empty by construction, so every
 * finished day ended on that same sentence too.
 *
 * The stop count is the fact that is always true, so it answers first. The
 * areas are the detail, appended — comma-separated, which reads the way a list
 * is said and never as "A and B and C and D" — only when there are any.
 */
const TODAY_STATE: Record<PlanDay['dayState'], string> = {
  proposed: 'proposed by the office — agree it under Ahead',
  refused: 'you sent it back — waiting on the office',
  agreed: 'agreed — pick your shops',
  planned: 'planned',
};

function routeSubline(total: number, done: number, areas: string[]): string {
  if (total === 0) return 'Nothing planned for today';
  if (done >= total) return 'All ' + plural(total, 'stop') + ' done';
  const left = total - done + ' to go';
  return areas.length ? left + ' · ' + areas.join(', ') : left;
}

/**
 * THE WEEK AHEAD, by city.
 *
 * He plans a week, not a morning, and the only place the cities of the coming
 * days could be read was a tab of lists or a calendar of dots. Seven tiles,
 * today first: the day, the city, and what state it is in. A day with nothing
 * says so rather than being left out, because a gap is what he needs to see.
 */
function WeekStrip({ days, today }: { days: PlanDay[]; today: string }) {
  const [y, m, d] = today.split('-').map(Number);
  const week = Array.from({ length: 7 }, (_, i) => isoDate(new Date(y, m - 1, d + i)));
  const word: Record<PlanDay['dayState'], string> = {
    proposed: 'To agree',
    refused: 'Sent back',
    agreed: 'Pick shops',
    planned: 'Planned',
  };
  const legend: { tone: string; label: string }[] = [
    { tone: DAY_TONE.planned, label: 'Planned' },
    { tone: DAY_TONE.proposed, label: 'To agree' },
    { tone: DAY_TONE.agreed, label: 'Pick shops' },
    { tone: DAY_TONE.refused, label: 'Sent back' },
    { tone: DAY_TONE.none, label: 'Nothing yet' },
  ];
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
        <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink, flex: 1 }, weight(700)]}>
          Week
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Calendar"
          hitSlop={HIT / 3}
          onPress={() => router.push('/journeys')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 }}>
          <Icon name="cal" size={14} color={C.primaryDeep} strokeWidth={2} />
          <T style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(600)]}>Calendar ›</T>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', gap: 5, marginTop: 8 }}>
        {week.map((iso) => {
          const day = days.find((x) => x.planDate === iso);
          const isToday = iso === today;
          const where = whereOf(day);
          return (
            <Pressable
              key={iso}
              accessibilityRole="button"
              accessibilityLabel={
                dayLabelRelative(iso, today) +
                ', ' +
                (day ? (where ?? 'no city') + ', ' + word[day.dayState] : 'nothing planned')
              }
              onPress={() => router.push('/journeys')}
              style={({ pressed }) => ({
                flex: 1,
                minWidth: 0,
                minHeight: 64,
                paddingVertical: 8,
                paddingHorizontal: 2,
                borderRadius: 14,
                alignItems: 'center',
                backgroundColor: isToday ? C.navy : pressed ? C.primaryTint : C.surface,
              })}>
              <T style={{ fontSize: 11, lineHeight: 14, color: isToday ? C.onNavyMuted : C.muted }}>
                {dayLabel(iso).slice(0, 3)}
              </T>
              <T
                numberOfLines={1}
                style={[
                  { fontSize: 11, lineHeight: 14, marginTop: 3, color: isToday ? '#FFFFFF' : where ? C.ink : C.faint },
                  weight(700),
                ]}>
                {where ?? '—'}
              </T>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  marginTop: 5,
                  backgroundColor: day ? (isToday && day.dayState === 'planned' ? C.lime : DAY_TONE[day.dayState]) : DAY_TONE.none,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8, paddingHorizontal: 6 }}>
        {legend.map((l) => (
          <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: l.tone }} />
            <T style={{ fontSize: 11, lineHeight: 14, color: C.muted }}>{l.label}</T>
          </View>
        ))}
      </View>
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
  return counts.done === counts.total ? 'All visited' : 'Rest skipped or missed';
}
