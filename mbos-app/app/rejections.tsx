import React from 'react';
import { View, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T, PrimaryButton, SecondaryButton, Badge } from '../src/components/ui/primitives';
import { color as C, radius, type, weight } from '../src/theme/tokens';
import { listRejections, retryItem, type QueueItem } from '../src/sync/queue';
import { syncNow } from '../src/sync/engine';
import { useStore } from '../src/state/store';
import { inrFromPaise } from '../src/lib/format';

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

/** The machine codes from the protocol, in words the salesman can act on. */
const WHAT_TO_DO: Record<string, string> = {
  credit_blocked: 'Accounts have stopped this customer. Ring them before promising anything else.',
  credit_exceeded: 'They are over their limit. Collect against the old bills, or ask your manager to approve it.',
  product_inactive: 'That product is no longer sold. Swap the line for the current grade and send it again.',
  price_changed: 'The rate changed after you wrote this. Check the new rate with the customer.',
  bill_settled: 'The back office had already received this. Nothing more to do — check with them.',
  outstanding_stale: 'The balance moved while you were offline. Open the customer and check before resending.',
  duplicate: 'This was already recorded. Nothing to send again.',
  validation: 'Something on this record was not accepted. Correct it and send it again.',
  not_permitted: 'This is not yours to record. Your manager can tell you who does it.',
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
 * The payload, read where a throw cannot take the screen with it.
 *
 * `JSON.parse(row.payload)` ran inline in the map — during the render pass —
 * and again on every press, so one malformed or truncated row took the whole
 * list down rather than degrading to a card that says less. A refusal he
 * cannot SEE is worse than one he cannot understand.
 */
function readPayload(raw: string): RefusedPayload {
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as RefusedPayload) : {};
  } catch {
    return {};
  }
}

export default function Rejections() {
  const back = useCameFrom('sync');
  const notify = useStore((s) => s.notify);
  /** Null until the read lands — "everything went through" is a definite claim
   *  and it was being made while the outbox was still being read. */
  const [rows, setRows] = React.useState<QueueItem[] | null>(null);
  /** Which row is being re-sent. Per row, like the deposit and bounce buttons
   *  on the collections screen. */
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [readFailed, setReadFailed] = React.useState(false);

  const load = React.useCallback(() => {
    setReadFailed(false);
    void listRejections()
      .then(setRows)
      /* An empty list here says "nothing was refused", which is the one thing a
         failed read must not say. */
      .catch(() => setReadFailed(true));
  }, []);

  useFocusEffect(load);

  const cards = React.useMemo(
    () => (rows ?? []).map((row) => ({ row, payload: readPayload(row.payload) })),
    [rows],
  );

  return (
    <AppFrame title="Not accepted" contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Not accepted</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        The office refused these. Nothing has been thrown away — correct what is wrong and send it again.
      </T>

      {rows === null ? (
        <Text style={[type.small, { color: C.muted, marginTop: 16 }]}>
          {readFailed ? 'Your outbox could not be read just now.' : 'Reading…'}
        </Text>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 32, alignItems: 'center' }}>
          {/* NARROWED, because "everything went through" claimed more than this
              screen can see. `listRejections` reads the handset's own outbox —
              records refused BEFORE they were stored. An order accounts decline
              after it synced never reaches this queue and never will, so a
              salesman whose order was turned down this morning was being told
              nothing he saved had been refused. */}
          <Text style={[{ fontSize: 16, color: C.ink }, weight(600)]}>Nothing stuck in your outbox</Text>
          <Text style={[type.small, { color: C.muted, marginTop: 4, textAlign: 'center' }]}>
            This is what was refused before it reached the office. An order the office turned down
            after it had gone is on Your orders, with the reason on the row.
          </Text>
        </Card>
      ) : null}

      <View style={{ gap: 12, marginTop: 16 }}>
        {cards.map(({ row, payload }) => {
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
            <Card key={row.id} style={{ borderLeftWidth: 3, borderLeftColor: C.danger }}>
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
                <Badge tone="danger">Refused</Badge>
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
                      : 'The office did not say why. Send it again, and ask your manager if it comes back.')}
                </Text>
              </View>

              {guidance ? <Text style={[type.caption, { marginTop: 10 }]}>{guidance}</Text> : null}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <SecondaryButton
                  label="Open the customer"
                  onPress={() => {
                    if (!payload.customerId) return notify('This record does not name a customer');
                    useStore.getState().set({ custId: payload.customerId });
                    router.push('/customer');
                  }}
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
                    label={retrying === row.id ? 'Sending…' : 'Send it again'}
                    disabled={retrying === row.id}
                    onPress={() => {
                      setRetrying(row.id);
                      void (async () => {
                        try {
                          await retryItem(row.id);
                          load();
                          notify('Queued again — it will go out when you have signal');
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
          );
        })}
      </View>
    </AppFrame>
  );
}

function label(entityType: string): string {
  const map: Record<string, string> = {
    order: 'Order',
    payment: 'Payment',
    visit: 'Visit',
    expense: 'Expense claim',
    leave: 'Leave request',
    sample: 'Sample request',
    complaint: 'Complaint',
    task: 'Task',
    attendance: 'Attendance',
  };
  return map[entityType] ?? entityType;
}
