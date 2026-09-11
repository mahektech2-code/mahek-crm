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
import { inr, isoDate } from '../src/lib/format';
import { checkFare, checkOdometer } from '../src/lib/travel-leg';
import { getConfig } from '../src/data/config';
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

/**
 * A typed distance, PARSED rather than stripped.
 *
 * The `num` helper this replaced was `Number(v.replace(/[^0-9]/g, ''))` — it
 * deleted the decimal point instead of reading it, so "12.5" became 125 km and
 * "40.50" became ₹4,050. `checkFare` in `lib/travel-leg.ts` has always handled
 * the money side correctly, which is why the same fare typed on the journey
 * screen and typed here gave two answers. This is that rule for kilometres; it
 * stays local because the distance is only ever typed on this screen.
 *
 * Zero is refused with a sentence rather than read as "not given" — the old
 * `|| null` quietly turned a legitimate 0 into nothing at all.
 */
function kilometresFrom(typed: string): { ok: true; metres: number } | { ok: false; why: string } {
  const raw = typed.trim().replace(/,/g, '');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, why: 'Type the kilometres only — 12, or 12.5.' };
  }
  const value = Number(raw);
  if (value <= 0) {
    return { ok: false, why: 'A journey of no distance is not a leg — leave it empty if you do not know it.' };
  }
  return { ok: true, metres: Math.round(value * 1000) };
}

/** Which field a refusal belongs under, so it is read where it was typed. */
type LegField = 'odoStart' | 'odoEnd' | 'manualKm' | 'ticket';

