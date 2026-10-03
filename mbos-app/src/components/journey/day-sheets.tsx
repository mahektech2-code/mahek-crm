import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { BottomSheet } from '../ui/overlays';
import { Badge, PrimaryButton, SecondaryButton, T } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { color as C, radius, weight, tabular } from '../../theme/tokens';
import { dayLabelRelative, hhmm, inrFromPaise, plural } from '../../lib/format';
import { dayHistory, pickShops, pickedShops, type PlanDay, type ShopDay } from '../../data/journey';
import { useStore } from '../../state/store';

/*
 * The two views of a day that is not today.
 *
 * A day behind him is a RECORD: which doors he went through, what each one
 * came to, and why the others were not. A day ahead of him is a PLAN he can
 * still change. They are two sheets because they answer two questions, and
 * the one thing they share is the shop list's shape — so a shop reads the
 * same whichever way he is looking at it.
 */

/* ------------------------------------------------------------ looking back */

export function PastDaySheet({
  day,
  today,
  onClose,
}: {
  day: PlanDay | null;
  today: string;
  onClose: () => void;
}) {
  const set = useStore((s) => s.set);
  const [shops, setShops] = React.useState<ShopDay[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  /* The shop being looked at, inside the same sheet. A second sheet stacked
     on the first is a back gesture away from closing both, and on Android two
     modals at once is a thing that goes wrong; the day is one "‹" away. */
  const [shop, setShop] = React.useState<ShopDay | null>(null);

  React.useEffect(() => {
    if (!day) return;
    let live = true;
    dayHistory(day.planDate)
      .then((rows) => {
        if (live) setShops(rows);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [day]);

  const visited = shops?.filter((s) => s.status === 'visited').length ?? 0;
  const ordersPaise = shops?.reduce((t, s) => t + s.orders.reduce((u, o) => u + (o.valuePaise ?? 0), 0), 0) ?? 0;
  const orderCount = shops?.reduce((t, s) => t + s.orders.length, 0) ?? 0;
  const collectedPaise = shops?.reduce((t, s) => t + s.payments.reduce((u, p) => u + p.amountPaise, 0), 0) ?? 0;

  const openRecord = (s: ShopDay) => {
    onClose();
    set({ custId: s.customerId });
    router.push('/customer?from=journey');
  };

  return (
    <BottomSheet open={!!day} onClose={onClose} scroll>
      {day && shop ? (
        <ShopDayView
          s={shop}
          dayLabel={dayLabelRelative(day.planDate, today)}
          onBack={() => setShop(null)}
          onOpenRecord={() => openRecord(shop)}
        />
      ) : day ? (
        <>
          <T s="h2">{dayLabelRelative(day.planDate, today)}</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {day.city ?? 'No city recorded'}
          </T>

          {failed ? (
            <T s="small" style={{ color: C.danger, marginTop: 16 }}>
              This day could not be read from the phone. Close it and try again.
            </T>
          ) : shops === null ? (
            <T s="small" style={{ color: C.muted, marginTop: 16 }}>
              Loading…
            </T>
          ) : !shops.length ? (
            /* Proposed and never answered, agreed and never picked, sent back:
               a day with no route has no shops to show, and says which it was. */
            <T s="small" style={{ color: C.muted, marginTop: 16 }}>
              {day.dayState === 'refused'
                ? 'You sent this day back' + (day.refusalReason ? ': “' + day.refusalReason + '”' : '.')
                : day.dayState === 'proposed'
                  ? 'The office proposed this day and it was never answered.'
                  : 'No shops were picked for this day.'}
            </T>
          ) : (
            <>
              {/* The day in three numbers, the ones a manager asks about. */}
              <View
                style={{
                  flexDirection: 'row',
                  marginTop: 14,
                  borderWidth: 1,
                  borderColor: C.hairline,
                  borderRadius: radius.lg,
                  overflow: 'hidden',
                }}>
                <Stat value={visited + ' of ' + shops.length} label="visited" />
                <Stat value={orderCount ? inrFromPaise(ordersPaise) : '—'} label={orderCount ? plural(orderCount, 'order') : 'no orders'} divider />
                <Stat value={collectedPaise ? inrFromPaise(collectedPaise) : '—'} label="collected" divider />
              </View>

              <T s="label" style={{ color: C.muted, marginTop: 18, marginBottom: 8 }}>
                Shop by shop
              </T>
              {shops.map((s) => (
                <PastShop key={s.stopId} s={s} onPress={() => setShop(s)} />
              ))}
              <T s="caption" style={{ marginTop: 4 }}>
                Tap a shop to see what happened there that day.
              </T>
            </>
          )}
          <SecondaryButton label="Close" onPress={onClose} style={{ marginTop: 16 }} />
        </>
      ) : null}
    </BottomSheet>
  );
}

function Stat({ value, label, divider = false }: { value: string; label: string; divider?: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 10,
        paddingHorizontal: 6,
        alignItems: 'center',
        borderLeftWidth: divider ? 1 : 0,
        borderLeftColor: C.hairline,
      }}>
      <T numberOfLines={1} style={[{ fontSize: 16, color: C.ink }, weight(600), tabular]}>
        {value}
      </T>
      <T s="caption">{label}</T>
    </View>
  );
}

function PastShop({ s, onPress }: { s: ShopDay; onPress: () => void }) {
  const minutes = s.visit?.durationSeconds != null ? Math.round(s.visit.durationSeconds / 60) : null;
  const arrived = s.visit?.checkInAt ?? s.arrivedAt;
  const statusLine =
    s.status === 'visited'
      ? [
          arrived ? 'Arrived ' + hhmm(arrived) : 'Visited',
          s.visit?.checkOutAt ? 'left ' + hhmm(s.visit.checkOutAt) : null,
          minutes != null ? minutes + ' min' : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : s.status === 'skipped'
        ? 'Skipped' + (s.skipReason ? ' — ' + s.skipReason : '')
        : 'Not visited' + (s.plannedAt ? ' · was planned ' + s.plannedAt : '');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 12,
        padding: 12,
        marginBottom: 8,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: C.hairline,
        backgroundColor: pressed ? C.wash : C.surface,
      })}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: s.status === 'visited' ? C.successBg : s.status === 'skipped' ? C.dangerBg : C.warnBg,
        }}>
        {s.status === 'visited' ? (
          <Icon name="tick" size={14} color={C.success} strokeWidth={2.2} />
        ) : (
          <T style={[{ fontSize: 12, color: s.status === 'skipped' ? C.danger : C.warnInk }, weight(600)]}>{s.seq}</T>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          {s.name}
        </T>
        {s.area ? (
          <T s="caption" numberOfLines={1}>
            {s.area}
          </T>
        ) : null}
        <T
          s="small"
          style={{
            marginTop: 4,
            color: s.status === 'visited' ? C.success : s.status === 'skipped' ? C.danger : C.warnInk,
          }}>
          {statusLine}
        </T>

        {/* What the door came to. Each line only where there is something to
            say — a list of "No order · No payment" under every shop is the
            same noise the planned-day badges were. */}
        {s.orders.map((o) => (
          <Line
            key={o.id}
            icon="order"
            text={
              'Order ' +
              (o.valuePaise != null ? inrFromPaise(o.valuePaise) : '(value with the office)') +
              (o.lines ? ' · ' + plural(o.lines, 'line') : '') +
              (o.orderNo ? ' · ' + o.orderNo : '')
            }
          />
        ))}
        {s.payments.map((p) => (
          <Line key={p.id} icon="money" text={'Collected ' + inrFromPaise(p.amountPaise) + (p.mode ? ' · ' + p.mode : '')} />
        ))}
        {s.visit?.outcome ? <Line icon="note" text={s.visit.outcome} /> : null}
        {s.visit?.notes ? (
          <T s="small" numberOfLines={3} style={{ color: C.body, marginTop: 4, fontStyle: 'italic' }}>
            “{s.visit.notes}”
          </T>
        ) : null}
        {s.other.map((e) => (
          <Line key={e.id} icon="clock" text={hhmm(e.at) + ' · ' + e.summary} />
        ))}
      </View>
      <Icon name="forward" size={16} color={C.muted} strokeWidth={1.5} />
    </Pressable>
  );
}

