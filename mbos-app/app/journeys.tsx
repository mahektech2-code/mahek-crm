import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Input, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { Stagger, Swap } from '../src/components/ui/motion';
import { color as C, weight } from '../src/theme/tokens';
import {
  JOURNEY_HISTORY_DAYS,
  journeyDays,
  stopsOn,
  type JourneyDay,
  type JourneyStop,
  whereOf,
} from '../src/data/journey';
import {
  acceptAreas,
  acceptedNow,
  areaLabel,
  askForDifferentAreas,
  myAreas,
  pendingChange,
  territoryRequests,
  type MyAreas,
  type TerritoryRequest,
} from '../src/data/territory';
import { dayLabel, dayLabelRelative, dmy, hhmm, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { PastDaySheet, PlannedDaySheet } from '../src/components/journey/day-sheets';
import {
  DAY_FILL,
  DAY_TONE,
  Disc,
  FieldBox,
  GroupCard,
  GroupTitle,
  Pill,
  PillButton,
  SheetActions,
  SwitchTabs,
} from '../src/components/ui/v3';

/**
 * YOUR JOURNEYS — every day the office has planned with you, past and coming,
 * as a list or as a calendar, with each day open in full: the city, how it was
 * agreed, and every shop with what became of it.
 *
 * And above them, WHERE YOU WORK: the cities and areas allocated to you, which
 * you accept as they stand or ask to change. A change goes to your manager on
 * the Approvals queue, the same way a tour request does, and the answer comes
 * back here.
 *
 * The journey tab keeps today's route and the questions waiting on you; this
 * is the record and the calendar behind it.
 */

type View_ = 'list' | 'calendar';

/** The state badge, in the V3 pill colours. */
const STATE_WORDS: Record<JourneyDay['dayState'], { label: string; bg: string; fg: string }> = {
  proposed: { label: 'To agree', bg: C.warnBg, fg: C.warnInk },
  refused: { label: 'Sent back', bg: C.dangerBg, fg: C.danger },
  agreed: { label: 'Agreed', bg: DAY_FILL.agreed, fg: DAY_TONE.agreed },
  planned: { label: 'Planned', bg: '#E3F4F2', fg: '#0F766E' },
};

/** Where a day was, as its row's heading reads it. */
function dayWhere(d: JourneyDay): string {
  return whereOf(d) ? whereOf(d) + (d.beat ? ' · ' + d.beat : '') : 'No city set';
}

/** What a day came to, without the place — the row's second line. */
function dayDetail(d: JourneyDay, today: string): string {
  if (d.dayState === 'refused') return 'Sent back' + (d.refusalReason ? ' — ' + d.refusalReason : '');
  if (d.dayState === 'proposed') return d.planDate < today ? 'Never answered' : 'Waiting on your answer';
  if (d.dayState === 'agreed') return d.planDate < today ? 'No shops were picked' : 'Pick your shops';
  if (!d.stops) return 'No shops on it';
  if (d.planDate > today) return plural(d.stops, 'shop');
  return d.visited + '/' + d.stops + ' visited' + (d.skipped ? ' · ' + d.skipped + ' skipped' : '');
}

/** What a day comes down to, in one line. */
function dayLine(d: JourneyDay, today: string): string {
  return dayWhere(d) + ' · ' + dayDetail(d, today);
}

/** A day's dot on the calendar: what kind of day it was, at a glance. */
function dotColour(d: JourneyDay, today: string): string {
  if (d.dayState === 'refused') return C.danger;
  if (d.dayState === 'proposed') return DAY_TONE.proposed;
  if (d.dayState === 'agreed') return DAY_TONE.agreed;
  /* TODAY IS STILL BEING WORKED, so it is not judged yet. Reading it as a
     past day painted "2 of 6 visited" at noon amber — the colour that means a
     day only partly done, and the colour of a day still waiting on an answer
     beside it. A verdict belongs to a day that is over. */
  if (d.planDate >= today) return C.primary;
  if (!d.stops) return C.faint;
  return d.visited === d.stops ? C.success : d.visited ? DAY_TONE.proposed : C.danger;
}

/** The calendar cell's fill and ink for a day, from the same verdict as the dot. */
function cellTone(d: JourneyDay, today: string): { fill: string; ink: string; label: string } {
  const dot = dotColour(d, today);
  if (dot === C.success) return { fill: C.successBg, ink: C.success, label: C.success };
  if (dot === DAY_TONE.proposed) return { fill: C.warnBg, ink: C.warnInk, label: C.warnInk };
  if (dot === C.danger) return { fill: C.dangerBg, ink: C.danger, label: C.danger };
  if (dot === DAY_TONE.agreed) return { fill: DAY_FILL.agreed, ink: DAY_TONE.agreed, label: DAY_TONE.agreed };
  if (dot === C.primary) return { fill: C.primaryTint, ink: C.primaryDeep, label: C.primary };
  return { fill: C.wash, ink: C.muted, label: C.muted };
}

export default function JourneysScreen() {
  const back = useCameFrom('journey');
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const [now] = React.useState(() => Date.now());
  const today = isoDate(new Date(now));
  const from = isoDate(new Date(now - JOURNEY_HISTORY_DAYS * 86_400_000));

  const [view, setView] = React.useState<View_>('list');
  const [days, setDays] = React.useState<JourneyDay[]>([]);
  const [areas, setAreas] = React.useState<MyAreas | null>(null);
  const [requests, setRequests] = React.useState<TerritoryRequest[]>([]);
  const [open, setOpen] = React.useState<JourneyDay | null>(null);
  const [stops, setStops] = React.useState<(JourneyStop & { city: string | null })[]>([]);
  const [asking, setAsking] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    void journeyDays(from).then((r) => live && setDays(r));
    void myAreas().then((r) => live && setAreas(r));
    void territoryRequests().then((r) => live && setRequests(r));
    return () => {
      live = false;
    };
  }, [from]);
  useFocusEffect(load);

  /* A day behind him and a planned day ahead open the same sheets the
     Journey tabs do — one with what happened at each shop, one that can
     change the plan — so a day reads the same whichever screen it was tapped
     on. Today and a day still being agreed keep the sheet below. */
  const [pastOpen, setPastOpen] = React.useState<JourneyDay | null>(null);
  const [plannedOpen, setPlannedOpen] = React.useState<JourneyDay | null>(null);
  const openDay = (d: JourneyDay) => {
    if (d.planDate < today) return setPastOpen(d);
    if (d.planDate > today && d.dayState === 'planned') return setPlannedOpen(d);
    setOpen(d);
    setStops([]);
    void stopsOn(d.planDate).then(setStops);
  };

  const upcoming = days.filter((d) => d.planDate >= today);
  const past = days.filter((d) => d.planDate < today).reverse();

  const accept = async () => {
    const out = await acceptAreas();
    if (!out.ok) return notify(out.message, 'error');
    notify('Accepted. Your manager can see it.');
    load();
  };

  return (
    <AppFrame
      title="Journeys"
      activeTab={null}
      onBack={back.go}
      tone="lavender"
      hero={
        <AreasCard
          areas={areas}
          requests={requests}
          onAccept={() => void accept()}
          onAsk={() => setAsking(true)}
        />
      }
      contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 32 }}>
      <SwitchTabs
        options={[
          { key: 'list', label: 'List', icon: 'grid' },
          { key: 'calendar', label: 'Calendar', icon: 'cal' },
        ]}
        value={view}
        onChange={setView}
      />

      {/* The same days, two ways of looking at them — so the switch swaps in
          place rather than sliding, which would claim one view is deeper than
          the other. */}
      <Swap id={view}>
      {view === 'calendar' ? (
        <View style={{ marginTop: 10 }}>
          <MonthCalendar days={days} today={today} from={from} onPick={openDay} />
        </View>
      ) : (
        <View style={{ gap: 10, marginTop: 10 }}>
          <GroupTitle style={{ paddingTop: 4 }}>{upcoming.length ? 'Coming up' : 'Nothing planned ahead yet'}</GroupTitle>
          {upcoming.length ? (
            <GroupCard>
              {upcoming.map((d, i) => (
                <Stagger key={d.id} index={i}>
                  <DayRow d={d} today={today} onPress={() => openDay(d)} />
                </Stagger>
              ))}
            </GroupCard>
          ) : null}
          <GroupTitle style={{ paddingTop: 4 }}>
            {past.length ? 'Last ' + JOURNEY_HISTORY_DAYS + ' days' : 'No past journeys on this phone'}
          </GroupTitle>
          {past.length ? (
            <GroupCard>
              {past.map((d) => (
                <DayRow key={d.id} d={d} today={today} onPress={() => openDay(d)} />
              ))}
            </GroupCard>
          ) : null}
        </View>
      )}
      </Swap>

      <PastDaySheet key={pastOpen?.id ?? 'none'} day={pastOpen} today={today} onClose={() => setPastOpen(null)} />
      <PlannedDaySheet
        key={plannedOpen?.id ?? 'none'}
        day={plannedOpen}
        today={today}
        onClose={() => setPlannedOpen(null)}
        onChanged={() => void journeyDays(from).then(setDays)}
      />
      <DaySheet
        day={open}
        stops={stops}
        today={today}
        onClose={() => setOpen(null)}
        onOpenShop={(id) => {
          set({ custId: id });
          router.push('/customer?from=journeys');
        }}
      />

      <AskSheet
        key={asking ? 'open' : 'shut'}
        open={asking}
        current={areas?.areas.map(areaLabel) ?? []}
        onClose={() => setAsking(false)}
        onSent={() => {
          setAsking(false);
          notify('Sent to your manager. The answer will show here.');
          load();
        }}
      />
    </AppFrame>
  );
}

