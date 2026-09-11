import React from 'react';
import { View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import {
  Badge,
  Card,
  Choice,
  DashedButton,
  Field,
  Input,
  ListCard,
  PrimaryButton,
  SecondaryButton,
  T,
} from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { useBoot } from '../src/state/boot';
import { useStore } from '../src/state/store';
import { inrFromPaise, isoDate } from '../src/lib/format';
import { takePhoto } from '../src/native/capture';
import { color as C, weight, tabular } from '../src/theme/tokens';
import {
  addLeg,
  nextOdometerStart,
  openDay,
  priceDay,
  removeLeg,
  travelModes,
  type TravelMode,
} from '../src/data/travel';

/**
 * Where you went today, and what it is worth.
 *
 * **The reimbursement is never typed and never worked out by the salesman.**
 * Requirement 24: he says the mode, the distance and the purpose, and the
 * amount appears. That is the whole reason the policy engine runs on this
 * phone — a figure he calculates himself is a figure he gets wrong under time
 * pressure and then argues about at month end.
 *
 * A mode that pays nothing says so BEFORE he saves, not after. Somebody who
 * logs forty kilometres on a customer's van and finds out at month end that it
 * paid nothing has been told nothing.
 */
const PURPOSES = [
  { key: 'visit', label: 'Visit' },
  { key: 'collection', label: 'Collection' },
  { key: 'complaint', label: 'Complaint' },
  { key: 'new_customer', label: 'New customer' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'other', label: 'Other' },
];

const km = (metres: number | null) => (metres == null ? '—' : `${(metres / 1000).toFixed(1)} km`);

export default function TravelScreen() {
  const back = useCameFrom('day');
  const boot = useBoot();
  const notify = useStore((s) => s.notify);
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [modes, setModes] = React.useState<TravelMode[]>([]);
  const [open, setOpen] = React.useState(false);

  const [modeKey, setModeKey] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [purpose, setPurpose] = React.useState('visit');
  const [odoStart, setOdoStart] = React.useState('');
  const [odoEnd, setOdoEnd] = React.useState('');
  const [manualKm, setManualKm] = React.useState('');
  const [ticket, setTicket] = React.useState('');
  const [ticketRef, setTicketRef] = React.useState('');
  const [photoId, setPhotoId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([priceDay(userId, day), travelModes()]).then(([p, m]) => {
      if (!live) return;
      setPriced(p);
      setModes(m);
      if (!modeKey && m[0]) setModeKey(m[0].key);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, day]);

  useFocusEffect(load);

  const mode = modes.find((m) => m.key === modeKey) ?? null;
  const locked = priced?.day?.lockedAt != null;

  const start = async () => {
    const dayId = priced?.day?.id ?? (await openDay({ userId, day }));
    const suggested = await nextOdometerStart(dayId);
    setFrom(priced?.legs.length ? (priced.legs[priced.legs.length - 1]!.toLabel ?? '') : '');
    setTo('');
    setOdoStart(suggested == null ? '' : String(suggested));
    setOdoEnd('');
    setManualKm('');
    setTicket('');
    setTicketRef('');
    setPhotoId(null);
    setOpen(true);
  };

  const save = async () => {
    if (!mode) return notify('Pick how you travelled.');
    const dayId = priced?.day?.id ?? (await openDay({ userId, day }));
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[^0-9]/g, '')) || null);

    const odoS = num(odoStart);
    const odoE = num(odoEnd);
    if (odoS != null && odoE != null && odoE < odoS) {
      return notify('The reading at the end is lower than the one at the start — check them.');
    }

    await addLeg({
      userId,
      expenseDayId: dayId,
      day,
      modeKey: mode.key,
      fromLabel: from.trim() || null,
      toLabel: to.trim() || null,
      startedAt: Date.now(),
      endedAt: Date.now(),
      purpose,
      customerId: null,
      manualMetres: num(manualKm) == null ? null : num(manualKm)! * 1000,
      odometerStartKm: odoS,
      odometerEndKm: odoE,
      odometerPhotoId: photoId,
      ticketAmountPaise: num(ticket) == null ? null : num(ticket)! * 100,
      ticketReference: ticketRef.trim() || null,
    });
    setOpen(false);
    notify('Added.');
    load();
  };

  const computation = priced?.computation ?? null;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Today&apos;s travel</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
        You never work out the money — say how you went and how far, and the amount is worked out
        for you from the policy the office has published.
      </T>

      {priced?.reason ? (
        <Card style={{ marginBottom: 12, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.ink }}>{priced.reason}</T>
        </Card>
      ) : null}

      {computation ? (
        <Card style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T s="small" style={{ color: C.muted }}>Travel today</T>
            <T style={[{ fontSize: 22, color: C.ink }, weight(600), tabular]}>
              {inrFromPaise(computation.travelPaise)}
            </T>
          </View>
          <T s="caption" style={{ marginTop: 2 }}>
            {km(computation.totalMetres)} across {computation.legs.length}{' '}
            {computation.legs.length === 1 ? 'leg' : 'legs'}
          </T>
        </Card>
      ) : null}

      {(priced?.legs ?? []).map((leg) => {
        const c = computation?.legs.find((l) => l.legId === leg.id) ?? null;
        const zero = c != null && c.eligiblePaise === 0 && c.chosenMetres != null;
        return (
          <ListCard key={leg.id} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
                  {(leg.fromLabel ?? '?') + ' → ' + (leg.toLabel ?? '?')}
                </T>
                <T s="caption" style={{ marginTop: 2 }}>
                  {modes.find((m) => m.key === leg.modeKey)?.label ?? leg.modeKey}
                  {leg.purpose ? ' · ' + (PURPOSES.find((p) => p.key === leg.purpose)?.label ?? leg.purpose) : ''}
                </T>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T style={[{ fontSize: 15 }, weight(600), tabular]}>
                  {c ? inrFromPaise(c.eligiblePaise) : '—'}
                </T>
                <T s="caption">{km(c?.chosenMetres ?? null)}</T>
              </View>
            </View>
            {zero ? (
              <Badge tone="neutral" style={{ alignSelf: 'flex-start', marginTop: 6 }}>
                Recorded, pays nothing
              </Badge>
            ) : null}
            {c?.unpricedReason ? (
              <T s="caption" style={{ marginTop: 6, color: C.warnInk }}>{c.unpricedReason}</T>
            ) : null}
            {leg.syncState !== 'synced' && !locked ? (
              <SecondaryButton
                label="Remove"
                style={{ marginTop: 8 }}
                onPress={() =>
                  void removeLeg(leg.id).then((r) => {
                    if (!r.ok) notify(r.reason ?? 'That could not be removed.');
                    load();
                  })
                }
              />
            ) : null}
          </ListCard>
        );
      })}

      {!locked ? (
        <DashedButton label="Add a leg" onPress={() => void start()} style={{ marginTop: 6 }} />
      ) : (
        <Card style={{ marginTop: 6, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.ink }}>
            This day has been sent in, so nothing can be added. Ask your manager to reopen it.
          </T>
        </Card>
      )}

      <SecondaryButton label="Close the day" style={{ marginTop: 14 }} onPress={() => router.push('/eod')} />

      <BottomSheet open={open} onClose={() => setOpen(false)} scroll>
        <T style={[{ fontSize: 17, color: C.ink, marginBottom: 12 }, weight(600)]}>A leg of today</T>
        <Field label="How you went">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {modes.map((m) => (
              <Choice
                key={m.key}
                label={m.label}
                sub={m.reimbursementKind === 'zero' ? 'pays nothing' : undefined}
                selected={modeKey === m.key}
                onPress={() => setModeKey(m.key)}
              />
            ))}
          </View>
        </Field>

        {/* Told BEFORE he saves, never after. */}
        {mode?.reimbursementKind === 'zero' ? (
          <Card style={{ marginTop: 10, backgroundColor: C.warnBg }}>
            <T s="small" style={{ color: C.ink }}>
              {mode.label} is recorded and pays nothing. Put the distance in anyway — the office
              counts the kilometres even where it does not pay for them.
            </T>
          </Card>
        ) : null}

        <Field label="From">
          <Input value={from} onChangeText={setFrom} placeholder="Where you started" />
        </Field>
        <Field label="To">
          <Input value={to} onChangeText={setTo} placeholder="Where you got to" />
        </Field>
        <Field label="Why">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PURPOSES.map((p) => (
              <Choice
                key={p.key}
                label={p.label}
                selected={purpose === p.key}
                onPress={() => setPurpose(p.key)}
              />
            ))}
          </View>
        </Field>

        {mode?.requiresOdometer ? (
          <>
            <Field label="Odometer at the start" hint="Filled in from where your last leg ended.">
              <Input value={odoStart} onChangeText={setOdoStart} keyboardType="number-pad" />
            </Field>
            <Field label="Odometer at the end">
              <Input value={odoEnd} onChangeText={setOdoEnd} keyboardType="number-pad" />
            </Field>
            <SecondaryButton
              label={photoId ? 'Odometer photographed' : 'Photograph the odometer'}
              onPress={() =>
                void takePhoto({
                  parentType: 'travel_leg',
                  parentId: 'pending',
                  kind: 'bill_photo',
                  source: 'camera',
                }).then((shot) => {
                  if (shot.ok) setPhotoId(shot.mediaId);
                  else notify(shot.reason);
                })
              }
            />
          </>
        ) : (
          <Field
            label="Distance in kilometres"
            hint="If you know it. The office also measures it from your day's track."
          >
            <Input value={manualKm} onChangeText={setManualKm} keyboardType="number-pad" />
          </Field>
        )}

        {mode?.requiresTicket ? (
          <>
            <Field label="What the ticket cost">
              <Input value={ticket} onChangeText={setTicket} keyboardType="number-pad" />
            </Field>
            <Field label="Ticket or PNR number" hint="It is how the office tells one ticket from another.">
              <Input value={ticketRef} onChangeText={setTicketRef} />
            </Field>
          </>
        ) : null}

        <PrimaryButton label="Add this leg" style={{ marginTop: 14 }} onPress={() => void save()} />
      </BottomSheet>
    </AppFrame>
  );
}