function Line({ icon, text }: { icon: 'order' | 'money' | 'note' | 'clock'; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <Icon name={icon} size={14} color={C.muted} strokeWidth={1.6} />
      <T s="small" numberOfLines={2} style={{ flex: 1, color: C.body }}>
        {text}
      </T>
    </View>
  );
}

/* ------------------------------------------------------------ one shop, one day */

type Entry = { key: string; at: number | null; icon: 'visit' | 'order' | 'money' | 'note' | 'clock' | 'alert'; title: string; detail?: string; tone?: 'success' | 'danger' | 'warn' };

/**
 * What happened at one shop on one day, in the order it happened.
 *
 * Every line is a fact the phone holds — the stop, the visit, the order with
 * its lines, the money, the outcome, the note, the rest of the timeline — and
 * nothing is inferred to fill a gap: a skipped stop is one line with its
 * reason, because there is nothing else that is true to say about it.
 */
function ShopDayView({
  s,
  dayLabel,
  onBack,
  onOpenRecord,
}: {
  s: ShopDay;
  dayLabel: string;
  onBack: () => void;
  onOpenRecord: () => void;
}) {
  const entries: Entry[] = [];
  const arrived = s.visit?.checkInAt ?? s.arrivedAt;
  if (s.status === 'skipped') {
    entries.push({ key: 'skip', at: null, icon: 'alert', title: 'Skipped', detail: s.skipReason ?? 'No reason was given.', tone: 'danger' });
  } else if (s.status !== 'visited') {
    entries.push({
      key: 'missed',
      at: null,
      icon: 'alert',
      title: 'Not visited',
      detail: s.plannedAt ? 'It was planned for ' + s.plannedAt + '.' : undefined,
      tone: 'warn',
    });
  } else {
    entries.push({ key: 'in', at: arrived, icon: 'visit', title: 'Arrived', tone: 'success' });
  }
  for (const o of s.orders) {
    entries.push({
      key: 'o' + o.id,
      at: o.at,
      icon: 'order',
      title: 'Order ' + (o.valuePaise != null ? inrFromPaise(o.valuePaise) : '(value with the office)'),
      detail:
        [
          o.orderNo,
          o.items.length
            ? o.items.map((i) => i.name + ' × ' + i.cans).join('\n')
            : o.lines
              ? plural(o.lines, 'line')
              : null,
        ]
          .filter(Boolean)
          .join('\n') || undefined,
    });
  }
  for (const p of s.payments) {
    entries.push({ key: 'p' + p.id, at: p.at, icon: 'money', title: 'Collected ' + inrFromPaise(p.amountPaise), detail: p.mode ?? undefined });
  }
  if (s.visit?.outcome) entries.push({ key: 'out', at: null, icon: 'note', title: 'Outcome', detail: s.visit.outcome });
  if (s.visit?.notes) entries.push({ key: 'note', at: null, icon: 'note', title: 'His note', detail: '“' + s.visit.notes + '”' });
  for (const e of s.other) entries.push({ key: 'e' + e.id, at: e.at, icon: 'clock', title: e.summary });
  if (s.visit?.checkOutAt) {
    const minutes = s.visit.durationSeconds != null ? Math.round(s.visit.durationSeconds / 60) : null;
    entries.push({ key: 'outAt', at: s.visit.checkOutAt, icon: 'visit', title: 'Left', detail: minutes != null ? minutes + ' min in the shop' : undefined });
  }
  /* Timed lines in time order; an untimed one stays where it was put, after
     the arrival — sorting it to the top would read as the first thing that
     happened. */
  const timed = entries.filter((e) => e.at != null).sort((a, b) => (a.at as number) - (b.at as number));
  const untimed = entries.filter((e) => e.at == null);
  const ordered = s.status === 'visited' ? [...timed.slice(0, 1), ...untimed, ...timed.slice(1)] : [...untimed, ...timed];
  const nothingElse = s.status === 'visited' && !s.orders.length && !s.payments.length && !s.visit?.outcome && !s.visit?.notes && !s.other.length;

  return (
    <>
      <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginBottom: 10 }}>
        <Icon name="back" size={16} color={C.primaryDeep} strokeWidth={1.8} />
        <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(600)]}>{dayLabel}</T>
      </Pressable>
      <T s="h2">{s.name}</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {[s.area, dayLabel].filter(Boolean).join(' · ')}
      </T>

      <View style={{ marginTop: 16 }}>
        {ordered.map((e, i) => (
          <View key={e.key} style={{ flexDirection: 'row', gap: 12 }}>
            {/* The rail: a dot per line and a line between them, so the day
                reads as a sequence rather than a list of facts. */}
            <View style={{ alignItems: 'center', width: 28 }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: e.tone === 'success' ? C.successBg : e.tone === 'danger' ? C.dangerBg : e.tone === 'warn' ? C.warnBg : C.primaryTint,
                }}>
                <Icon
                  name={e.icon}
                  size={14}
                  color={e.tone === 'success' ? C.success : e.tone === 'danger' ? C.danger : e.tone === 'warn' ? C.warnInk : C.primaryDeep}
                  strokeWidth={1.8}
                />
              </View>
              {i < ordered.length - 1 ? <View style={{ width: 2, flex: 1, minHeight: 12, backgroundColor: C.hairline }} /> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <T style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(600)]}>{e.title}</T>
                {e.at != null ? <T s="caption" style={tabular}>{hhmm(e.at)}</T> : null}
              </View>
              {e.detail ? (
                <T s="small" style={{ color: C.body, marginTop: 2 }}>
                  {e.detail}
                </T>
              ) : null}
            </View>
          </View>
        ))}
      </View>
      {nothingElse ? (
        <T s="small" style={{ color: C.muted }}>
          No order, payment or note was recorded at this visit.
        </T>
      ) : null}

      <PrimaryButton label="Open shop record" onPress={onOpenRecord} style={{ marginTop: 12 }} />
      <SecondaryButton label={'Back to ' + dayLabel} onPress={onBack} style={{ marginTop: 10 }} />
    </>
  );
}

