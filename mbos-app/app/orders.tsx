import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Input, T } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { SheetActions } from '../src/components/ui/v3';
import { useStore } from '../src/state/store';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { PillButton } from '../src/components/ui/v3';
import { SkuChip } from '../src/components/ui/sku';
import {
  cancelTo,
  editableStatus,
  journeyStepsOf,
  latestChangeRequests,
  listOrders,
  orderLines,
  orderTitle,
  type JourneyStep,
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

/* The office's tone words onto the phone's badges. */
const JOURNEY_TONE: Record<string, BadgeTone> = { info: 'info', good: 'success', warn: 'amber', bad: 'danger', muted: 'neutral' };

/**
 * WHETHER HE MAY STILL CHANGE IT. Where the office has described the order,
 * its answer wins: only a TO that is open or sent back can be changed, and
 * one with its order number never can. Older orders are read the old way.
 */
function canEdit(o: PunchedOrder): boolean {
  if (o.journeyEditable != null) return o.journeyEditable === 1;
  return editableStatus(o.status);
}

/*
 * THE SHORT WORD FOR WHERE IT IS, from the office's code (Option A): a TO
 * waits for Accounts, may be a possible duplicate, is sent back, held or
 * declined; approving makes the order number. An office one release behind
 * sends no code and its sentence is drawn as it was.
 */
const STATE_PILL: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: 'Waiting for Accounts', tone: 'amber' },
  possible_duplicate: { label: 'Possible duplicate', tone: 'amber' },
  correction: { label: 'Sent back', tone: 'info' },
  hold: { label: 'On hold', tone: 'danger' },
  declined: { label: 'Declined', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  delivered: { label: 'Delivered', tone: 'success' },
};

