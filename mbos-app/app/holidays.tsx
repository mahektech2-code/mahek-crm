import React from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular } from '../src/theme/tokens';
import { isoDate } from '../src/lib/format';
import { listHolidays, type HolidayItem } from '../src/data/attendance';

/**
 * HIS HOLIDAYS — the company's calendar, with the days that are his marked.
 *
 * Who a holiday reaches is the office's answer, sent per salesman as
 * `universal`: company-wide days, his state's, his district's, city's or
 * area's, and any given to him by name. A day taken away from him arrives as
 * not his. The phone never works it out, so a holiday added or changed at the
 * office reaches this screen on the next sync with no update to the app.
 *
 * The days that are NOT his are listed beneath, greyed, with where they are
 * for — the Odisha team being off is a thing he will hear about, and the row
 * says why it is not his day.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLine(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(y, m - 1, d);
  return `${DAYS[at.getDay()]} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

export default function HolidaysScreen() {
  const back = useCameFrom('more');
  const todayIso = isoDate(new Date());
  const [year, setYear] = React.useState(Number(todayIso.slice(0, 4)));
  const [rows, setRows] = React.useState<HolidayItem[] | null>(null);
  const [showOthers, setShowOthers] = React.useState(false);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void listHolidays(year).then((r) => {
        if (live) setRows(r);
      });
      return () => {
        live = false;
      };
    }, [year]),
  );

  const mine = (rows ?? []).filter((r) => r.universal === 1);
  const others = (rows ?? []).filter((r) => r.universal !== 1);
  const ahead = mine.filter((r) => r.onDate >= todayIso);
  const next = ahead[0] ?? null;

  /* Grouped by month, because "what is coming in October" is how he asks. */
  const byMonth = new Map<number, HolidayItem[]>();
  for (const r of mine) {
    const m = Number(r.onDate.slice(5, 7)) - 1;
    byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
  }

  return (
    <AppFrame title="Holidays" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T s="h1">Holidays</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous year" onPress={() => setYear((y) => y - 1)} hitSlop={10} style={{ paddingHorizontal: 10, paddingVertical: 4 }}>
            <T style={{ fontSize: 20, color: C.muted }}>‹</T>
          </Pressable>
          <T style={[{ fontSize: 16, color: C.ink }, weight(600), tabular]}>{year}</T>
          <Pressable accessibilityRole="button" accessibilityLabel="Next year" onPress={() => setYear((y) => y + 1)} hitSlop={10} style={{ paddingHorizontal: 10, paddingVertical: 4 }}>
            <T style={{ fontSize: 20, color: C.muted }}>›</T>
          </Pressable>
        </View>
      </View>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 16 }}>
        Your days off, as the office has set them — company-wide, your state, district, city or area, and any given to you by name. No punch-in is expected on these days.
      </T>

      {!rows ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>Loading…</T>
        </Card>
      ) : rows.length === 0 ? (
        <Card style={{ paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>No holidays for {year} on this phone</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            The office has not set any yet, or this phone has not synced since they did. Pull to sync from the Home screen.
          </T>
        </Card>
      ) : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 24 }}>
              <View>
                <T s="label">Your holidays</T>
                <T style={[{ fontSize: 26, color: C.ink }, weight(600), tabular]}>{mine.length}</T>
              </View>
              <View>
                <T s="label">Still ahead</T>
                <T style={[{ fontSize: 26, color: C.ink }, weight(600), tabular]}>{ahead.length}</T>
              </View>
            </View>
            {next ? (
              <T s="small" style={{ marginTop: 8, color: C.body }}>
                Next: <T s="small" style={[{ color: C.ink }, weight(600)]}>{next.name}</T> · {dayLine(next.onDate)}
              </T>
            ) : (
              <T s="small" style={{ marginTop: 8, color: C.muted }}>No more holidays for you this year.</T>
            )}
          </Card>

          {mine.length === 0 ? (
            <T s="small" style={{ color: C.muted, marginBottom: 16 }}>
              None of the {year} holidays are yours. If that looks wrong, ask the office which area you are allocated.
            </T>
          ) : null}

          {[...byMonth.entries()].map(([m, list], gi) => (
            <Stagger key={m} index={gi}>
              <T s="label" style={{ marginBottom: 6, marginTop: 4 }}>{MONTHS[m]}</T>
              <Card padded={false} style={{ marginBottom: 12 }}>
                {list.map((h, i) => {
                  const past = h.onDate < todayIso;
                  return (
                    <View
                      key={h.id}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderTopWidth: i ? 1 : 0,
                        borderTopColor: C.hairline,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <T style={[{ width: 92, color: past ? C.muted : C.ink }, tabular]}>{dayLine(h.onDate)}</T>
                      <View style={{ flex: 1 }}>
                        <T style={[{ fontSize: 15, color: past ? C.muted : C.ink }, weight(600)]}>{h.name}</T>
                        <T s="micro">{h.scope ?? 'Company-wide'}</T>
                      </View>
                      {h.onDate === todayIso ? <Badge tone="success">Today</Badge> : null}
                    </View>
                  );
                })}
              </Card>
            </Stagger>
          ))}

          {others.length ? (
            <>
              <Pressable accessibilityRole="button" onPress={() => setShowOthers((v) => !v)} style={{ paddingVertical: 10 }}>
                <T s="small" style={[{ color: C.primaryDeep }, weight(600)]}>
                  {showOthers ? 'Hide' : 'Show'} {others.length} holiday{others.length === 1 ? '' : 's'} for other places
                </T>
              </Pressable>
              {showOthers ? (
                <Card padded={false}>
                  {others.map((h, i) => (
                    <View
                      key={h.id}
                      style={{ paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, flexDirection: 'row', gap: 12 }}
                    >
                      <T style={[{ width: 92, color: C.muted }, tabular]}>{dayLine(h.onDate)}</T>
                      <View style={{ flex: 1 }}>
                        <T style={{ fontSize: 15, color: C.muted }}>{h.name}</T>
                        <T s="micro">Not yours · {h.scope ?? 'not given to you'}</T>
                      </View>
                    </View>
                  ))}
                </Card>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </AppFrame>
  );
}