/* ------------------------------------------------------------ looking ahead */

export function PlannedDaySheet({
  day,
  today,
  onClose,
  onChanged,
}: {
  day: PlanDay | null;
  today: string;
  onClose: () => void;
  /** After a shop is taken off here, so the list behind the sheet re-reads. */
  onChanged: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  const [shops, setShops] = React.useState<Awaited<ReturnType<typeof pickedShops>> | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    if (!day) return;
    let live = true;
    void pickedShops(day.id).then((rows) => {
      if (live) setShops(rows);
    });
    return () => {
      live = false;
    };
  }, [day, reload]);

  const remove = async (customerId: string) => {
    if (!day || !shops || busy) return;
    const rest = shops.map((s) => s.customerId).filter((id) => id !== customerId);
    /* The last shop cannot be removed here. An empty route is not a route —
       the server would put the day back to "agreed" — and a man thumbing ×
       down a list should not undo his day by accident. Start over says what
       it does. */
    if (!rest.length) return notify('This is the only shop. Use Start over to plan the day again.', 'error');
    setBusy(true);
    try {
      const out = await pickShops(day.id, rest);
      if (!out.ok) return notify(out.message ?? 'Could not change the day.', 'error');
      notify('Removed. ' + plural(rest.length, 'shop') + ' left for ' + dayLabelRelative(day.planDate, today) + '.');
      setReload((r) => r + 1);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const change = () => {
    if (!day) return;
    onClose();
    router.push({ pathname: '/pick', params: { day: day.id } });
  };

  const startOver = () => {
    if (!day) return;
    onClose();
    askConfirm({
      title: 'Plan ' + dayLabelRelative(day.planDate, today) + ' again?',
      body:
        'Your ' +
        plural(shops?.length ?? day.picked, 'shop') +
        ' are cleared and you pick the day from the beginning. Nothing changes until you press Plan the day.',
      confirmLabel: 'Start over',
      run: () => router.push({ pathname: '/pick', params: { day: day.id, fresh: '1' } }),
    });
  };

  return (
    <BottomSheet open={!!day} onClose={onClose} scroll>
      {day ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T s="h2">{dayLabelRelative(day.planDate, today)}</T>
              <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                {(day.city ? day.city + ' · ' : '') + plural(shops?.length ?? day.picked, 'shop') + ' picked'}
              </T>
            </View>
            {day.syncState === 'queued' ? <Badge tone="amber">Not sent yet</Badge> : <Badge tone="info">Planned</Badge>}
          </View>

          <T s="label" style={{ color: C.muted, marginTop: 18, marginBottom: 8 }}>
            In the order you will visit
          </T>
          {shops === null ? (
            <T s="small" style={{ color: C.muted }}>
              Loading…
            </T>
          ) : (
            shops.map((s, i) => (
              <View
                key={s.customerId}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 10,
                  borderBottomWidth: i === shops.length - 1 ? 0 : 1,
                  borderBottomColor: C.hairline,
                }}>
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: C.primaryTint,
                  }}>
                  <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(600)]}>{i + 1}</T>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                    {s.name}
                  </T>
                  <T s="caption" numberOfLines={1}>
                    {[s.area, s.outstandingPaise > 0 ? inrFromPaise(s.outstandingPaise) + ' outstanding' : null]
                      .filter(Boolean)
                      .join(' · ') || ' '}
                  </T>
                </View>
                <Pressable
                  onPress={() => void remove(s.customerId)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={'Remove ' + s.name + ' from this day'}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? C.dangerBg : C.wash,
                    opacity: busy ? 0.5 : 1,
                  })}>
                  <Icon name="close" size={16} color={C.muted} strokeWidth={1.8} />
                </Pressable>
              </View>
            ))
          )}

          {/* Adding, removing and reordering are one screen — the picker,
              with today's picks already ticked — because they are one act:
              deciding which doors, in which order. Starting over is the only
              one that throws the list away, so it is the only one that asks. */}
          <PrimaryButton label="Add or change shops" onPress={change} style={{ marginTop: 16 }} />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <SecondaryButton label="Start over" onPress={startOver} style={{ flex: 1 }} />
            <SecondaryButton label="Close" onPress={onClose} style={{ flex: 1 }} />
          </View>
        </>
      ) : null}
    </BottomSheet>
  );
}
