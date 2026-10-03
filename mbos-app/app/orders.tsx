import React from 'react';
import { Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { SkuChip } from '../src/components/ui/sku';
import {
  editableStatus,
  latestChangeRequests,
  listOrders,
  orderLines,
  type ChangeRequest,
  type PunchedLine,
  type PunchedOrder,
} from '../src/data/orders';
import { dmy, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { color as C, radius, tabular, weight, type BadgeTone } from '../src/theme/tokens';
import { Stagger, animateLayoutFor } from '../src/components/ui/motion';

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
    case 'pending_approval': return { label: 'With office', tone: 'amber' };
    case 'dispatched': return { label: 'Dispatched', tone: 'success' };
    case 'in_transit': return { label: 'On its way', tone: 'success' };
    case 'delivered': return { label: 'Delivered', tone: 'success' };
    default: return { label: 'Sent', tone: 'neutral' };
  }
}

export default function OrdersScreen() {
  const back = useCameFrom('more');

  const [rows, setRows] = React.useState<PunchedOrder[] | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<Record<string, PunchedLine[]>>({});
  const [changes, setChanges] = React.useState<Map<string, ChangeRequest>>(new Map());

  const load = React.useCallback(() => {
    let live = true;
    /* The lines are read afresh too: an edit, or a change accounts accepted,
       rewrites them — so "an order's lines never change" stopped being true. */
    setLines({});
    void Promise.all([listOrders(), latestChangeRequests()]).then(([r, c]) => {
      if (!live) return;
      setRows(r);
      setChanges(c);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  /* Opening a row pushes the rows below it down; animated, the eye follows
     the order it opened instead of losing it in a jump. Skipped on a long list
     by `animateLayoutFor`, where moving every row costs more than it says. */
  const show = (id: string) => {
    animateLayoutFor(rows?.length ?? 0);
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!lines[id]) {
      void orderLines(id).then((l) => {
        animateLayoutFor(rows?.length ?? 0);
        setLines((m) => ({ ...m, [id]: l }));
      });
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
        {waiting ? plural(waiting, 'order') + ' waiting for office' : 'No order waiting for office'}
      </T>

      <PrimaryButton
        label="New order"
        style={{ marginTop: 12, borderRadius: radius.xl }}
        onPress={() => router.push('/order?from=orders')}
      />

      {rows === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 16 }}>
          Loading…
        </T>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 28 }}>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }}>
            No orders yet.
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            Every order you take shows here, sent or not.
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 16 }}>
          {rows.map((o, i) => {
            const state = stateOf(o);
            const on = open === o.id;
            const mine = lines[o.id];

            return (
              <Stagger key={o.id} index={i} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: on }}
                  onPress={() => show(o.id)}
                  style={({ pressed }) => [
                    { paddingHorizontal: 16, paddingVertical: 14 },
                    pressed && { backgroundColor: C.wash },
                  ]}>
                  {/* THE NAME SHARES THIS LINE WITH THE VALUE AND NOTHING
                      ELSE. The badge was here too, and neither it nor the
                      value shrinks — so on a 360dp screen the "With the
                      office" badge, which is the longest of the five, left the
                      shop name about six characters. Those are precisely the
                      rows he opened the screen to look at: "did the one I
                      punched this morning go through?" reading "New Bh…". The
                      badge sits on the line below now, where what it eats into
                      is the date and the order number. */}
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
                        ? 'No value'
                        : inrFromPaise(o.netTotalPaise)}
                    </T>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                    <T s="caption" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
                      {[
                        dmy(isoDate(new Date(o.orderedAt))),
                        o.orderNumber,
                        o.deliveryDate ? 'for ' + dmy(o.deliveryDate) : null,
                        o.syncState === 'queued' ? 'not sent yet' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </T>
                    <Badge tone={state.tone} style={{ alignSelf: 'center' }}>
                      {state.label}
                    </Badge>
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

                  {/* A change he asked for after approval, followed to its
                      answer on the order itself rather than on a screen of its own. */}
                  {changes.get(o.id) ? <ChangeLine c={changes.get(o.id) as ChangeRequest} /> : null}
                </Pressable>

                {on ? (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6 }}>
                    {mine == null ? (
                      <T s="caption">Loading…</T>
                    ) : mine.length === 0 ? (
                      <T s="caption">No products on this order.</T>
                    ) : (
                      mine.map((l) => (
                        <View key={l.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <SkuChip sku={l.sku} />
                            <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>{l.productName}</T>
                          </View>
                          {/* Cans are what he counted and what the customer
                              said. Litres come off the SKU's own packing and
                              are shown beside them, never instead. */}
                          <T style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, tabular]}>
                            {plural(l.cans, 'can') + (l.litres ? ' · ' + Math.round(l.litres) + ' L' : '')}
                          </T>
                        </View>
                      ))
                    )}

                    {/* EDIT UNTIL ACCOUNTS DECIDE, ASK AFTER. Before approval
                        nothing has been promised against the order, so he
                        corrects it himself; once approved it is the office's
                        commitment and a change goes to accounts as a request.
                        Past dispatch neither — that is a phone call. */}
                    {editableStatus(o.status) ? (
                      <SecondaryButton
                        label="Edit this order"
                        style={{ marginTop: 8 }}
                        onPress={() => router.push(`/order?edit=${o.id}&from=orders`)}
                      />
                    ) : o.status === 'approved' ? (
                      changes.get(o.id)?.status === 'pending' ? (
                        <T s="caption" style={{ marginTop: 8 }}>
                          A change is waiting for accounts. You can ask for another once they answer.
                        </T>
                      ) : (
                        <SecondaryButton
                          label="Request a change"
                          style={{ marginTop: 8 }}
                          onPress={() => router.push(`/order?change=${o.id}&from=orders`)}
                        />
                      )
                    ) : null}
                  </View>
                ) : null}
              </Stagger>
            );
          })}
        </ListCard>
      )}
    </AppFrame>
  );
}

/** Where a change he asked for has got to. */
function ChangeLine({ c }: { c: ChangeRequest }) {
  const refused = c.syncState === 'rejected' || c.syncState === 'blocked';
  const [text, tone] = refused
    ? ['Change request not accepted by the office — ' + (c.syncMessage ?? 'see Sync'), C.danger]
    : c.syncState === 'queued'
      ? ['Change request saved — sends when you have signal', C.muted]
      : c.status === 'pending'
        ? ['Change requested · waiting for accounts', C.warnInk]
        : c.status === 'accepted'
          ? ['Change accepted by accounts' + (c.decisionNote ? ' — ' + c.decisionNote : ''), C.success]
          : ['Change declined — ' + (c.decisionNote ?? 'no reason given'), C.danger];
  return <T style={{ fontSize: 13, lineHeight: 19, color: tone, marginTop: 4 }}>{text}</T>;
}