/* ------------------------------------------------------------ where you work */

function AreasCard({
  areas,
  requests,
  onAccept,
  onAsk,
}: {
  areas: MyAreas | null;
  requests: TerritoryRequest[];
  onAccept: () => void;
  onAsk: () => void;
}) {
  const list = areas?.areas ?? [];
  const accepted = areas ? acceptedNow(requests, areas.signature) : null;
  const waiting = pendingChange(requests);
  const lastAnswered = requests.find((r) => r.kind === 'change' && r.state !== 'pending');

  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 14, marginTop: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="visit" size={14} color={C.lavenderMuted} strokeWidth={2} />
        <T style={[{ flex: 1, fontSize: 13, color: C.lavenderMuted }, weight(700)]}>Where you work</T>
        {accepted ? (
          <View
            accessible
            accessibilityLabel={
              'You accepted these on ' +
              dmy(isoDate(new Date(accepted.clientCreatedAt))) +
              (accepted.syncState === 'queued' ? ', waiting for signal' : '')
            }
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="tick" size={12} color={C.success} strokeWidth={2.4} />
            <T style={[{ fontSize: 12, color: C.success }, weight(700)]}>
              {dmy(isoDate(new Date(accepted.clientCreatedAt))) + (accepted.syncState === 'queued' ? ' · unsent' : '')}
            </T>
          </View>
        ) : null}
      </View>

      {areas?.state?.exempt ? (
        <T style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 10 }}>
          You see the whole book — managers are not limited to an area.
        </T>
      ) : list.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {list.map((a) => (
            <Pill key={a.kind + a.value + (a.parent ?? '')} text={areaLabel(a)} bg={C.primaryTint} fg={C.primaryDeep} height={32} />
          ))}
        </View>
      ) : (
        <View style={[boxStyle, { backgroundColor: C.warnBg }]}>
          <Icon name="warn" size={16} color={C.warnInk} strokeWidth={2} />
          <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
            No area allocated yet, so your customer list is empty. Ask your manager, or ask for the cities you work below.
          </T>
        </View>
      )}

      {waiting ? (
        <View style={[boxStyle, { backgroundColor: C.warnBg }]}>
          <Icon name="clock" size={16} color={C.warnInk} strokeWidth={2} />
          <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
            {'Asked: ' +
              waiting.requestedPlaces.join(', ') +
              ' · with manager' +
              (waiting.syncState === 'queued' ? ' · not sent, no signal' : '')}
          </T>
        </View>
      ) : lastAnswered ? (
        <View style={[boxStyle, { backgroundColor: lastAnswered.state === 'approved' ? C.successBg : C.dangerBg }]}>
          <Icon
            name={lastAnswered.state === 'approved' ? 'tick' : 'close'}
            size={16}
            color={lastAnswered.state === 'approved' ? C.success : C.danger}
            strokeWidth={2.2}
          />
          <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.ink }}>
            {lastAnswered.requestedPlaces.join(', ') +
              ' · ' +
              (lastAnswered.state === 'approved' ? 'approved' : 'not approved') +
              (lastAnswered.decisionNote ? ' — “' + lastAnswered.decisionNote + '”' : '')}
          </T>
        </View>
      ) : null}

      {!areas?.state?.exempt && ((list.length && !accepted) || !waiting) ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          {list.length && !accepted ? (
            <PillButton label="Accept these" variant="navyLime" height={48} onPress={onAccept} style={{ flex: 1 }} />
          ) : null}
          {!waiting ? (
            <PillButton
              label="Ask for others"
              a11y="Ask for different cities"
              variant="outline"
              height={48}
              onPress={onAsk}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const boxStyle = {
  marginTop: 10,
  paddingVertical: 10,
  paddingHorizontal: 12,
  borderRadius: 16,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
} as const;

function AskSheet({
  open,
  current,
  onClose,
  onSent,
}: {
  open: boolean;
  current: string[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [places, setPlaces] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const send = async () => {
    setBusy(true);
    setErr(null);
    const out = await askForDifferentAreas({ places: places.split(','), reason });
    setBusy(false);
    if (!out.ok) return setErr(out.message);
    onSent();
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 20, color: C.ink }, weight(800)]}>Ask for other cities</T>
      <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2 }}>
        Manager decides. Until then: {current.length ? current.join(', ') : 'as you are'}.
      </T>

      <FieldBox icon="visit" style={{ marginTop: 12 }}>
        <Input
          value={places}
          accessibilityLabel="Which cities or areas, comma between them"
          onChangeText={(v) => {
            setPlaces(v);
            setErr(null);
          }}
          placeholder="Nagpur, Wardha"
          style={bareInput}
        />
      </FieldBox>

      <View style={{ marginTop: 10 }}>
        <VoiceField
          value={reason}
          accessibilityLabel="Why"
          onChangeText={(v) => {
            setReason(v);
            setErr(null);
          }}
          placeholder="Why — I live in Wardha and know the dealers there"
        />
      </View>

      {err ? <T style={[{ fontSize: 13, color: C.danger, marginTop: 8 }, weight(600)]}>{err}</T> : null}

      <SheetActions
        onCancel={onClose}
        label={busy ? 'Sending…' : 'Send to manager'}
        busy={busy}
        onPress={() => void send()}
      />
    </BottomSheet>
  );
}

