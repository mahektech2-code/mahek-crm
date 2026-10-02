import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Input, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet } from '../src/components/ui/overlays';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, shadow, type, weight, type BadgeTone } from '../src/theme/tokens';
import {
  JOURNEY_HISTORY_DAYS,
  journeyDays,
  stopsOn,
  type JourneyDay,
  type JourneyStop,
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

const STATE_WORDS: Record<JourneyDay['dayState'], { label: string; tone: BadgeTone }> = {
  proposed: { label: 'To agree', tone: 'amber' },
  refused: { label: 'Sent back', tone: 'danger' },
  agreed: { label: 'Agreed', tone: 'info' },
  planned: { label: 'Planned', tone: 'teal' },
};

/** What a day comes down to, in one line. */
function dayLine(d: JourneyDay, today: string): string {
  const where = d.city ? d.city + (d.beat ? ' · ' + d.beat : '') : 'No city set';
  if (d.dayState === 'refused') return where + ' · sent back' + (d.refusalReason ? ' — ' + d.refusalReason : '');
  if (d.dayState === 'proposed') return where + (d.planDate < today ? ' · never answered' : ' · waiting on your answer');
  if (d.dayState === 'agreed') return where + (d.planDate < today ? ' · no shops were picked' : ' · pick your shops');
  if (!d.stops) return where + ' · no shops on it';
  if (d.planDate > today) return where + ' · ' + plural(d.stops, 'shop');
  return where + ' · ' + d.visited + ' of ' + d.stops + ' visited' + (d.skipped ? ', ' + d.skipped + ' skipped' : '');
}

/** A day's dot on the calendar: what kind of day it was, at a glance. */
function dotColour(d: JourneyDay, today: string): string {
  if (d.dayState === 'refused') return C.danger;
  if (d.dayState === 'proposed') return C.warn;
  if (d.dayState === 'agreed') return C.info;
  if (d.planDate > today) return C.primary;
  if (!d.stops) return C.faint;
  return d.visited === d.stops ? C.success : d.visited ? C.warn : C.danger;
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

  const openDay = (d: JourneyDay) => {
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
    <AppFrame title="Your journeys" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <AreasCard
        areas={areas}
        requests={requests}
        onAccept={() => void accept()}
        onAsk={() => setAsking(true)}
      />

      <Segmented value={view} onChange={setView} />

      {view === 'calendar' ? (
        <MonthCalendar days={days} today={today} from={from} onPick={openDay} />
      ) : (
        <>
          <Section title={upcoming.length ? 'Coming up' : 'Nothing planned ahead yet'}>
            {upcoming.map((d) => (
              <DayRow key={d.id} d={d} today={today} onPress={() => openDay(d)} />
            ))}
          </Section>
          <Section title={past.length ? 'The last ' + JOURNEY_HISTORY_DAYS + ' days' : 'No past journeys on this phone'}>
            {past.map((d) => (
              <DayRow key={d.id} d={d} today={today} onPress={() => openDay(d)} />
            ))}
          </Section>
        </>
      )}

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
    <Card style={{ marginBottom: 16 }}>
      <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
        Where you work
      </T>

      {areas?.state?.exempt ? (
        <T s="small" style={{ color: C.body }}>
          You see the whole book — managers are not limited to an area.
        </T>
      ) : list.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {list.map((a) => (
            <View
              key={a.kind + a.value + (a.parent ?? '')}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: radius.pill,
                backgroundColor: C.primaryTint,
              }}>
              <T style={[{ fontSize: 13, color: C.primaryDeep }, weight(500)]}>{areaLabel(a)}</T>
            </View>
          ))}
        </View>
      ) : (
        <T s="small" style={{ color: C.warnInk }}>
          No area has been allocated to you yet, so your customer list is empty. Ask your manager, or
          request the cities you work below.
        </T>
      )}

      {accepted ? (
        <T s="caption" style={{ color: C.success, marginTop: 10 }}>
          You accepted these on {dmy(isoDate(new Date(accepted.clientCreatedAt)))}
          {accepted.syncState === 'queued' ? ' · waiting for signal' : ''}
        </T>
      ) : null}

      {waiting ? (
        <View style={{ marginTop: 10, padding: 10, borderRadius: radius.lg, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.warnInk }}>
            You asked for {waiting.requestedPlaces.join(', ')} — waiting on your manager
            {waiting.syncState === 'queued' ? ' (not sent yet, no signal)' : ''}.
          </T>
        </View>
      ) : lastAnswered ? (
        <View
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: radius.lg,
            backgroundColor: lastAnswered.state === 'approved' ? C.successBg : C.dangerBg,
          }}>
          <T s="small" style={{ color: C.ink }}>
            Your request for {lastAnswered.requestedPlaces.join(', ')} was{' '}
            {lastAnswered.state === 'approved' ? 'approved' : 'not approved'}
            {lastAnswered.decisionNote ? ' — “' + lastAnswered.decisionNote + '”' : ''}.
          </T>
        </View>
      ) : null}

      {!areas?.state?.exempt ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          {list.length && !accepted ? (
            <PrimaryButton label="Accept these" onPress={onAccept} style={{ flex: 1 }} />
          ) : null}
          {!waiting ? (
            <SecondaryButton label="Ask for different cities" onPress={onAsk} style={{ flex: 1 }} />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

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
      <T s="h2">Ask for different cities</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        Your manager decides. Until then you keep working {current.length ? current.join(', ') : 'as you are'}.
      </T>

      <View style={{ marginTop: 16 }}>
        <T s="label" style={{ marginBottom: 6 }}>
          Which cities or areas (comma between them)
        </T>
        <Input
          value={places}
          onChangeText={(v) => {
            setPlaces(v);
            setErr(null);
          }}
          placeholder="Nagpur, Wardha"
        />
      </View>

      <View style={{ marginTop: 14 }}>
        <T s="label" style={{ marginBottom: 6 }}>
          Why
        </T>
        <VoiceField
          value={reason}
          onChangeText={(v) => {
            setReason(v);
            setErr(null);
          }}
          placeholder="I live in Wardha and know the dealers there"
        />
      </View>

      {err ? <T style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{err}</T> : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1 }} />
        <PrimaryButton
          label={busy ? 'Sending…' : 'Send to manager'}
          onPress={() => void send()}
          disabled={busy}
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

/* --------------------------------------------------------------- the journeys */

function Segmented({ value, onChange }: { value: View_; onChange: (v: View_) => void }) {
  const options: { key: View_; label: string }[] = [
    { key: 'list', label: 'List' },
    { key: 'calendar', label: 'Calendar' },
  ];
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: C.wash,
        borderRadius: radius.lg,
        padding: 3,
        marginBottom: 14,
      }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            style={{
              flex: 1,
              minHeight: 38,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.lg - 2,
              backgroundColor: on ? C.surface : 'transparent',
              boxShadow: on ? shadow.card : undefined,
            }}>
            <T style={[{ fontSize: 14, color: on ? C.ink : C.muted }, weight(on ? 600 : 500)]}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 18 }}>
      <T s="label" style={{ color: C.muted, marginBottom: 8 }}>
        {title}
      </T>
      {children}
    </View>
  );
}

