import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { Badge, T } from '../src/components/ui/primitives';
import { journeyStepsOf, orderById, ordersTakenToday, orderTitle, type PunchedOrder } from '../src/data/orders';
import { inrFromPaise, plural } from '../src/lib/format';
import { color as C, tabular, weight, type BadgeTone } from '../src/theme/tokens';

/**
 * ORDER SENT — the receipt after he takes an order. It says what the order is
 * now: a TO number (once the office has given it one), with the back office
 * and the Production Head still to check it, and that it can still be changed
 * until it gets its order number. Below it, the orders he took today.
 *
 * The TO number is the office's, so an order still in the outbox — no signal —
 * says that it will get one, rather than inventing a number.
 */

const JOURNEY_TONE: Record<string, BadgeTone> = { info: 'info', good: 'success', warn: 'amber', bad: 'danger', muted: 'neutral' };

type Order = NonNullable<Awaited<ReturnType<typeof orderById>>>;

export default function OrderSent() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [order, setOrder] = React.useState<Order | null>(null);
  const [today, setToday] = React.useState<PunchedOrder[]>([]);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void Promise.all([id ? orderById(id) : Promise.resolve(null), ordersTakenToday()]).then(([o, t]) => {
        if (!live) return;
        setOrder(o);
        setToday(t);
      });
      return () => {
        live = false;
      };
    }, [id]),
  );

  const title = order ? (orderTitle(order) ?? 'Order saved') : 'Order saved';
  const steps = order ? journeyStepsOf(order) : [];
  const checked = steps.find((s) => s.key === 'checked');
  const check = (key: 'backOffice' | 'production') => (checked?.state === 'done' || checked?.[key] ? 'done' : 'waiting');
  const editable = order ? (order.journeyEditable != null ? order.journeyEditable === 1 : order.status === 'submitted' || order.status === 'pending_approval') : false;
  const queued = order?.syncState === 'queued';

  return (
    <AppFrame
      tone="canvas"
      title="Order sent"
      activeTab="more"
      showTitle={false}
      contentStyle={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 24 }}
      footer={
        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
          <Pressable
            accessibilityRole="button"
            disabled={!editable || !order}
            onPress={() => order && router.replace(`/order?edit=${order.id}&from=orders`)}
            style={({ pressed }) => [footBtn, { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, opacity: !editable ? 0.45 : pressed ? 0.85 : 1 }]}>
            <Text style={[{ fontSize: 15, color: C.ink }, weight(700)]}>Edit order</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
            style={({ pressed }) => [footBtn, { backgroundColor: C.primary, opacity: pressed ? 0.85 : 1 }]}>
            <Text style={[{ fontSize: 15, color: C.onNavy }, weight(700)]}>Done</Text>
          </Pressable>
        </View>
      }>
      <View style={{ backgroundColor: C.primary, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 20 }}>
        <Text style={{ fontSize: 12, lineHeight: 16, color: C.primaryTint }}>Order sent</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 26, lineHeight: 32, color: C.onNavy }, weight(800)]}>
            {title}
          </Text>
          {order?.toNo != null && order.erpOrderNo == null ? (
            <View style={{ backgroundColor: C.surface, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Text style={[{ fontSize: 9, color: C.primary, letterSpacing: 0.5 }, weight(800)]}>NEW</Text>
            </View>
          ) : null}
        </View>
        {order ? (
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryTint, marginTop: 4 }, tabular]}>
            {[order.customerName, order.customerCity, plural(order.lineCount, 'line'), order.valueUnavailable || order.netTotalPaise == null ? null : inrFromPaise(order.netTotalPaise)]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 12 }}>
        <View style={card}>
          <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{order?.erpOrderNo != null ? 'Order number made' : 'With order check'}</T>
          <T style={{ fontSize: 13, lineHeight: 19, color: C.body, marginTop: 4 }}>
            {queued
              ? 'Saved on this phone. It gets its TO number when it reaches the office. Then the back office and the Production Head check it.'
              : 'The back office and the Production Head check it. When both have, it gets its order number and goes to accounts.'}
          </T>
          <View style={{ marginTop: 10, gap: 6 }}>
            <Row label="Back office" value={check('backOffice') === 'done' ? 'checked' : 'waiting'} done={check('backOffice') === 'done'} />
            <Row label="Production Head" value={check('production') === 'done' ? 'checked' : 'waiting'} done={check('production') === 'done'} />
            <Row label="Accounts" value={order?.erpOrderNo != null ? 'checking' : 'after the order number'} done={false} />
          </View>
        </View>

        {editable ? (
          <View style={{ backgroundColor: C.warnBg, borderWidth: 1, borderColor: C.warnEdge, borderRadius: 16, padding: 14 }}>
            <T style={{ fontSize: 13, lineHeight: 19, color: C.ink }}>You can still change this order. Once it has its order number, ask the office to change it.</T>
          </View>
        ) : null}

        {today.length ? (
          <>
            <Text style={[{ fontSize: 12, lineHeight: 16, color: C.muted, letterSpacing: 0.6, marginTop: 6 }, weight(700)]}>MY ORDERS TODAY</Text>
            {today.map((o) => {
              const t = orderTitle(o) ?? 'Order';
              const sub = [o.erpOrderNo != null && o.toNo != null ? `from TO-${o.toNo}` : null, o.customerName].filter(Boolean).join(' · ');
              return (
                <Pressable
                  key={o.id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/order-detail?id=${o.id}`)}
                  style={({ pressed }) => [card, { flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.85 : 1 }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{t}</T>
                    <T numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 2 }}>
                      {sub}
                    </T>
                  </View>
                  {o.journeyStatus ? <Badge tone={JOURNEY_TONE[o.journeyTone ?? ''] ?? 'neutral'}>{o.journeyStatus}</Badge> : o.syncState === 'queued' ? <Badge tone="neutral">Not sent yet</Badge> : null}
                </Pressable>
              );
            })}
          </>
        ) : null}
      </View>
    </AppFrame>
  );
}

function Row({ label, value, done }: { label: string; value: string; done: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
      <T style={{ fontSize: 13, lineHeight: 18, color: C.ink }}>{label}</T>
      <T style={[{ fontSize: 13, lineHeight: 18, color: done ? C.success : C.faint }, weight(done ? 700 : 400)]}>{value}</T>
    </View>
  );
}

const card = { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14 } as const;
const footBtn = { flex: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' } as const;
