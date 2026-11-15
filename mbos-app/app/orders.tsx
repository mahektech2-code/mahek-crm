import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, T } from '../src/components/ui/primitives';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { PillButton } from '../src/components/ui/v3';
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
import { color as C, tabular, weight, type BadgeTone } from '../src/theme/tokens';
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

/**
 * The office refused it at sync. Its `status` never moves — it stays at
 * `submitted` — so the badge read "Sent" and the Edit button stayed live on an
 * order the office had never accepted, and an edit then queued behind a
 * create that would never land. The sync state is asked first.
 */
function notAccepted(o: PunchedOrder): boolean {
  return o.syncState === 'rejected' || o.syncState === 'blocked';
}

function stateOf(o: PunchedOrder): { label: string; tone: BadgeTone } {
  if (notAccepted(o)) return { label: 'Not accepted', tone: 'danger' };
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
  const waiting = (rows ?? []).filter((o) => o.status === 'pending_approval' && !notAccepted(o)).length;

  return (
    <AppFrame
      title="Your orders"
      activeTab="more"
      showTitle={false}
      heroTop={
        <View>
          <Text accessibilityRole="header" numberOfLines={1} style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
            Your orders
          </Text>
          <Text
            numberOfLines={1}
            style={[{ fontSize: 12, lineHeight: 16, color: waiting ? C.warnInk : C.muted }, weight(waiting ? 700 : 400)]}>
            {waiting ? plural(waiting, 'order') + ' waiting for office' : 'No order waiting for office'}
          </Text>
        </View>
      }
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <PillButton
        label="New order"
        icon="add"
        variant="navy"
        height={56}
        onPress={() => router.push('/order?from=orders')}
      />

      {rows === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 16, paddingHorizontal: 6 }}>
          Loading…
        </T>
      ) : rows.length === 0 ? (
        <View style={{ marginTop: 10, backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 28 }}>
          <T style={[{ fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center' }, weight(700)]}>No orders yet.</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            Every order you take shows here, sent or not.
          </T>
        </View>
      ) : (
        <View style={{ marginTop: 10, gap: 10 }}>
          {rows.map((o, i) => {
            const state = stateOf(o);
            const on = open === o.id;
            const mine = lines[o.id];
            const refused = notAccepted(o);
            const noValue = o.valueUnavailable || o.netTotalPaise == null;

            return (
              <Stagger
                key={o.id}
                index={i}
                style={{
                  backgroundColor: C.surface,
                  borderRadius: 22,
                  borderWidth: refused ? 1 : 0,
                  borderColor: '#F3C9C5',
                  overflow: 'hidden',
                }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: on }}
                  accessibilityHint={on ? 'Hides the lines' : 'Shows the lines on this order'}
                  onPress={() => show(o.id)}
                  style={({ pressed }) => [{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: on ? 0 : 14 }, pressed && { opacity: 0.85 }]}>
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
                    <T numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
                      {o.customerName ?? 'Unknown customer'}
                    </T>
                    {/* An order is worth what was typed, and where nothing was
                        it says so rather than showing a confident ₹0 — there
                        are no prices in the product master to fall back on. */}
                    <T
                      style={[
                        { fontSize: noValue ? 14 : 17, lineHeight: 22, color: noValue ? C.faint : C.ink },
                        weight(noValue ? 700 : 800),
                        tabular,
                      ]}>
                      {noValue ? 'No value' : inrFromPaise(o.netTotalPaise as number)}
                    </T>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <T numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {[
                          dmy(isoDate(new Date(o.orderedAt))),
                          o.orderNumber,
                          o.deliveryDate ? 'for ' + dmy(o.deliveryDate) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </T>
                      {o.syncState === 'queued' ? (
                        <>
                          <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>·</T>
                          <Icon name="upload" size={13} color={C.warnInk} strokeWidth={2.2} />
                          <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>not sent yet</T>
                        </>
                      ) : null}
                    </View>
                    <Badge tone={state.tone} style={{ alignSelf: 'center' }}>
                      {state.label}
                    </Badge>
                    {/* `forward` turned, because there is no up/down glyph and
                        `ICONS[name] ?? ICONS.dots` would have drawn an ellipsis
                        without complaining about it. */}
                    <View style={{ transform: [{ rotate: on ? '-90deg' : '90deg' }] }}>
                      <Icon name="forward" size={16} color={C.faint} strokeWidth={2} />
                    </View>
                  </View>

                  {/* Why it was refused, on the row rather than a screen away.
                      He has to ring the customer about it either way. */}
                  {refused ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 8 }}>
                      {(o.syncMessage ?? 'The office did not accept this order.') + ' Open Not accepted to take it again.'}
                    </T>
                  ) : o.status === 'rejected' || o.status === 'cancelled' ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.danger, marginTop: 8 }}>
                      {o.cancelReason ?? o.syncMessage ?? 'No reason was given.'}
                    </T>
                  ) : null}

                  {/* A change he asked for after approval, followed to its
                      answer on the order itself rather than on a screen of its own. */}
                  {changes.get(o.id) ? <ChangeLine c={changes.get(o.id) as ChangeRequest} /> : null}
                </Pressable>

                {on ? (
                  <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.hairline, gap: 8 }}>
                    {mine == null ? (
                      <T s="caption">Loading…</T>
                    ) : mine.length === 0 ? (
                      <T s="caption">No products on this order.</T>
                    ) : (
                      mine.map((l) => (
                        <View key={l.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                          <SkuChip sku={l.sku} style={{ marginBottom: 0, marginTop: 1 }} />
                          <T style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: C.ink }}>{l.productName}</T>
                          {/* Cans are what he counted and what the customer
                              said. Litres come off the SKU's own packing and
                              are shown beside them, never instead. */}
                          <Text
                            accessibilityLabel={plural(l.cans, 'can') + (l.litres ? ' · ' + Math.round(l.litres) + ' L' : '')}
                            style={[{ fontSize: 13, lineHeight: 18, color: C.body }, weight(700), tabular]}>
                            {l.cans + (l.litres ? ' · ' + Math.round(l.litres) + ' L' : '')}
                          </Text>
                        </View>
                      ))
                    )}

                    {/* EDIT UNTIL ACCOUNTS DECIDE, ASK AFTER. Before approval
                        nothing has been promised against the order, so he
                        corrects it himself; once approved it is the office's
                        commitment and a change goes to accounts as a request.
                        Past dispatch neither — that is a phone call. */}
                    {refused ? (
                      <RowAction
                        label="Open Not accepted"
                        danger
                        onPress={() => router.push('/rejections?from=orders')}
                      />
                    ) : editableStatus(o.status) ? (
                      <RowAction
                        label="Edit this order"
                        icon="note"
                        onPress={() => router.push(`/order?edit=${o.id}&from=orders`)}
                      />
                    ) : o.status === 'approved' ? (
                      changes.get(o.id)?.status === 'pending' ? (
                        <T style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
                          A change is waiting for accounts. You can ask for another once they answer.
                        </T>
                      ) : (
                        <RowAction
                          label="Request a change"
                          icon="note"
                          onPress={() => router.push(`/order?change=${o.id}&from=orders`)}
                        />
                      )
                    ) : null}
                  </View>
                ) : null}
              </Stagger>
            );
          })}
        </View>
      )}
    </AppFrame>
  );
}

/** The 44 pill an opened order ends on: tinted, or red for a refused one. */
function RowAction({ label, icon, danger = false, onPress }: { label: string; icon?: IconName; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        marginTop: 2,
        height: 44,
        borderRadius: 22,
        backgroundColor: danger ? C.dangerBg : C.primaryTint,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: pressed ? 0.85 : 1,
      })}>
      {icon ? <Icon name={icon} size={16} color={danger ? C.danger : C.primaryDeep} strokeWidth={2} /> : null}
      <Text style={[{ fontSize: 14, color: danger ? C.danger : C.primaryDeep }, weight(700)]}>{label}</Text>
    </Pressable>
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
  return <T style={[{ fontSize: 12, lineHeight: 17, color: tone, marginTop: 8 }, weight(700)]}>{text}</T>;
}
