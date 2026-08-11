import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card } from '../src/components/ui/primitives';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { plural, pretty } from '../src/lib/format';
import { OUTCOMES } from '../src/data/fixtures';

/**
 * The receipt for a visit.
 *
 * Every line is honest about what actually happened, and the dot beside it
 * carries the difference: green means done, amber means saved but not finished
 * yet. A photograph still in the queue and a photograph on the server are not
 * the same thing, and telling the salesman they are is how trust in the sync
 * indicator goes.
 */

export default function Saved() {
  const c = useCustomer();
  const outcome = useStore((s) => s.outcome);
  const shots = useStore((s) => s.shots);
  const rec = useStore((s) => s.rec);
  const gps = useStore((s) => s.gps);
  const nextDate = useStore((s) => s.nextDate);
  const visitSpent = useStore((s) => s.visitSpent);

  const picked = OUTCOMES.find((o) => o.k === outcome) ?? OUTCOMES[0];
  const shotCount = (shots.shop ? 1 : 0) + (shots.cust ? 1 : 0);
  const spent = visitSpent ?? '';

  const items = [
    gps === 'locked'
      ? { l: 'Location and time recorded', ok: true }
      : { l: 'Saved without a location — flagged for your manager', ok: false },
    shotCount ? { l: plural(shotCount, 'photo') + ' compressed and queued', ok: false } : null,
    rec === 'done'
      ? { l: 'Voice note transcribed and attached', ok: true }
      : rec === 'failed' || rec === 'rec' || rec === 'busy'
        ? { l: 'Voice note kept, transcribing when you are back on', ok: false }
        : null,
    { l: 'Follow-up set for ' + pretty(nextDate), ok: true },
    { l: 'Your manager notified', ok: true },
  ].filter((x): x is { l: string; ok: boolean } => x !== null);

  return (
    <AppFrame title="Visit saved" activeTab="customers" contentStyle={{ paddingHorizontal: 16, paddingVertical: 24 }}>
      <Card style={{ padding: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: C.successBg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="tick" size={20} color={C.success} strokeWidth={2} />
          </View>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Visit saved</Text>
        </View>

        <Text style={[type.small, { color: C.body, marginTop: 10 }]}>
          {[c?.name, picked.label, spent ? spent + ' in the shop' : null].filter(Boolean).join(' · ')}
        </Text>

        <View style={{ marginTop: 14 }}>
          {items.map((s) => (
            <View key={s.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.wash }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.ok ? C.success : C.warn }} />
              <Text style={{ fontSize: 15, color: C.body, flex: 1 }}>{s.l}</Text>
            </View>
          ))}
        </View>

        <Pressable
          onPress={() => router.replace('/customers')}
          style={{ width: '100%', height: 52, marginTop: 16, borderRadius: radius.sm, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[{ fontSize: 15, color: '#FFFFFF' }, weight(600)]}>Next stop</Text>
        </Pressable>
        <Pressable
          onPress={() => router.replace('/home')}
          style={{ width: '100%', height: HIT, marginTop: 8, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Back to home</Text>
        </Pressable>
      </Card>
    </AppFrame>
  );
}
