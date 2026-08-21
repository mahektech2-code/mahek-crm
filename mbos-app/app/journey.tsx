import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { DashedButton, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { ActionSheet } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, shadow, type, weight } from '../src/theme/tokens';
import {
  agreeDay,
  planDays,
  refuseDay,
  saveStopOrder,
  todayStops,
  type JourneyStop,
  type PlanDay,
} from '../src/data/journey';
import { getConfig } from '../src/data/config';
import { optimiseRoute } from '../src/engines/route';
import { fixOf, getFix } from '../src/native/location';
import { inr, plural } from '../src/lib/format';
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
  const beginVisit = useStore((s) => s.beginVisit);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [stops, setStops] = React.useState<JourneyStop[]>([]);
  const [days, setDays] = React.useState<PlanDay[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = React.useCallback(() => {
    let live = true;
    void todayStops().then((r) => {
      if (live) setStops(r);
    });
    void planDays().then((r) => {
      if (live) setDays(r);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  /*
   * The days the office has asked about.
   *
   * A plan is AGREED, not issued: they propose a city, and you are the one who
   * knows whether that market is open on a Wednesday. Only the proposed ones
   * appear — a day already agreed is waiting on you to pick shops, and one
   * already planned is simply the route.
   */
  const asking = days.filter((d) => d.dayState === 'proposed');

  const say = React.useCallback(
    async (day: PlanDay, yes: boolean) => {
      if (yes) {
        await agreeDay(day.id);
        setDays(await planDays());
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
          setDays(await planDays());
          notify('Sent back to your manager.');
        },
      });
    },
    [askConfirm, notify],
  );

  const doneCount = stops.filter((x) => x.status === 'visited').length;
  const next = stops.find((x) => x.status === 'planned');
  const areas = Array.from(new Set(stops.filter((x) => x.status === 'planned').map((x) => x.area).filter(Boolean)));

  /* Late against the plan, not against a constant — a stop whose planned time
     has passed and which has not been made yet is the definition of behind. */
  const late = !!next?.plannedAt && next.plannedAt < hhmm(now);

  const reorder = async () => {
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

  const deviate = () =>
    askConfirm({
      title: 'Add an off-plan stop?',
      body: 'It goes on today’s route and is marked off-plan, so your manager can see why the day changed.',
      reasonLabel: 'Why this stop · required',
      confirmLabel: 'Add the stop',
      run: (reason) => notify('Added off-plan · ' + reason),
    });

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
          {asking.map((d) => (
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
              <T style={[type.body, weight(600), { color: C.ink }]}>{dayLabel(d.planDate)}</T>
              <T s="small" style={{ color: C.body, marginTop: 2 }}>
                {d.city ? d.city + ' was proposed' : 'A day was proposed'}
                {d.proposedBy ? ' by ' + d.proposedBy : ''}
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
          ))}
        </View>
      ) : null}

      {/*
        Days you have agreed and not yet filled.

        Between the two states there is nothing to walk: the office knows you
        will be in Nagpur and does not know which doors. This is the only
        prompt that gets somebody from one to the other, so it sits directly
        under the questions rather than at the bottom of the screen.
      */}
      {days.filter((d) => d.dayState === 'agreed').length ? (
        <View style={{ marginBottom: 16 }}>
          <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
            Agreed — shops to pick
          </T>
          {days
            .filter((d) => d.dayState === 'agreed')
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
                  <T style={[type.body, weight(600), { color: C.ink }]}>{dayLabel(d.planDate)}</T>
                  <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                    {(d.city ? d.city + ' · ' : '') + 'no shops picked yet'}
                  </T>
                </View>
                <Icon name="forward" size={20} color={C.muted} strokeWidth={1.5} />
              </Pressable>
            ))}
        </View>
      ) : null}

      {/* What you have already sent back, so a refusal does not vanish. */}
      {days.filter((d) => d.dayState === 'refused').length ? (
        <View style={{ marginBottom: 16 }}>
          {days
            .filter((d) => d.dayState === 'refused')
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
                  {dayLabel(d.planDate)} — sent back
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

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ minWidth: 0, flex: 1 }}>
          <T style={type.h1}>{doneCount + ' of ' + stops.length + ' done'}</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {areas.length ? areas.join(' and ') : 'Nothing planned for today'}
          </T>
        </View>
        <Pressable
          onPress={() => setMoreOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Route actions"
          style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 20, color: C.muted }}>⋯</T>
        </Pressable>
      </View>

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
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>{next.area ?? ''}</T>
          <T s="small" style={{ marginTop: 10 }}>
            {(next.plannedAt ? 'Planned ' + next.plannedAt + '. ' : '') +
              (next.outstandingPaise > 0
                ? 'They owe ' + inr(next.outstandingPaise / 100) + ' — collection is the reason this stop is on the list.'
                : 'Nothing outstanding against them.')}
          </T>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <SecondaryButton
              label="Navigate"
              onPress={() => notify('Maps to ' + next.customerName)}
              style={{ flex: 1, borderRadius: radius.xl }}
            />
            <PrimaryButton
              label="Start visit"
              onPress={() => {
                beginVisit(next.customerId);
                router.push('/visit');
              }}
              style={{ flex: 1, borderRadius: radius.xl }}
            />
          </View>
        </View>
      ) : null}

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
                onPress={() =>
                  done ? notify(x.customerName + ' · visit already logged today') : notify('Maps to ' + x.customerName)
                }
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
                  <T s="caption" style={{ marginTop: 1 }}>
                    {done
                      ? (x.area ?? '') + ' · arrived ' + (x.actualAt ? hhmm(x.actualAt) : '—')
                      : (x.area ?? '') + (x.plannedAt ? ' · planned ' + x.plannedAt : '')}
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

      <DashedButton
        label="Visiting somewhere not on the plan? Add it — your manager sees the reason."
        onPress={deviate}
        style={{ marginTop: 16 }}
      />

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
            sub: 'Opens every stop in order',
            run: () => notify('Full route sent to maps'),
          },
          { glyph: 'share', label: 'Share the plan', sub: 'To your manager on WhatsApp', run: () => notify('Route shared') },
        ]}
        onClose={() => setMoreOpen(false)}
      />
    </AppFrame>
  );
}

/** 09:41 — the plan's own vocabulary for a time of day. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}


/**
 * `Mon 18 Aug` — a day named the way somebody says it out loud.
 *
 * Built in UTC deliberately: these are calendar days with no time of day in
 * them, so there is no zone to get right, and building them locally is what
 * shifts a date across a DST boundary.
 */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getUTCDay()];
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][at.getUTCMonth()];
  return day + ' ' + at.getUTCDate() + ' ' + month;
}
