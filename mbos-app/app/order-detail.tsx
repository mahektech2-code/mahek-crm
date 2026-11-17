import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import * as Clipboard from 'expo-clipboard';
import { useStore } from '../src/state/store';
import { journeyStepsOf, orderById, orderLines, orderTitle, type JourneyStep, type PunchedLine } from '../src/data/orders';
import { dmy, inrFromPaise, isoDate } from '../src/lib/format';
import { color as C, tabular, weight } from '../src/theme/tokens';

/**
 * ONE ORDER, as the office sees it: its number (and the TO it was), where it
 * is on the ladder, why it is held up if it is, what is on it and what it is
 * worth. A TO can still be edited here; an order with its order number cannot,
 * so the button asks the office instead — a WhatsApp message he sends to
 * whoever he works with there, already written.
 */

type Order = NonNullable<Awaited<ReturnType<typeof orderById>>>;

const PILL: Record<string, { bg: string; ink: string }> = {
  info: { bg: C.infoBg, ink: C.info },
  good: { bg: C.successBg, ink: C.success },
  warn: { bg: C.warnBg, ink: C.warnInk },
  bad: { bg: C.dangerBg, ink: C.danger },
  muted: { bg: C.wash, ink: C.muted },
};
const DOT: Record<JourneyStep['state'], string> = { done: C.success, current: C.warn, hold: C.danger, todo: C.hairline };

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [order, setOrder] = React.useState<Order | null>(null);
  const [lines, setLines] = React.useState<PunchedLine[]>([]);
  const notify = useStore((s) => s.notify);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (id)
        void Promise.all([orderById(id), orderLines(id)]).then(([o, l]) => {
          if (!live) return;
          setOrder(o);
          setLines(l);
        });
      return () => {
        live = false;
      };
    }, [id]),
  );

  if (!order) {
    return (
      <AppFrame tone="canvas" title="Order" activeTab="more">
        <T s="small" style={{ color: C.muted }}>
          Loading…
        </T>
      </AppFrame>
    );
  }

  const steps = journeyStepsOf(order);
  const tone = order.journeyTone ?? 'muted';
  const editable = order.journeyEditable != null ? order.journeyEditable === 1 : order.status === 'submitted' || order.status === 'pending_approval';
  const title = orderTitle(order) ?? 'Your order';
  const held = tone === 'bad' || tone === 'warn';

  const askOffice = async () => {
    const text = `Please change ${title} for ${order.customerName ?? 'the customer'}: `;
    const url = `whatsapp://send?text=${encodeURIComponent(text)}`;
    try {
      if (await Linking.canOpenURL(url)) return void (await Linking.openURL(url));
      throw new Error('no whatsapp');
    } catch {
      await Clipboard.setStringAsync(text).catch(() => undefined);
      notify('WhatsApp did not open. The message is copied: send it to the office.', 'error');
    }
  };

  return (
    <AppFrame
      tone="canvas"
      title={title}
      activeTab="more"
      showTitle={false}
      contentStyle={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 24 }}
      footer={
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}>
          {editable ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/order?edit=${order.id}&from=orders`)}
              style={({ pressed }) => [foot, { backgroundColor: C.primary, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[{ fontSize: 15, color: C.onNavy }, weight(700)]}>Edit order</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => void askOffice()}
                style={({ pressed }) => [foot, { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, opacity: pressed ? 0.85 : 1 }]}>
                <Text style={[{ fontSize: 15, color: C.ink }, weight(700)]}>Ask the office for a change</Text>
              </Pressable>
              <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, textAlign: 'center' }}>
                {order.erpOrderNo != null ? 'It has its order number, so you cannot edit it here.' : 'Accounts have decided it, so you cannot edit it here.'}
              </T>
            </>
          )}
        </View>
      }>
      <View style={{ backgroundColor: C.surface, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.hairline }}>
        <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{[order.customerName, order.customerCity].filter(Boolean).join(' · ')}</Text>
        <Text accessibilityRole="header" style={[{ fontSize: 24, lineHeight: 30, color: C.ink, marginTop: 2 }, weight(800)]}>
          {title}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {order.erpOrderNo != null && order.toNo != null ? <Pill bg={C.infoBg} ink={C.info} text={`was TO-${order.toNo}`} /> : null}
          {order.journeyStatus ? <Pill bg={PILL[tone]?.bg ?? C.wash} ink={PILL[tone]?.ink ?? C.muted} text={order.journeyStatus} /> : order.syncState === 'queued' ? <Pill bg={C.wash} ink={C.muted} text="Not sent yet" /> : null}
        </View>
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 12 }}>
        {order.journeyBanner ? (
          <View style={{ backgroundColor: held && tone === 'bad' ? C.dangerBg : C.warnBg, borderRadius: 16, padding: 14 }}>
            <T style={{ fontSize: 14, lineHeight: 20, color: tone === 'bad' ? C.danger : C.warnInk }}>{order.journeyBanner}</T>
          </View>
        ) : null}

        {steps.length ? (
          <View style={card}>
            {steps.map((st) => (
              <View key={st.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 7 }}>
                <View style={{ width: 13, height: 13, borderRadius: 7, marginTop: 3, backgroundColor: DOT[st.state] }} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 14, lineHeight: 19, color: st.state === 'todo' ? C.faint : C.ink }, weight(st.state === 'current' || st.state === 'hold' ? 700 : 400)]}>
                    {st.label}
                  </T>
                  {st.at || st.note ? (
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{[st.at ? dmy(isoDate(new Date(st.at))) : null, st.note].filter(Boolean).join(' · ')}</T>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        <View style={card}>
          {lines.map((l) => (
            <View key={l.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 3 }}>
              <T style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, color: C.ink }}>{l.productName}</T>
              <T style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, tabular]}>{`${l.cans} cans`}</T>
            </View>
          ))}
          {!order.valueUnavailable && order.netTotalPaise != null ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 3 }}>
              <T style={{ fontSize: 14, lineHeight: 19, color: C.muted }}>Value</T>
              <T style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, tabular]}>{inrFromPaise(order.netTotalPaise)}</T>
            </View>
          ) : null}
        </View>
      </View>
    </AppFrame>
  );
}

function Pill({ bg, ink, text }: { bg: string; ink: string; text: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 }}>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: ink }, weight(700)]}>{text}</Text>
    </View>
  );
}

const card = { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14 } as const;
const foot = { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' } as const;
