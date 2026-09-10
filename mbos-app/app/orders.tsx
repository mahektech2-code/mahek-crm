import React from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { listOrders, orderLines, type PunchedLine, type PunchedOrder } from '../src/data/orders';
import { dmy, inr, isoDate, plural } from '../src/lib/format';
import { color as C, radius, tabular, weight, type BadgeTone } from '../src/theme/tokens';

/**
 * Orders he has taken.
 *
 * More → Orders opened the blank ORDER FORM, which is a reasonable thing to
 * reach and the wrong thing to call "Orders": there was no list of his own
 * orders anywhere in the app, so "did the one I punched this morning go
 * through?" had no answer on the handset. `listOrders` and `orderLines` were
 * both written and neither had ever been called.
 *
 * Punching a new one is the + button, which is where every other capture
 * starts — a list that is also a form is two screens wearing one name.
 *
 * The LINES are fetched a row at a time, when a row is opened. Fetching them
 * all up front would be a second query per order on a list of a hundred, to
 * render something nobody has asked to see yet.
 */

function stateOf(o: PunchedOrder): { label: string; tone: BadgeTone } {
  switch (o.status) {
    case 'approved': return { label: 'Approved', tone: 'success' };
    case 'rejected': return { label: 'Not approved', tone: 'danger' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' };
    case 'pending_approval': return { label: 'With the office', tone: 'amber' };
    default: return { label: 'Sent', tone: 'neutral' };
  }
}

export default function OrdersScreen() {
  const back = useCameFrom('more');

  const [rows, setRows] = React.useState<PunchedOrder[] | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<Record<string, PunchedLine[]>>({});

  const load = React.useCallback(() => {
    let live = true;
    void listOrders().then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const show = (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    /* Read once and kept. An order's lines do not change after it is punched —
       the office can decline the whole order, never edit a line of it. */
    if (!lines[id]) {
      void orderLines(id).then((l) => setLines((m) => ({ ...m, [id]: l })));
    }
  };

  /* What is still waiting on somebody. Cancelled and declined orders are not
     "waiting" and counting them here would make the number never fall. */
  const waiting = (rows ?? []).filter((o) => o.status === 'pending_approval').length;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Your orders</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        {waiting ? plural(waiting, 'order') + ' with the office' : 'Nothing waiting on the office'}
      </T>

      <PrimaryButton
        label="Punch an order"
        style={{ marginTop: 12, borderRadius: radius.xl }}
        onPress={() => router.push('/order?from=orders')}
      />

      {rows === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 16 }}>
          Reading…
        </T>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>
            No orders yet.
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            Everything you punch shows up here, whether it has reached the office or not.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 16 }}>
          {rows.map((o, i) => {
            const state = stateOf(o);
            const on = open === o.id;
            const mine = lines[o.id];

            return (
              <View key={o.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: on }}
                  onPress={() => show(o.id)}
                  style={({ pressed }) => [
                    { paddingHorizontal: 16, paddingVertical: 14 },
                    pressed && { backgroundColor: C.wash },
                  ]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <T
                      numberOfLines={1}
                      style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                      {o.customerName ?? 'Unknown customer'}
                    </T>
                    {/* An order is worth what was typed, and where nothing was
                        it says so rather than showing a confident ₹0 — there
                        are no prices in the product master to fall back on. */}
                    <T style={[{ fontSize: 15, color: C.ink }, weight(600), tabular]}>
                      {o.valueUnavailable || o.netTotalPaise == null
                        ? 'Not valued'
                        : inr(o.netTotalPaise / 100)}
                    </T>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <T s="caption" style={{ flex: 1, minWidth: 0 }}>
                      {[
                        dmy(isoDate(new Date(o.orderedAt))),
                        o.orderNumber,
                        o.deliveryDate ? 'for ' + dmy(o.deliveryDate) : null,
                        o.syncState === 'queued' ? 'not sent yet' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </T>
                    {/* `forward` turned, because there is no up/down glyph and
                        `ICONS[name] ?? ICONS.dots` would have drawn an ellipsis
                        without complaining about it. */}
                    <View style={{ transform: [{ rotate: on ? '-90deg' : '90deg' }] }}>
                      <Icon name="forward" size={16} color={C.faint} strokeWidth={1.5} />
                    </View>
                  </View>

                  {/* Why it was refused, on the row rather than a screen away.
                      He has to ring the customer about it either way. */}
                  {o.status === 'rejected' || o.status === 'cancelled' ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 4 }}>
                      {o.cancelReason ?? o.syncMessage ?? 'No reason was given.'}
                    </T>
                  ) : null}
                </Pressable>

                {on ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6 }}>
                    {mine == null ? (
                      <T s="caption">Reading…</T>
                    ) : mine.length === 0 ? (
                      <T s="caption">No lines were recorded on this order.</T>
                    ) : (
                      mine.map((l) => (
                        <View key={l.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                          <T style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: C.body }}>
                            {l.productName}
                          </T>
                          {/* Cans are what he counted and what the customer
                              said. Litres come off the SKU's own packing and
                              are shown beside them, never instead. */}
                          <T style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, tabular]}>
                            {plural(l.cans, 'can') + (l.litres ? ' · ' + Math.round(l.litres) + ' L' : '')}
                          </T>
                        </View>
                      ))
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}