function stateOf(o: PunchedOrder): { label: string; tone: BadgeTone } {
  if (notAccepted(o)) return { label: 'Not accepted', tone: 'danger' };
  if (o.journeyState && STATE_PILL[o.journeyState]) return STATE_PILL[o.journeyState];
  if (o.journeyState === 'approved' && o.journeyStatus) {
    return o.journeyStatus.startsWith('Approved')
      ? { label: 'Approved', tone: 'success' }
      : { label: o.journeyStatus, tone: JOURNEY_TONE[o.journeyTone ?? ''] ?? 'neutral' };
  }
  if (o.journeyStatus) return { label: o.journeyStatus, tone: JOURNEY_TONE[o.journeyTone ?? ''] ?? 'neutral' };
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
  const [cancelling, setCancelling] = React.useState<PunchedOrder | null>(null);
  const [cancelReason, setCancelReason] = React.useState('');
  const [cancelBusy, setCancelBusy] = React.useState(false);
  const notify = useStore((s) => s.notify);

  const confirmCancel = async () => {
    if (!cancelling) return;
    if (!cancelReason.trim()) return notify('Say why it is cancelled.', 'error');
    setCancelBusy(true);
    try {
      const r = await cancelTo(cancelling.id, cancelReason);
      if (!r.ok) return notify(r.message, 'error');
      notify((orderTitle(cancelling) ?? 'The order') + ' cancelled · syncs when you have signal');
      setCancelling(null);
      load();
    } finally {
      setCancelBusy(false);
    }
  };

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
      tone="canvas"
      title="Your orders"
      activeTab="more"
      showTitle={false}
      heroTop={
        <View>
          <Text accessibilityRole="header" numberOfLines={1} style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
            My orders
          </Text>
          <Text numberOfLines={2} style={{ marginTop: 4, fontSize: 12, lineHeight: 16, color: C.muted }}>
            You can change an order until Accounts approve it.
          </Text>
          {waiting ? (
            <Text numberOfLines={1} style={[{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.warnInk }, weight(700)]}>
              {plural(waiting, 'order') + ' waiting for Accounts'}
            </Text>
          ) : null}
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
                          orderTitle(o) ?? o.orderNumber,
                          o.erpOrderNo != null && o.toNo != null ? 'was TO-' + o.toNo : null,
                          o.deliveryDate ? 'for ' + dmy(o.deliveryDate) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </T>
                      {o.syncState === 'queued' ? (
                        <>
                          <T style={{ flexShrink: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>·</T>
                          <Icon name="upload" size={13} color={C.warnInk} strokeWidth={2.2} />
                          <T style={{ flexShrink: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>not sent yet</T>
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

                  {/* ACCOUNTS' OWN WORDS where they sent it back, held or
                      declined it; the duplicate question in the office's
                      sentence. Anything else held up says the office's banner. */}
                  {refused ? null : (o.journeyState === 'correction' || o.journeyState === 'declined' || o.journeyState === 'hold') && o.journeyReason ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.body, marginTop: 8 }}>{'"' + o.journeyReason + '"'}</T>
                  ) : o.journeyState === 'possible_duplicate' ? (
                    <T style={{ fontSize: 12.5, lineHeight: 18, color: C.muted, marginTop: 8 }}>
                      {o.journeyBanner ?? 'Matches TO-' + (o.duplicateOfToNo ?? '') + '; Accounts will check it.'}
                    </T>
                  ) : o.journeyBanner && o.journeyState !== 'correction' && o.journeyState !== 'declined' ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.warnInk, marginTop: 8 }}>{o.journeyBanner}</T>
                  ) : null}

                  {/* WHAT HE MAY DO, on the card: change or cancel a TO until
                      Accounts approve it, correct and send one they sent
                      back; after approval it is the office's to change. */}
                  {!refused && o.journeyState && canEdit(o) ? (
                    o.journeyState === 'correction' ? (
                      <RowAction label="Correct and send" icon="note" onPress={() => router.push(`/order?edit=${o.id}&from=orders`)} />
                    ) : (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <View style={{ flex: 1 }}>
                          <RowAction label="Edit" icon="note" onPress={() => router.push(`/order?edit=${o.id}&from=orders`)} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <RowAction
                            label="Cancel TO"
                            onPress={() => {
                              setCancelReason('');
                              setCancelling(o);
                            }}
                          />
                        </View>
                      </View>
                    )
                  ) : !refused && o.journeyState === 'approved' ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                      <Icon name="lock" size={14} color={C.muted} strokeWidth={2} />
                      <T style={{ flexShrink: 1, fontSize: 12.5, lineHeight: 17, color: C.muted }}>Approved. Ask the office to change it.</T>
                    </View>
                  ) : null}

                  {/* A change he asked for after approval, followed to its
                      answer on the order itself rather than on a screen of its own. */}
                  {changes.get(o.id) ? <ChangeLine c={changes.get(o.id) as ChangeRequest} /> : null}
                </Pressable>

                {on ? (
                  <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.hairline, gap: 8 }}>
                    {journeyStepsOf(o).length ? <Ladder steps={journeyStepsOf(o)} /> : null}
                    <RowAction label="Open the order" icon="forward" onPress={() => router.push(`/order-detail?id=${o.id}`)} />
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
                    ) : o.journeyState ? null : canEdit(o) ? (
                      <RowAction
                        label="Edit this order"
                        icon="note"
                        onPress={() => router.push(`/order?edit=${o.id}&from=orders`)}
                      />
                    ) : o.erpOrderNo != null ? (
                      /* THE ORDER HUB: once it has its order number it is not
                         changed and not asked about; the office cancels it and
                         a new one is taken. */
                      <T style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>
                        This order has its order number, so it can no longer be changed. To change it, ask the office to cancel it and take a new one.
                      </T>
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

      <BottomSheet open={!!cancelling} onClose={() => (cancelBusy ? undefined : setCancelling(null))}>
        <View style={{ gap: 10 }}>
          <T style={[{ fontSize: 18, lineHeight: 24, color: C.ink }, weight(700)]}>
            {'Cancel ' + (cancelling ? (orderTitle(cancelling) ?? 'this order') : '')}
          </T>
          <T style={[{ fontSize: 12.5, lineHeight: 17, color: C.muted }, weight(500)]}>Why is it cancelled?</T>
          <Input value={cancelReason} onChangeText={setCancelReason} placeholder="Reason" accessibilityLabel="Why is it cancelled?" />
          <SheetActions cancelLabel="Keep it" label="Cancel the TO" busy={cancelBusy} onCancel={() => setCancelling(null)} onPress={() => void confirmCancel()} />
        </View>
      </BottomSheet>
    </AppFrame>
  );
}

/* Where the order is, rung by rung: the ladder the office worked out. */
const STEP_DOT: Record<JourneyStep['state'], string> = { done: C.success, current: C.primary, hold: C.danger, todo: C.hairline };

function Ladder({ steps }: { steps: JourneyStep[] }) {
  return (
    <View style={{ gap: 2, paddingBottom: 6, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: C.hairline }}>
      {steps.map((st) => (
        <View key={st.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, marginTop: 3, backgroundColor: STEP_DOT[st.state] }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 13, lineHeight: 18, color: st.state === 'todo' ? C.faint : C.ink }, weight(st.state === 'current' || st.state === 'hold' ? 700 : 400)]}>
              {st.label}
            </T>
            {st.at || st.note ? (
              <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                {[st.at ? dmy(isoDate(new Date(st.at))) : null, st.note].filter(Boolean).join(' · ')}
              </T>
            ) : null}
          </View>
        </View>
      ))}
    </View>
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
        minHeight: 44,
        paddingVertical: 6,
        borderRadius: 22,
        backgroundColor: danger ? C.dangerBg : C.primaryTint,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: pressed ? 0.85 : 1,
      })}>
      {icon ? <Icon name={icon} size={16} color={danger ? C.danger : C.primaryDeep} strokeWidth={2} /> : null}
      <Text style={[{ flexShrink: 1, fontSize: 14, lineHeight: 20, color: danger ? C.danger : C.primaryDeep }, weight(700)]}>{label}</Text>
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
