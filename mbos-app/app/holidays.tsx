import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular } from '../src/theme/tokens';
import { isoDate } from '../src/lib/format';
import { listHolidays, type HolidayItem } from '../src/data/attendance';
import { GLYPH, Glyph, type GlyphShape } from '../src/components/me/kit';

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

  const loadedSome = rows != null && rows.length > 0;
  const hero = (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 18 }}>
          {loadedSome ? (
            <>
              <View accessible accessibilityLabel={`Your holidays: ${mine.length}`}>
                <T style={[{ fontSize: 30, lineHeight: 36, letterSpacing: -0.6, color: C.lavenderInk }, weight(800), tabular]}>{mine.length}</T>
                <T style={{ marginTop: 4, fontSize: 12, color: C.lavenderMuted }}>your holidays</T>
              </View>
              <View accessible accessibilityLabel={`Still ahead: ${ahead.length}`}>
                <T style={[{ fontSize: 30, lineHeight: 36, letterSpacing: -0.6, color: C.primaryDeep }, weight(800), tabular]}>{ahead.length}</T>
                <T style={{ marginTop: 4, fontSize: 12, color: C.lavenderMuted }}>still ahead</T>
              </View>
            </>
          ) : null}
        </View>
        <View style={{ minHeight: 44, borderRadius: 22, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous year" onPress={() => setYear((y) => y - 1)} hitSlop={4} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 18, color: C.lavenderInk }}>‹</T>
          </Pressable>
          <T style={[{ fontSize: 15, color: C.lavenderInk }, weight(800), tabular]}>{year}</T>
          <Pressable accessibilityRole="button" accessibilityLabel="Next year" onPress={() => setYear((y) => y + 1)} hitSlop={4} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 18, color: C.lavenderInk }}>›</T>
          </Pressable>
        </View>
      </View>
      {loadedSome ? (
        next ? (
          <View
            accessible
            accessibilityLabel={`Next: ${next.name}, ${dayLine(next.onDate)}`}
            style={{ marginTop: 12, minHeight: 44, borderRadius: 22, backgroundColor: C.navy, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
            <Glyph shapes={CAL} size={16} color={C.lime} />
            <T style={{ flexShrink: 1, fontSize: 14, color: C.onNavyMuted }}>Next</T>
            <T numberOfLines={1} style={[{ fontSize: 14, color: C.onNavy, flexShrink: 1 }, weight(800)]}>{next.name}</T>
            <View style={{ flex: 1 }} />
            <T style={[{ fontSize: 14, color: C.lime }, weight(700), tabular]}>{dayLine(next.onDate)}</T>
          </View>
        ) : (
          <View style={{ marginTop: 12, minHeight: 44, borderRadius: 22, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
            <Glyph shapes={CAL} size={16} color={C.lavenderMuted} />
            <T style={{ flexShrink: 1, fontSize: 14, color: C.lavenderMuted }}>No more holidays for you this year.</T>
          </View>
        )
      ) : null}
      <Text
        accessibilityLabel="Your days off, as the office has set them — company-wide, your state, district, city or area, and any given to you by name. No punch-in is expected on these days."
        style={[{ fontSize: 12, lineHeight: 17, color: C.lavenderMuted, marginTop: 10 }, weight(400)]}>
        Set by the office: company-wide, your state, district, city or area, or given to you by name. No punch-in expected.
      </Text>
    </View>
  );

  return (
    <AppFrame title="Holidays" activeTab={null} onBack={back.go} hero={hero} contentStyle={{ padding: 14, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

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
          {mine.length === 0 ? (
            <Card style={{ marginBottom: 10 }}>
              <T s="small" style={{ color: C.muted }}>
                None of the {year} holidays are yours. If that looks wrong, ask the office which area you are allocated.
              </T>
            </Card>
          ) : null}

          {[...byMonth.entries()].map(([m, list], gi) => (
            <Stagger key={m} index={gi}>
              <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink, paddingTop: 4, paddingHorizontal: 6, marginBottom: 10 }, weight(800)]}>
                {MONTHS[m]}
              </T>
              <Card padded={false} style={{ marginBottom: 10, borderRadius: 22, overflow: 'hidden' }}>
                {list.map((h, i) => {
                  const past = h.onDate < todayIso;
                  const isToday = h.onDate === todayIso;
                  const ink = past ? C.faint : C.ink;
                  const sub = past ? C.faint : C.muted;
                  const [, , dd] = h.onDate.split('-').map(Number);
                  return (
                    <View
                      key={h.id}
                      accessible
                      accessibilityLabel={`${dayLine(h.onDate)}, ${h.name}, ${h.scope ?? 'Company-wide'}${isToday ? ', today' : past ? ', gone' : ''}`}
                      style={{
                        minHeight: 60,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        borderTopWidth: i ? 1 : 0,
                        borderTopColor: C.hairline,
                        backgroundColor: isToday ? '#F7FBEA' : undefined,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                      }}>
                      <View style={{ width: 44, alignItems: 'center' }}>
                        <T style={[{ fontSize: 17, lineHeight: 21, color: ink }, weight(800), tabular]}>{dd}</T>
                        <T style={{ marginTop: 4, fontSize: 11, lineHeight: 14, color: ink }}>{weekday(h.onDate)}</T>
                      </View>
                      <View style={{ flex: 1 }}>
                        <T style={[{ fontSize: 15, lineHeight: 20, color: ink }, weight(700)]}>{h.name}</T>
                        <ScopeLine scope={h.scope} color={sub} />
                      </View>
                      {isToday ? <Badge tone="success">Today</Badge> : null}
                    </View>
                  );
                })}
              </Card>
            </Stagger>
          ))}

          {others.length ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowOthers((v) => !v)}
                style={{ minHeight: 48, paddingVertical: 8, borderRadius: 24, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10 }}>
                <Glyph shapes={showOthers ? GLYPH.chevUp : GLYPH.chevDown} size={14} color={C.primaryDeep} strokeWidth={2.4} />
                <T style={[{ flexShrink: 1, fontSize: 14, color: C.primaryDeep }, weight(700)]}>
                  {showOthers ? 'Hide' : 'Show'} {others.length} holiday{others.length === 1 ? '' : 's'} for other places
                </T>
              </Pressable>
              {showOthers ? (
                <Card padded={false} style={{ borderRadius: 22, overflow: 'hidden', opacity: 0.85 }}>
                  {others.map((h, i) => {
                    const [, mm, dd] = h.onDate.split('-').map(Number);
                    return (
                      <View
                        key={h.id}
                        accessible
                        accessibilityLabel={`${dayLine(h.onDate)}, ${h.name}, not yours, ${h.scope ?? 'not given to you'}`}
                        style={{ minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: C.hairline, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <View style={{ width: 44, alignItems: 'center' }}>
                          <T style={[{ fontSize: 17, lineHeight: 21, color: C.faint }, weight(800), tabular]}>{dd}</T>
                          <T style={{ marginTop: 4, fontSize: 11, lineHeight: 14, color: C.faint }}>
                            {MONTHS[mm - 1].slice(0, 3)} · {weekday(h.onDate)}
                          </T>
                        </View>
                        <View style={{ flex: 1 }}>
                          <T style={{ fontSize: 15, lineHeight: 20, color: C.muted }}>{h.name}</T>
                          <T style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.faint }}>Not yours · {h.scope ?? 'not given to you'}</T>
                        </View>
                      </View>
                    );
                  })}
                </Card>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </AppFrame>
  );
}

const CAL: GlyphShape[] = [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16M9 3v4M15 3v4' }];
const BY_NAME: GlyphShape[] = [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }];

function weekday(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()];
}

/**
 * Where a holiday is for. Company-wide is the default and needs no mark; a
 * place gets a pin, and a day given to him by name a person.
 */
function ScopeLine({ scope, color }: { scope: string | null; color: string }) {
  if (!scope) return <T style={{ fontSize: 12, lineHeight: 16, color }}>Company-wide</T>;
  const named = /name/i.test(scope);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Glyph shapes={named ? BY_NAME : GLYPH.pin} size={11} color={color} strokeWidth={2.2} />
      <T style={{ fontSize: 12, lineHeight: 16, color, flexShrink: 1 }}>{scope}</T>
    </View>
  );
}
