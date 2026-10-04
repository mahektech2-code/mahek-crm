import React from 'react';
import { View, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T, PrimaryButton, SecondaryButton, Badge } from '../src/components/ui/primitives';
import { color as C, radius, type, weight } from '../src/theme/tokens';
import { discardRefused, listRejections, retryItem, type QueueItem } from '../src/sync/queue';
import { entityLabel, readPayload as parsePayload } from '../src/sync/labels';
import { syncNow } from '../src/sync/engine';
import { useStore } from '../src/state/store';
import { inrFromPaise } from '../src/lib/format';
import { Stagger, animateLayoutFor } from '../src/components/ui/motion';

/**
 * Records the office refused.
 *
 * The design brief does not cover this screen and the implementation brief
 * says it needs one, for the reason that makes it matter: the salesman stood
 * in the shop and told the customer the order was placed. A record that
 * silently vanished, or that sat in a queue looking like it was still going,
 * would leave him finding out from the customer.
 *
 * So every refusal is here, with what the office said, and a way to send it
 * again once it has been corrected. Nothing on this screen deletes anything.
 */

/**
 * The machine codes from the protocol, in words the salesman can act on.
 *
 * Several used to end "fix it and send again" — and this screen had no way to
 * fix anything: "Send again" replays the very entry that was refused. They now
 * say what he can actually do here, which is take it again or let it go.
 */
const WHAT_TO_DO: Record<string, string> = {
  credit_blocked: 'Accounts have stopped this shop. Call accounts before you promise anything more.',
  credit_exceeded: 'This account is over its credit limit. Collect old bills first, or ask your manager to approve.',
  product_inactive: 'A product on this is not sold any more. Take the order again with the new product, then remove this one.',
  price_changed: 'The rate changed after you wrote this. Tell the shop the new rate, take the order again, then remove this one.',
  /* NOT "the office already got this payment". The office refused to apply
     the money to a bill somebody else had settled, and wrote NOTHING — so the
     cash was still "on you" and the office had no receipt, while this line
     told him there was nothing to do. */
  bill_settled:
    'The bill you picked was already paid, so this money was NOT recorded. Collect it again against an open bill or as advance, then remove this one.',
  outstanding_stale: 'The balance changed while you had no signal. Open the shop and check, then send again.',
  duplicate: 'This was already recorded. Nothing to send again — you can remove it.',
  /* Deliberately NOT the `validation` sentence below: there is nothing here for
     him to correct. The document he named has been taken out of the library
     since he pulled it, so the ways forward are a different document or the
     office publishing that one again — and "correct it and send it again" would
     send him looking for a mistake in an entry that was right when he made it. */
  not_found: 'This item is not in MahekOne any more. Pick another one, or ask the office to add it back.',
  validation: 'Something in this entry is wrong. Take it again with the right details, then remove this one.',
  not_permitted: 'You are not allowed to enter this. Ask your manager who does it.',
};

/** Only the fields this screen reads. Everything here is optional: the queue
 *  holds nine entity types and no two of them carry the same payload. */
type RefusedPayload = {
  customerId?: string;
  customerName?: string;
  /** An order. `saveOrder` sends this; it never sent `netTotalPaise`. */
  totalAmountPaise?: number;
  netTotalPaise?: number;
  /** A payment. */
  amountPaise?: number;
  valueUnavailable?: boolean;
};

/**
 * The payload, read where a throw cannot take the screen with it — one
 * malformed row degrades to a card that says less rather than taking the list
 * down. The parse itself is shared with the Sync screen.
 */
function readPayload(raw: string): RefusedPayload {
  return parsePayload<RefusedPayload>(raw);
}

