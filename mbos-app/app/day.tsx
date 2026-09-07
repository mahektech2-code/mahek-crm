import React from 'react';
import { View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Divider, Field, Input, PrimaryButton, SecondaryButton, T, Toggle } from '../src/components/ui/primitives';
import { useBoot } from '../src/state/boot';
import { useStore } from '../src/state/store';
import { isoDate } from '../src/lib/format';
import { color as C, weight } from '../src/theme/tokens';
import { dayFor, openDay, updateDay, type ExpenseDay } from '../src/data/travel';

/** A switch with its question beside it. The primitive draws the switch alone. */
function LabelledToggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
      <T s="small" style={{ color: C.ink, flex: 1, paddingRight: 12 }}>{label}</T>
      <Toggle on={on} onPress={onPress} />
    </View>
  );
}


/**
 * Your day — when you left, and when you got back.
 *
 * **This screen exists because food cannot be typed in.** The policy works the
 * meals out from these two times, so they are the only thing the salesman has
 * to say, and nothing else about food is ever asked. Getting them right is
 * worth more than any expense form: leaving at 07:45 rather than 08:15 is the
 * difference between breakfast being paid and not, and he is the only person
 * who knows which it was.
 *
 * The times are asked in plain 24-hour clock rather than a picker wheel,
 * because they are entered once at either end of a long day, usually with one
 * thumb, and a wheel is four gestures where two digits are enough.
 */
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function clockOf(at: number | null): string {
  if (at == null) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function atClock(day: string, hhmm: string): number | null {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return null;
  const d = new Date(`${day}T00:00:00`);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

export default function DayScreen() {
  const back = useCameFrom('more');
  const boot = useBoot();
  const notify = useStore((s) => s.notify);
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [row, setRow] = React.useState<ExpenseDay | null>(null);
  const [left, setLeft] = React.useState('');
  const [back_, setBack] = React.useState('');
  const [arrived, setArrived] = React.useState('');
  const [city, setCity] = React.useState('');
  const [fromHome, setFromHome] = React.useState(true);
  const [overnight, setOvernight] = React.useState(false);
  const [hotel, setHotel] = React.useState(false);
  const [odoOpen, setOdoOpen] = React.useState('');
  const [odoClose, setOdoClose] = React.useState('');

  const load = React.useCallback(() => {
    let live = true;
    void dayFor(userId, day).then((d) => {
      if (!live) return;
      setRow(d);
      if (d) {
        setLeft(clockOf(d.departedAt));
        setBack(clockOf(d.returnedAt));
        setArrived(clockOf(d.arrivedAtDestinationAt));
        setCity(d.destinationCity ?? '');
        setFromHome(d.departedFromHometown === 1);
        setOvernight(d.overnight === 1);
        setHotel(d.stayedInHotel === 1);
        setOdoOpen(d.openingOdometerKm == null ? '' : String(d.openingOdometerKm));
        setOdoClose(d.closingOdometerKm == null ? '' : String(d.closingOdometerKm));
      }
    });
    return () => {
      live = false;
    };
  }, [userId, day]);

  useFocusEffect(load);

  const locked = row?.lockedAt != null;

  const save = async () => {
    if (left && !HHMM.test(left.trim())) return notify('The time you left should look like 08:15.');
    if (back_ && !HHMM.test(back_.trim())) return notify('The time you got back should look like 19:30.');

    const id = row?.id ?? (await openDay({ userId, day }));
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[^0-9]/g, '')) || null);

    const result = await updateDay(id, {
      departedAt: left ? atClock(day, left) : null,
      returnedAt: back_ ? atClock(day, back_) : null,
      arrivedAtDestinationAt: arrived ? atClock(day, arrived) : null,
      destinationCity: city.trim() || null,
      departedFromHometown: fromHome,
      overnight,
      stayedInHotel: hotel,
      openingOdometerKm: num(odoOpen),
      closingOdometerKm: num(odoClose),
    });
    if (!result.ok) return notify(result.reason ?? 'That did not save.');
    notify('Saved.');
    load();
  };

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Your day</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 16 }}>
        When you left and when you got back is all the meal allowance needs — it is worked out from
        these two times, so you never have to claim food.
      </T>

      {locked ? (
        <Card style={{ marginBottom: 12, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.ink }}>
            You have sent this day in, so it cannot be changed here. Ask your manager to reopen it —
            what you sent stays exactly as you sent it.
          </T>
        </Card>
      ) : null}

      <Card>
        <Field label="Time you left">
          <Input value={left} onChangeText={setLeft} placeholder="08:15" keyboardType="numbers-and-punctuation" editable={!locked} />
        </Field>
        <Field label="Time you got back">
          <Input value={back_} onChangeText={setBack} placeholder="19:30" keyboardType="numbers-and-punctuation" editable={!locked} />
        </Field>
        <LabelledToggle
          label="I left from home"
          on={fromHome}
          onPress={() => !locked && setFromHome((v) => !v)}
        />
      </Card>

      <Divider style={{ marginVertical: 14 }} />

      <T style={[{ fontSize: 15, color: C.ink, marginBottom: 8 }, weight(600)]}>Where you went</T>
      <Card>
        <Field label="Town or city" hint="The hotel and food limits can differ by place.">
          <Input value={city} onChangeText={setCity} placeholder="Nagpur" editable={!locked} />
        </Field>
        <LabelledToggle label="I was away overnight" on={overnight} onPress={() => !locked && setOvernight((v) => !v)} />
        {overnight ? (
          <>
            <LabelledToggle label="I stayed in a hotel" on={hotel} onPress={() => !locked && setHotel((v) => !v)} />
            {!hotel ? (
              <Field
                label="Time you reached"
                hint="If you travelled overnight and arrived early without taking a room, there is an allowance for the morning. This is the time it is worked out from."
              >
                <Input value={arrived} onChangeText={setArrived} placeholder="07:30" keyboardType="numbers-and-punctuation" editable={!locked} />
              </Field>
            ) : null}
          </>
        ) : null}
      </Card>

      <Divider style={{ marginVertical: 14 }} />

      <T style={[{ fontSize: 15, color: C.ink, marginBottom: 8 }, weight(600)]}>Odometer</T>
      <T s="small" style={{ color: C.muted, marginBottom: 8 }}>
        Only if you used your own bike or car. Each leg starts from where the last one ended, so the
        day reads as one chain and a gap in it is easy to see.
      </T>
      <Card>
        <Field label="Reading at the start of the day">
          <Input value={odoOpen} onChangeText={setOdoOpen} keyboardType="number-pad" editable={!locked} />
        </Field>
        <Field label="Reading at the end">
          <Input value={odoClose} onChangeText={setOdoClose} keyboardType="number-pad" editable={!locked} />
        </Field>
      </Card>

      <View style={{ marginTop: 18, gap: 10 }}>
        {!locked ? <PrimaryButton label="Save" onPress={() => void save()} /> : null}
        <SecondaryButton label="Your travel today" onPress={() => router.push('/travel')} />
        <SecondaryButton label="Close the day" onPress={() => router.push('/eod')} />
      </View>
    </AppFrame>
  );
}