export default function TravelScreen() {
  const back = useCameFrom('day');
  const boot = useBoot();
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [modes, setModes] = React.useState<TravelMode[]>([]);
  /* The ceiling a mistyped meter reading is caught by, and the same
     configured number the journey path checks against. */
  const [maxLegKm, setMaxLegKm] = React.useState(400);
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
  /* Whether the start reading was actually carried over from the last leg.
     The hint under the field said it had been on every leg, including the
     first of the day and any where the previous leg carried no end reading —
     so he looked for a number that was never there. */
  const [odoSuggested, setOdoSuggested] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<{ field: LegField; why: string } | null>(null);

  const refusalFor = (field: LegField) => (err?.field === field ? err.why : undefined);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([
      priceDay(userId, day),
      travelModes(),
      getConfig<number>('mbos.travel.maxLegKilometres', 400),
    ]).then(([p, m, maxKm]) => {
      if (!live) return;
      setPriced(p);
      setModes(m);
      setMaxLegKm(maxKm);
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
    setOdoSuggested(suggested);
    setOdoStart(suggested == null ? '' : String(suggested));
    setOdoEnd('');
    setManualKm('');
    setTicket('');
    setTicketRef('');
    setPhotoId(null);
    setErr(null);
    setOpen(true);
  };

  /**
   * Add the leg, after the SAME checks the journey path makes.
   *
   * This screen hand-rolled `odoE < odoS`, quoted neither figure, and had no
   * ceiling at all — so 41,208 typed as 4,120 for the START produced a 37,000
   * km leg that saved without a murmur, and `handleTravelLeg` deliberately
   * does not re-check a `day_log` leg, so nothing downstream caught it either.
   * `checkOdometer` and `checkFare` are pure and are what the camera screen
   * already refuses on; two readings of one rule is how the half nobody looks
   * at drifts.
   *
   * Only what the chosen mode actually SHOWS is validated and sent. A reading
   * left over from a mode he switched away from is not on the screen, and a
   * refusal about a field he cannot see is a save that appears to do nothing.
   */
  const save = async () => {
    if (!mode) return notify('Pick how you travelled.');

    let odoS: number | null = null;
    let odoE: number | null = null;
    let metres: number | null = null;
    let ticketPaise: number | null = null;

    if (mode.requiresOdometer) {
      if (odoStart.trim()) {
        const v = checkOdometer({ typed: odoStart, previousKm: null, maxLegKilometres: maxLegKm });
        if (!v.ok) return setErr({ field: 'odoStart', why: v.why });
        odoS = v.km;
      }
      if (odoEnd.trim()) {
        const v = checkOdometer({ typed: odoEnd, previousKm: odoS, maxLegKilometres: maxLegKm });
        if (!v.ok) return setErr({ field: 'odoEnd', why: v.why });
        odoE = v.km;
      }
    } else if (manualKm.trim()) {
      const v = kilometresFrom(manualKm);
      if (!v.ok) return setErr({ field: 'manualKm', why: v.why });
      metres = v.metres;
    }

    if (mode.requiresTicket && ticket.trim()) {
      const v = checkFare(ticket);
      if (!v.ok) return setErr({ field: 'ticket', why: v.why });
      ticketPaise = v.paise;
    }

    const dayId = priced?.day?.id ?? (await openDay({ userId, day }));

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
      manualMetres: metres,
      odometerStartKm: odoS,
      odometerEndKm: odoE,
      odometerPhotoId: mode.requiresOdometer ? photoId : null,
      ticketAmountPaise: ticketPaise,
      ticketReference: mode.requiresTicket ? ticketRef.trim() || null : null,
    });
    setOpen(false);
    setErr(null);
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
              {inr(computation.travelPaise / 100)}
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
        const modeLabel = modes.find((m) => m.key === leg.modeKey)?.label ?? leg.modeKey;
        const purposeLabel = leg.purpose
          ? (PURPOSES.find((p) => p.key === leg.purpose)?.label ?? leg.purpose)
          : null;
        /* Both places are free text and neither is required, so the card's
           title could carry no description of the journey at all — it read
           "? → ?". The mode and the reason are what IS known about it. */
        const where =
          leg.fromLabel && leg.toLabel
            ? leg.fromLabel + ' → ' + leg.toLabel
            : leg.toLabel
              ? 'To ' + leg.toLabel
              : leg.fromLabel
                ? 'From ' + leg.fromLabel
                : null;
        const title = where ?? [modeLabel, purposeLabel].filter(Boolean).join(' · ');
        const caption = where
          ? [modeLabel, purposeLabel].filter(Boolean).join(' · ')
          : 'Where you went was not typed in';
        return (
          <ListCard key={leg.id} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{title}</T>
                <T s="caption" style={{ marginTop: 2 }}>
                  {caption}
                </T>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T style={[{ fontSize: 15 }, weight(600), tabular]}>
                  {c ? inr(c.eligiblePaise / 100) : '—'}
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
            {/* Kept after the leg has gone up, and ASKED FIRST.
                It deleted the row and its queue entry on one stray tap with no
                confirmation, unlike leave's withdraw and the sign-out — and it
                was drawn only while the leg was unsent, so `removeLeg`'s
                carefully written refusal could never be read and a leg already
                with the office had no correction path on this screen at all.
                A sent leg answers in words instead of vanishing. */}
            {!locked ? (
              <SecondaryButton
                label="Remove"
                style={{ marginTop: 8 }}
                onPress={() => {
                  if (leg.syncState === 'synced') {
                    void removeLeg(leg.id).then((r) => notify(r.reason ?? 'That could not be removed.'));
                    return;
                  }
                  askConfirm({
                    title: 'Remove this leg?',
                    body: title + ' — it comes off today and so does what it is worth. This cannot be undone.',
                    confirmLabel: 'Remove it',
                    run: () => {
                      void removeLeg(leg.id).then((r) => {
                        if (!r.ok) notify(r.reason ?? 'That could not be removed.');
                        load();
                      });
                    },
                  });
                }}
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
            <Field
              label="Odometer at the start"
              hint={odoSuggested != null ? 'Filled in from where your last leg ended.' : undefined}
              error={refusalFor('odoStart')}>
              <Input
                value={odoStart}
                onChangeText={(v) => {
                  setOdoStart(v);
                  setErr(null);
                }}
                invalid={err?.field === 'odoStart'}
                keyboardType="numeric"
              />
            </Field>
            <Field label="Odometer at the end" error={refusalFor('odoEnd')}>
              <Input
                value={odoEnd}
                onChangeText={(v) => {
                  setOdoEnd(v);
                  setErr(null);
                }}
                invalid={err?.field === 'odoEnd'}
                keyboardType="numeric"
              />
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
            error={refusalFor('manualKm')}
          >
            {/* `numeric` rather than `number-pad`: a decimal is a real answer
                here now that it is parsed rather than deleted, and a keypad
                with no full stop on it is a keypad that cannot type 12.5. */}
            <Input
              value={manualKm}
              onChangeText={(v) => {
                setManualKm(v);
                setErr(null);
              }}
              invalid={err?.field === 'manualKm'}
              keyboardType="numeric"
            />
          </Field>
        )}

        {mode?.requiresTicket ? (
          <>
            <Field label="What the ticket cost" error={refusalFor('ticket')}>
              <Input
                value={ticket}
                onChangeText={(v) => {
                  setTicket(v);
                  setErr(null);
                }}
                invalid={err?.field === 'ticket'}
                keyboardType="numeric"
              />
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