export default function Rejections() {
  const back = useCameFrom('sync');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  /** Null until the read lands — "everything went through" is a definite claim
   *  and it was being made while the outbox was still being read. */
  const [rows, setRows] = React.useState<QueueItem[] | null>(null);
  /** Which row is being re-sent. Per row, like the deposit and bounce buttons
   *  on the collections screen. */
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [readFailed, setReadFailed] = React.useState(false);

  /* `animate` after a re-send, which is the one act here that takes a card
     away: the cards below close up over it rather than jumping, so it is
     plain which one left. */
  const load = React.useCallback((animate?: boolean) => {
    setReadFailed(false);
    void listRejections()
      .then((r) => {
        if (animate === true) animateLayoutFor(r.length);
        setRows(r);
      })
      /* An empty list here says "nothing was refused", which is the one thing a
         failed read must not say. */
      .catch(() => setReadFailed(true));
  }, []);

  useFocusEffect(React.useCallback(() => load(), [load]));

  const cards = React.useMemo(
    () => (rows ?? []).map((row) => ({ row, payload: readPayload(row.payload) })),
    [rows],
  );

  return (
    <AppFrame title="Not accepted" contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Not accepted</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        The office did not accept these. Each one says what to do. Nothing goes until you choose.
      </T>

      {rows === null ? (
        <Text style={[type.small, { color: C.muted, marginTop: 16 }]}>
          {readFailed ? 'Could not open this list. Try again in a minute.' : 'Reading…'}
        </Text>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 32, alignItems: 'center' }}>
          {/* NARROWED, because "everything went through" claimed more than this
              screen can see. `listRejections` reads the handset's own outbox —
              records refused BEFORE they were stored. An order accounts decline
              after it synced never reaches this queue and never will, so a
              salesman whose order was turned down this morning was being told
              nothing he saved had been refused. */}
          <Text style={[{ fontSize: 16, color: C.ink }, weight(600)]}>Nothing is stuck</Text>
          <Text style={[type.small, { color: C.muted, marginTop: 4, textAlign: 'center' }]}>
            This list shows entries the office did not accept when you sent them. If the office
            turned down an order later, see Your orders. The reason is on the order.
          </Text>
        </Card>
      ) : null}

      <View style={{ gap: 12, marginTop: 16 }}>
        {cards.map(({ row, payload }, i) => {
          /* An order's payload carries `totalAmountPaise`; a payment's carries
             `amountPaise`. Reading neither meant a refused PAYMENT showed its
             figure and a refused ORDER — the larger, more urgent half of this
             list — never showed one at all, on the screen he is using to decide
             which customer to ring first. An unvalued order sends 0, which is
             not a figure: it says so, exactly as the orders list does. */
          const value = payload.totalAmountPaise ?? payload.netTotalPaise ?? payload.amountPaise ?? null;
          const valueLine = payload.valueUnavailable
            ? 'Not valued'
            : value != null
              ? inrFromPaise(value)
              : null;
          const said = row.failureReason?.trim() || null;
          const guidance = row.failureCode ? WHAT_TO_DO[row.failureCode] ?? null : null;

          return (
            <Stagger key={row.id} index={i}>
              <Card style={{ borderLeftWidth: 3, borderLeftColor: C.danger }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
                      {label(row.entityType)}
                      {payload.customerName ? ` · ${payload.customerName}` : ''}
                    </Text>
                    {valueLine ? (
                      <Text style={[type.caption, { marginTop: 2 }]}>{valueLine}</Text>
                    ) : null}
                  </View>
                  <Badge tone="danger">Not accepted</Badge>
                </View>

                {/* What the office actually said, verbatim — and where it said
                    nothing, a sentence rather than an empty red rectangle.
                    `failureReason` is nullable, so a refusal with no reason and no
                    recognised code drew a "Refused" badge, a blank coloured box
                    and two buttons: no explanation of any kind, on the screen
                    whose whole promise is what the office said and what to do. */}
                <View style={{ backgroundColor: C.dangerBg, borderRadius: radius.md, padding: 12, marginTop: 12 }}>
                  <Text style={[type.small, { color: C.ink }]}>
                    {said ??
                      (guidance
                        ? 'The office did not say why.'
                        : 'The office did not say why. Send it again. If it comes back, ask your manager.')}
                  </Text>
                </View>

                {guidance ? <Text style={[type.caption, { marginTop: 10 }]}>{guidance}</Text> : null}

                {/* TAKE IT AGAIN, for the two entries a salesman most needs
                    to: an order and a payment. Sending the refused one again
                    replays exactly what was refused; this opens the form for
                    the same shop and lets the refused entry go, so it is not
                    counted twice on his phone. */}
                {retake(row) ? (
                  <PrimaryButton
                    label={retake(row)!.label}
                    onPress={() =>
                      askConfirm({
                        title: retake(row)!.label + '?',
                        body: retake(row)!.body,
                        confirmLabel: 'Yes, ' + retake(row)!.label.toLowerCase(),
                        run: () => {
                          void (async () => {
                            await discardRefused(row.id);
                            if (payload.customerId) useStore.getState().set({ custId: payload.customerId });
                            load(true);
                            router.push(retake(row)!.route);
                          })();
                        },
                      })
                    }
                    style={{ marginTop: 14 }}
                  />
                ) : null}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <SecondaryButton
                    label="Open the shop"
                    onPress={() => {
                      if (!payload.customerId) return notify('This entry is not for a shop.', 'error');
                      useStore.getState().set({ custId: payload.customerId });
                      router.push('/customer');
                    }}
                    style={{ flex: 1 }}
                  />
                  <SecondaryButton
                    label="Remove"
                    onPress={() =>
                      askConfirm({
                        title: 'Remove this from your phone?',
                        body:
                          row.op === 'create'
                            ? 'The office never got it, and it will be gone from this phone too. Take it again first if it still matters.'
                            : 'The office keeps what it already has. Your change that it refused is let go.',
                        confirmLabel: 'Yes, remove it',
                        run: () => {
                          void discardRefused(row.id).then(() => {
                            load(true);
                            notify('Removed from this phone', 'info');
                          });
                        },
                      })
                    }
                    style={{ flex: 1 }}
                  />
                  {/* Duplicates cannot be usefully resent — the office already has it. */}
                  {row.failureCode !== 'duplicate' ? (
                    /* The label carries the lock. With no signal — which is the
                       ordinary condition on this screen — the card stayed
                       identical until `load()` resolved, so nothing appeared to
                       happen and he tapped it several times, each tap firing a
                       fresh manual sync. */
                    <PrimaryButton
                      label={retrying === row.id ? 'Sending…' : 'Send again'}
                      disabled={retrying === row.id}
                      onPress={() => {
                        setRetrying(row.id);
                        void (async () => {
                          try {
                            await retryItem(row.id);
                            load(true);
                            notify('Waiting to send. It will go when you have signal.', 'info');
                            void syncNow({ manual: true });
                          } finally {
                            setRetrying(null);
                          }
                        })();
                      }}
                      style={{ flex: 1 }}
                    />
                  ) : null}
                </View>
              </Card>
            </Stagger>
          );
        })}
      </View>
    </AppFrame>
  );
}

function label(entityType: string): string {
  return entityLabel(entityType);
}

/** Where taking a refused entry again leads, where there is somewhere. */
function retake(row: QueueItem): { label: string; body: string; route: string } | null {
  if (row.op !== 'create') return null;
  if (row.entityType === 'payment') {
    return {
      label: 'Collect it again',
      body: 'Opens a new payment for the same shop. This refused one is removed from your phone.',
      route: '/pay?from=rejections',
    };
  }
  if (row.entityType === 'order') {
    return {
      label: 'Take the order again',
      body: 'Opens a new order for the same shop. This refused one is removed from your phone.',
      route: '/order?from=rejections',
    };
  }
  return null;
}
