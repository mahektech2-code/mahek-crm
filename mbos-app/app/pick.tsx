import React from 'react';
import { View, Pressable, TextInput, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame } from '../src/components/shell/AppFrame';
import { PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import {
  pickCandidates,
  pickShops,
  pickedFor,
  planDay,
  type Candidate,
  type PlanDay,
} from '../src/data/journey';
import { inr, isoDate, plural } from '../src/lib/format';
import { daysSince } from '../src/data/customers';
import { useStore } from '../src/state/store';

/**
 * Picking the shops for a day you have agreed.
 *
 * The other half of the negotiation, and the half that was missing. The office
 * proposes a city; you pick the doors, because you are the one who knows which
 * of them are worth a Tuesday morning. Until this screen existed you could
 * agree to a day and then had no way to fill it, so the office arranged the
 * stops — which is still available to them, as the exception it should be.
 *
 * **The order you tick is the order you walk.** No optimiser here: reordering
 * lives on the route screen and runs against where you actually are on the
 * morning, which is not knowable the evening before. The number on each ticked
 * row says where it sits, so the list is the plan rather than a set.
 *
 * **The proposed city rises to the top; it does not filter.** A man going to
 * Nagpur often has one call to make on the way, and a list that hid it would
 * send him back to the office to ask. The row says "elsewhere" so nothing is
 * picked by accident.
 *
 * **Who you have not seen sorts first.** The question a plan answers is which
 * shops are going without a visit, and a customer seen yesterday is the last
 * one to put on tomorrow.
 */
export default function PickScreen() {
  const params = useLocalSearchParams<{ day?: string }>();
  const planDayId = typeof params.day === 'string' ? params.day : '';
  const notify = useStore((s) => s.notify);

  const [day, setDay] = React.useState<PlanDay | null>(null);
  const [rows, setRows] = React.useState<Candidate[]>([]);
  const [picked, setPicked] = React.useState<string[]>([]);
  const [q, setQ] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [today] = React.useState(() => isoDate(new Date()));

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const d = await planDay(planDayId);
      if (!live) return;
      setDay(d);
      /* Whatever was picked before, so reopening the screen is a correction
         rather than starting again. */
      setPicked(await pickedFor(planDayId));
    })();
    return () => {
      live = false;
    };
  }, [planDayId]);

  React.useEffect(() => {
    let live = true;
    void pickCandidates(day?.city ?? null, q).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [day?.city, q]);

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  const save = async () => {
    setSaving(true);
    const out = await pickShops(planDayId, picked);
    setSaving(false);
    if (!out.ok) return notify(out.message ?? 'Pick at least one shop.');
    notify(plural(picked.length, 'shop') + ' picked. Your manager can see the day now.');
    router.back();
  };

  if (!day) {
    return (
      <AppFrame title="Pick your shops" contentStyle={{ padding: 16 }}>
        <T s="small" style={{ color: C.muted }}>
          That day is not on this handset. Pull down on the route screen to fetch it.
        </T>
      </AppFrame>
    );
  }

  const here = (day.city ?? '').trim().toLowerCase();

  return (
    <AppFrame
      title={'Pick your shops'}
      contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120 }}>
      <View
        style={{
          backgroundColor: C.surface,
          borderRadius: radius.card,
          borderLeftWidth: 3,
          borderLeftColor: C.primary,
          padding: 14,
          marginBottom: 12,
          boxShadow: shadow.card,
        }}>
        <T style={[type.body, weight(600), { color: C.ink }]}>{day.planDate}</T>
        <T s="small" style={{ color: C.body, marginTop: 2 }}>
          {day.city ? day.city + ' — you agreed this day' : 'You agreed this day'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 6 }}>
          Tick them in the order you mean to walk them. You can change the order on the morning,
          from wherever you actually are.
        </T>
      </View>

      <View style={{ position: 'relative', marginBottom: 10 }}>
        <View style={{ position: 'absolute', left: 14, top: 16, zIndex: 1 }}>
          <Icon name="search" size={20} color={C.muted} strokeWidth={1.5} />
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search a shop, an area, a city"
          placeholderTextColor={C.muted}
          style={{
            height: 48,
            paddingLeft: 44,
            paddingRight: 14,
            borderRadius: radius.card,
            backgroundColor: C.surface,
            color: C.ink,
            fontSize: 15,
            boxShadow: shadow.card,
          }}
        />
      </View>

      <ScrollView>
        {rows.length === 0 ? (
          <T s="small" style={{ color: C.muted, paddingVertical: 24, textAlign: 'center' }}>
            {q ? 'No shop matches that.' : 'There are no customers on this handset yet.'}
          </T>
        ) : null}

        {rows.map((c) => {
          const at = picked.indexOf(c.id);
          const on = at >= 0;
          const gap = daysSince(c.lastVisitDate, today);
          const elsewhere = here && (c.city ?? '').trim().toLowerCase() !== here;

          return (
            <Pressable
              key={c.id}
              onPress={() => toggle(c.id)}
              hitSlop={HIT}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                backgroundColor: C.surface,
                borderRadius: radius.card,
                padding: 14,
                marginBottom: 8,
                borderWidth: on ? 1 : 0,
                borderColor: on ? C.primary : 'transparent',
                boxShadow: shadow.card,
              }}>
              {/* The number, not a tick: where it sits in the day is the thing
                  that is being decided, and a tick would hide it. */}
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? C.primary : C.canvas,
                }}>
                <T style={[type.small, weight(600), { color: on ? '#fff' : C.muted }]}>
                  {on ? String(at + 1) : ''}
                </T>
              </View>

              <View style={{ flex: 1 }}>
                <T style={[type.body, weight(on ? 600 : 500), { color: C.ink }]} numberOfLines={1}>
                  {c.name}
                </T>
                <T s="small" style={{ color: C.muted, marginTop: 2 }} numberOfLines={1}>
                  {[c.area, elsewhere ? (c.city ?? 'elsewhere') : null].filter(Boolean).join(' · ') ||
                    'No area recorded'}
                </T>
                <T s="small" style={{ color: C.muted, marginTop: 2 }}>
                  {gap == null
                    ? 'Never visited'
                    : gap === 0
                      ? 'Visited today'
                      : 'Last seen ' + plural(gap, 'day') + ' ago'}
                  {c.outstandingPaise > 0 ? ' · ' + inr(c.outstandingPaise) + ' owing' : ''}
                </T>
              </View>

              {elsewhere ? (
                <T s="small" style={{ color: C.muted }}>
                  elsewhere
                </T>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Fixed to the bottom, because the list is long and the decision is made
          part-way down it. The count is on the button so nothing has to be
          scrolled back to to check. */}
      <View
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: 20,
          gap: 8,
        }}>
        <PrimaryButton
          label={
            saving
              ? 'Sending…'
              : picked.length
                ? 'Plan the day · ' + plural(picked.length, 'shop')
                : 'Pick at least one shop'
          }
          fullWidth
          disabled={saving || picked.length === 0}
          onPress={() => void save()}
        />
        <SecondaryButton label="Not now" fullWidth onPress={() => router.back()} />
      </View>
    </AppFrame>
  );
}