function DayRow({ d, today, onPress }: { d: JourneyDay; today: string; onPress: () => void }) {
  const words = STATE_WORDS[d.dayState] ?? STATE_WORDS.planned;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
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
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColour(d, today) }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T style={[type.body, weight(600), { color: C.ink, flex: 1 }]}>{dayLabelRelative(d.planDate, today)}</T>
          <Badge tone={words.tone}>{words.label}</Badge>
        </View>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          {dayLine(d, today)}
        </T>
      </View>
      <Icon name="forward" size={18} color={C.muted} strokeWidth={1.5} />
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

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          disabled={month <= first}
          onPress={() => shift(-1)}
          style={{ padding: 8, opacity: month <= first ? 0.3 : 1 }}>
          <Icon name="back" size={18} color={C.ink} strokeWidth={1.75} />
        </Pressable>
        <T style={[type.body, weight(600), { color: C.ink, flex: 1, textAlign: 'center' }]}>{title}</T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          disabled={month >= last}
          onPress={() => shift(1)}
          style={{ padding: 8, opacity: month >= last ? 0.3 : 1 }}>
          <Icon name="forward" size={18} color={C.ink} strokeWidth={1.75} />
        </Pressable>
      </View>

      <View style={{ flexDirection: 'row' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => (
          <T key={i} s="caption" style={{ flex: 1, textAlign: 'center', color: C.muted }}>
            {w}
          </T>
        ))}
      </View>

      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <View key={row} style={{ flexDirection: 'row' }}>
          {cells.slice(row * 7, row * 7 + 7).map((iso, i) => {
            const d = iso ? byDate.get(iso) : undefined;
            const isToday = iso === today;
            return (
              <Pressable
                key={i}
                disabled={!d}
                accessibilityRole={d ? 'button' : undefined}
                accessibilityLabel={d && iso ? dayLabel(iso) + ', ' + dayLine(d, today) : undefined}
                onPress={() => d && onPick(d)}
                style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}>
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: isToday ? 1.5 : 0,
                    borderColor: C.primary,
                    backgroundColor: d ? C.wash : 'transparent',
                  }}>
                  <T style={[{ fontSize: 14, color: iso ? (d ? C.ink : C.faint) : 'transparent' }, weight(d ? 600 : 400)]}>
                    {iso ? String(Number(iso.slice(8))) : ''}
                  </T>
                </View>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    marginTop: 3,
                    backgroundColor: d ? dotColour(d, today) : 'transparent',
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      ))}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
        {[
          { c: C.success, l: 'All visited' },
          { c: C.warn, l: 'Part visited / to agree' },
          { c: C.danger, l: 'Missed / sent back' },
          { c: C.primary, l: 'Planned ahead' },
          { c: C.info, l: 'Agreed, no shops' },
        ].map((k) => (
          <View key={k.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: k.c }} />
            <T s="caption" style={{ color: C.muted }}>
              {k.l}
            </T>
          </View>
        ))}
      </View>
    </Card>
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
        <T s="h2" style={{ flex: 1 }}>
          {dayLabel(day.planDate)}
        </T>
        <Badge tone={words.tone}>{words.label}</Badge>
      </View>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {dayLine(day, today)}
      </T>
      {day.proposedBy ? (
        <T s="caption" style={{ marginTop: 6 }}>
          Proposed by {day.proposedBy}
          {day.proposedAt ? ' on ' + dmy(isoDate(new Date(day.proposedAt))) : ''}
        </T>
      ) : null}
      {day.counterCity ? (
        <T s="caption" style={{ marginTop: 2 }}>
          You asked for {day.counterCity} instead
        </T>
      ) : null}

      <T s="label" style={{ color: C.muted, marginTop: 16, marginBottom: 6 }}>
        {stops.length ? plural(stops.length, 'shop') : 'Shops'}
      </T>
      {stops.length ? (
        stops.map((s, i) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              onOpenShop(s.customerId);
            }}
            style={{
              flexDirection: 'row',
              gap: 10,
              paddingVertical: 10,
              borderBottomWidth: i === stops.length - 1 ? 0 : 1,
              borderBottomColor: C.hairline,
            }}>
            <T style={[{ width: 22, fontSize: 13, color: C.muted }, weight(500)]}>{s.seq || i + 1}</T>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{s.customerName}</T>
              <T s="caption" style={{ marginTop: 1 }}>
                {[s.area, s.city].filter(Boolean).join(', ') || 'No area recorded'}
                {s.plannedAt ? ' · planned ' + s.plannedAt : ''}
              </T>
              {s.status === 'skipped' && s.skipReason ? (
                <T s="caption" style={{ color: C.danger, marginTop: 1 }}>
                  Skipped — {s.skipReason}
                </T>
              ) : null}
            </View>
            <StopStatus stop={s} future={future} />
          </Pressable>
        ))
      ) : (
        <T s="small" style={{ color: C.muted }}>
          {day.dayState === 'planned'
            ? 'This day was planned with no shops on it.'
            : future
              ? 'No shops picked yet. Agree the day and pick them on the journey tab.'
              : 'No shops were picked for this day.'}
        </T>
      )}

      <View style={{ marginTop: 18 }}>
        <SecondaryButton label="Close" onPress={onClose} />
      </View>
    </BottomSheet>
  );
}

function StopStatus({ stop, future }: { stop: JourneyStop; future: boolean }) {
  if (stop.status === 'visited') {
    return (
      <View style={{ alignItems: 'flex-end' }}>
        <Badge tone="success">Visited</Badge>
        {stop.actualAt ? (
          <T s="caption" style={{ marginTop: 3 }}>
            {hhmm(stop.actualAt)}
          </T>
        ) : null}
      </View>
    );
  }
  if (stop.status === 'skipped') return <Badge tone="danger">Skipped</Badge>;
  return <Badge tone={future ? 'neutral' : 'amber'}>{future ? 'Planned' : 'Not visited'}</Badge>;
}
