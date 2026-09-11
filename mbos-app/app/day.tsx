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

/**
 * A switch with its question beside it. The primitive draws the switch alone.
 *
 * `disabled` DIMS it and says why, and the press still runs — the handler
 * answers instead of acting. Drawn identically whether or not the day was
 * locked, these three switches were pressable and did nothing on a day already
 * sent in, with the warning card explaining it several hundred points above:
 * he presses "I left from home" three times and concludes the app is broken.
 * The same reasoning `PrimaryButton`'s `whyDisabled` is built on, one control
 * along.
 */
function LabelledToggle({
  label,
  on,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <T s="small" style={{ color: disabled ? C.muted : C.ink }}>{label}</T>
        {disabled && hint ? (
          <T s="caption" style={{ marginTop: 2 }}>{hint}</T>
        ) : null}
      </View>
      <View style={{ opacity: disabled ? 0.45 : 1 }}>
        <Toggle on={on} onPress={onPress} />
      </View>
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

/**
 * `0815` → `08:15`, as he types.
 *
 * These three fields asked for `numbers-and-punctuation`, which React Native
 * documents as iOS-only — and MBOS ships as an Android APK, so every one of
 * them opened a full QWERTY. A digit keypad is the right keyboard and it has no
 * colon on it, on any Android keyboard, so the colon has to be put in for him
 * or the field becomes impossible rather than merely awkward.
 *
 * Three digits are ambiguous only in principle: there is no hour past 23, so
 * `815` can only be 8:15 while `115` is 11:5 on its way to 11:50.
 */
function typedClock(raw: string): string {
  const d = raw.replace(/[^0-9]/g, '').slice(0, 4);
  if (d.length <= 2) return d;
  if (d.length === 3) {
    return Number(d.slice(0, 2)) > 23 ? d.slice(0, 1) + ':' + d.slice(1) : d.slice(0, 2) + ':' + d.slice(2);
  }
  return d.slice(0, 2) + ':' + d.slice(2);
}

/** Said next to the controls, because the warning card is at the top of a screen
    somebody reads from the bottom. */
const LOCKED_HINT = 'Sent in — this cannot be changed here.';
const LOCKED_WHY =
  'You have sent this day in, so it cannot be changed. Ask your manager to reopen it.';

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

  /*
   * THE DAY HIS TYPING BELONGS TO, or null where nothing has been typed.
   *
   * `load` runs on every focus and used to overwrite all eight fields from the
   * database whenever a row existed — and a row exists the moment any travel
   * leg opens the day, which is any day he has started a visit. Directly under
   * the Save button sit "Your travel today" and "Close the day", both of which
   * navigate away: he typed the two times that decide the meal allowance,
   * tapped the button beneath them, came back, and the fields were blank again
   * with nothing saying so.
   *
   * It holds the DAY rather than a bare flag so that a screen left open across
   * midnight cannot save yesterday's typing onto today's row — the ref stops
   * matching and the fresh day is applied.
   */
  const dirty = React.useRef<string | null>(null);
  const mark = React.useCallback(() => {
    dirty.current = day;
  }, [day]);

  const load = React.useCallback(() => {
    let live = true;
    void dayFor(userId, day).then((d) => {
      if (!live) return;
      setRow(d);
      /* The row is always taken — `locked` and the id are read from it — and
         only the FIELDS are held back while there is unsaved typing in them. */
      if (d && dirty.current !== day) {
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
    /* Saved, so what is on the screen and what is in the database agree again
       and the next focus may refresh the fields freely. */
    dirty.current = null;
    notify('Saved.');
    load();
  };

  return (
    /* The header names the PLACE, not the app. It is the one persistent label
       on screen and it read "MBOS" over a page headed "Your day", so the only
       orientation in the back stack came from the inline link. The h1 goes with
       the change rather than being said twice two lines apart — the same shape
       Tasks, Documents, Near me and the rest already follow. */
    <AppFrame title="Your day" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="small" style={{ color: C.muted, marginTop: 6, marginBottom: 16 }}>
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
          <Input
            value={left}
            onChangeText={(v) => {
              mark();
              setLeft(typedClock(v));
            }}
            placeholder="08:15"
            keyboardType="number-pad"
            editable={!locked}
          />
        </Field>
        <Field label="Time you got back">
          <Input
            value={back_}
            onChangeText={(v) => {
              mark();
              setBack(typedClock(v));
            }}
            placeholder="19:30"
            keyboardType="number-pad"
            editable={!locked}
          />
        </Field>
        <LabelledToggle
          label="I left from home"
          on={fromHome}
          disabled={locked}
          hint={LOCKED_HINT}
          onPress={() => {
            if (locked) return notify(LOCKED_WHY);
            mark();
            setFromHome((v) => !v);
          }}
        />
      </Card>

      <Divider style={{ marginVertical: 14 }} />

      <T style={[{ fontSize: 15, color: C.ink, marginBottom: 8 }, weight(600)]}>Where you went</T>
      <Card>
        <Field label="Town or city" hint="The hotel and food limits can differ by place.">
          <Input
            value={city}
            onChangeText={(v) => {
              mark();
              setCity(v);
            }}
            placeholder="Nagpur"
            editable={!locked}
          />
        </Field>
        <LabelledToggle
          label="I was away overnight"
          on={overnight}
          disabled={locked}
          hint={LOCKED_HINT}
          onPress={() => {
            if (locked) return notify(LOCKED_WHY);
            mark();
            setOvernight((v) => !v);
          }}
        />
        {overnight ? (
          <>
            <LabelledToggle
              label="I stayed in a hotel"
              on={hotel}
              disabled={locked}
              onPress={() => {
                if (locked) return notify(LOCKED_WHY);
                mark();
                setHotel((v) => !v);
              }}
            />
            {!hotel ? (
              <Field
                label="Time you reached"
                hint="If you travelled overnight and arrived early without taking a room, there is an allowance for the morning. This is the time it is worked out from."
              >
                <Input
                  value={arrived}
                  onChangeText={(v) => {
                    mark();
                    setArrived(typedClock(v));
                  }}
                  placeholder="07:30"
                  keyboardType="number-pad"
                  editable={!locked}
                />
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
          <Input
            value={odoOpen}
            onChangeText={(v) => {
              mark();
              setOdoOpen(v);
            }}
            keyboardType="number-pad"
            editable={!locked}
          />
        </Field>
        <Field label="Reading at the end">
          <Input
            value={odoClose}
            onChangeText={(v) => {
              mark();
              setOdoClose(v);
            }}
            keyboardType="number-pad"
            editable={!locked}
          />
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