/** An `Input` inside a `FieldBox`, which draws the edge itself. */
const bareInput = { borderWidth: 0, minHeight: 54, paddingHorizontal: 0, backgroundColor: 'transparent' } as const;

/* --------------------------------------------------------------- the journeys */

function DayRow({ d, today, onPress }: { d: JourneyDay; today: string; onPress: () => void }) {
  const words = STATE_WORDS[d.dayState] ?? STATE_WORDS.planned;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dayLabelRelative(d.planDate, today) + ', ' + words.label + '. ' + dayLine(d, today)}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 62,
        paddingVertical: 10,
        opacity: pressed ? 0.7 : 1,
      })}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColour(d, today) }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(700)]}>
          {dayLabelRelative(d.planDate, today) + ' · ' + dayWhere(d)}
        </T>
        <T numberOfLines={2} style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
          {dayDetail(d, today)}
        </T>
      </View>
      <Pill text={words.label} bg={words.bg} fg={words.fg} height={26} />
      <Icon name="forward" size={16} color={C.faint} strokeWidth={2} />
    </Pressable>
  );
}

/**
 * A month at a time, Monday first, moving only across the months this phone
 * holds days for — a calendar that opens on months the pull never sent would
 * read as months nothing happened in.
 */
function MonthCalendar({
  days,
  today,
  from,
  onPick,
}: {
  days: JourneyDay[];
  today: string;
  from: string;
  onPick: (d: JourneyDay) => void;
}) {
  const byDate = React.useMemo(() => new Map(days.map((d) => [d.planDate, d])), [days]);
  const lastDate = days.length ? days[days.length - 1].planDate : today;
  const monthOf = (iso: string) => iso.slice(0, 7);
  const first = monthOf(from);
  const last = monthOf(lastDate > today ? lastDate : today);
  const [month, setMonth] = React.useState(monthOf(today));

  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const lead = (start.getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(isoDate(new Date(y, m - 1, d)));
  while (cells.length % 7) cells.push(null);

  const shift = (by: number) => setMonth(monthOf(isoDate(new Date(y, m - 1 + by, 1))));
  const title = start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const arrow = (dir: -1 | 1, off: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir < 0 ? 'Previous month' : 'Next month'}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={() => shift(dir)}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: C.wash,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: off ? 0.35 : 1,
      }}>
      <Icon name={dir < 0 ? 'back' : 'forward'} size={18} color={C.ink} strokeWidth={2} />
    </Pressable>
  );

  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 24, padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {arrow(-1, month <= first)}
        <T style={[{ flex: 1, fontSize: 17, color: C.ink, textAlign: 'center' }, weight(800)]}>{title}</T>
        {arrow(1, month >= last)}
      </View>

      <View style={{ flexDirection: 'row', marginTop: 10 }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => (
          <T key={i} style={[{ flex: 1, textAlign: 'center', fontSize: 12, color: C.faint }, weight(600)]}>
            {w}
          </T>
        ))}
      </View>

      {/* A new month settles in where the old one was. */}
      <Swap id={month}>
      <View style={{ marginTop: 4, gap: 4 }}>
      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <View key={row} style={{ flexDirection: 'row' }}>
          {cells.slice(row * 7, row * 7 + 7).map((iso, i) => {
            const d = iso ? byDate.get(iso) : undefined;
            const isToday = iso === today;
            const tone = d ? cellTone(d, today) : null;
            return (
              <Pressable
                key={i}
                disabled={!d}
                accessibilityRole={d ? 'button' : undefined}
                accessibilityLabel={d && iso ? dayLabel(iso) + ', ' + dayLine(d, today) : undefined}
                onPress={() => d && onPick(d)}
                style={{ flex: 1, alignItems: 'center', minHeight: 48, paddingHorizontal: 1 }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: isToday && !d ? 1.5 : 0,
                    borderColor: C.navy,
                    backgroundColor: isToday && d ? C.navy : tone ? tone.fill : 'transparent',
                  }}>
                  <T
                    style={[
                      {
                        fontSize: 14,
                        color: iso ? (isToday && d ? C.lime : tone ? tone.ink : C.faint) : 'transparent',
                      },
                      weight(d ? 800 : 400),
                    ]}>
                    {iso ? String(Number(iso.slice(8))) : ''}
                  </T>
                </View>
                {/* THE CITY, not only a dot. A month of coloured dots said
                    how far each day had got and never where it was, which is
                    the thing a salesman planning his week reads first. */}
                {d && tone ? (
                  <T
                    numberOfLines={1}
                    style={[{ fontSize: 9, lineHeight: 12, maxWidth: '100%', color: tone.label }, weight(700)]}>
                    {whereOf(d) ?? '•'}
                  </T>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
      </View>
      </Swap>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {[
          { bg: C.successBg, fg: C.success, l: 'All visited' },
          { bg: C.warnBg, fg: C.warnInk, l: 'Part / to agree' },
          { bg: C.dangerBg, fg: C.danger, l: 'Missed / sent back' },
          { bg: C.primaryTint, fg: C.primaryDeep, l: 'Planned / today' },
          { bg: DAY_FILL.agreed, fg: DAY_TONE.agreed, l: 'Agreed, no shops' },
        ].map((k) => (
          <Pill key={k.l} text={k.l} bg={k.bg} fg={k.fg} height={28} />
        ))}
      </View>
    </View>
  );
}

/** One day in full: where, how it was agreed, and every shop on it. */
function DaySheet({
  day,
  stops,
  today,
  onClose,
  onOpenShop,
}: {
  day: JourneyDay | null;
  stops: (JourneyStop & { city: string | null })[];
  today: string;
  onClose: () => void;
  onOpenShop: (customerId: string) => void;
}) {
  if (!day) return <BottomSheet open={false} onClose={onClose}>{null}</BottomSheet>;
  const words = STATE_WORDS[day.dayState] ?? STATE_WORDS.planned;
  const future = day.planDate >= today;

  return (
    <BottomSheet open onClose={onClose} scroll>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T style={[{ flex: 1, fontSize: 13, color: C.muted }, weight(700)]}>{dayLabel(day.planDate)}</T>
        <Pill text={words.label} bg={words.bg} fg={words.fg} height={26} />
      </View>
      <T style={[{ fontSize: 22, lineHeight: 28, color: C.ink, marginTop: 4 }, weight(800)]}>{dayWhere(day)}</T>
      <T style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>{dayDetail(day, today)}</T>
      {day.proposedBy || day.counterCity ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {day.proposedBy ? (
            <Pill
              text={day.proposedBy + (day.proposedAt ? ' · ' + dmy(isoDate(new Date(day.proposedAt))) : '')}
              icon="person"
              height={28}
              a11y={
                'Proposed by ' + day.proposedBy + (day.proposedAt ? ' on ' + dmy(isoDate(new Date(day.proposedAt))) : '')
              }
            />
          ) : null}
          {day.counterCity ? (
            <Pill text={'You asked: ' + day.counterCity} height={28} a11y={'You asked for ' + day.counterCity + ' instead'} />
          ) : null}
        </View>
      ) : null}

      <T style={[{ fontSize: 15, color: C.ink, marginTop: 14 }, weight(700)]}>
        {stops.length ? plural(stops.length, 'shop') : 'Shops'}
      </T>
      {stops.length ? (
        stops.map((s, i) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityLabel={'Open ' + s.customerName}
            onPress={() => {
              onClose();
              onOpenShop(s.customerId);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              minHeight: 56,
              paddingVertical: 8,
              borderBottomWidth: i === stops.length - 1 ? 0 : 1,
              borderBottomColor: C.hairline,
              opacity: pressed ? 0.7 : 1,
            })}>
            <Disc size={26} text={String(s.seq || i + 1)} ink={C.body} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{s.customerName}</T>
              <T
                style={{
                  fontSize: 12,
                  lineHeight: 16,
                  color: s.status === 'skipped' && s.skipReason ? C.danger : C.muted,
                }}>
                {([s.area, s.city].filter(Boolean).join(', ') || 'No area') +
                  (s.plannedAt ? ' · ' + s.plannedAt : '') +
                  (s.status === 'skipped' && s.skipReason ? ' · skipped — ' + s.skipReason : '')}
              </T>
            </View>
            <StopStatus stop={s} future={future} />
          </Pressable>
        ))
      ) : (
        <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4 }}>
          {day.dayState === 'planned'
            ? 'This day was planned with no shops on it.'
            : future
              ? 'No shops picked yet. Agree the day and pick them on the journey tab.'
              : 'No shops were picked for this day.'}
        </T>
      )}

      <PillButton label="Close" variant="outline" onPress={onClose} style={{ marginTop: 12 }} />
    </BottomSheet>
  );
}

function StopStatus({ stop, future }: { stop: JourneyStop; future: boolean }) {
  if (stop.status === 'visited') {
    return (
      <Pill
        text={stop.actualAt ? hhmm(stop.actualAt) : 'Visited'}
        icon="tick"
        bg={C.successBg}
        fg={C.success}
        height={26}
        a11y={'Visited' + (stop.actualAt ? ' at ' + hhmm(stop.actualAt) : '')}
      />
    );
  }
  if (stop.status === 'skipped') return <Pill text="Skipped" bg={C.dangerBg} fg={C.danger} height={26} />;
  /* Nothing on a day still ahead: every stop on it is planned, the header
     already says so, and seven grey "Planned" pills down one sheet are noise
     the eye has to step over to read the shop names. */
  if (future) return null;
  return <Pill text="Not visited" bg={C.warnBg} fg={C.warnInk} height={26} />;
}
