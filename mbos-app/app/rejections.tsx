import React from 'react';
import { View, Text } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T, PrimaryButton, SecondaryButton, Badge } from '../src/components/ui/primitives';
import { color as C, radius, type, weight } from '../src/theme/tokens';
import { listRejections, retryItem, type QueueItem } from '../src/sync/queue';
import { syncNow } from '../src/sync/engine';
import { useStore } from '../src/state/store';
import { inr } from '../src/lib/format';

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

export default function Rejections() {
  const back = useCameFrom('sync');
  const notify = useStore((s) => s.notify);
  const [rows, setRows] = React.useState<QueueItem[]>([]);

  const load = React.useCallback(() => {
    void listRejections().then(setRows);
  }, []);

  useFocusEffect(load);

  return (
    <AppFrame title="Not accepted" contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Not accepted</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        The office refused these. Nothing has been thrown away — correct what is wrong and send it again.
      </T>

      {rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 32, alignItems: 'center' }}>
          <Text style={[{ fontSize: 16, color: C.ink }, weight(600)]}>Everything went through</Text>
          <Text style={[type.small, { color: C.muted, marginTop: 4, textAlign: 'center' }]}>
            Nothing you have saved has been refused.
          </Text>
        </Card>
      ) : null}

      <View style={{ gap: 12, marginTop: 16 }}>
        {rows.map((row) => {
          const payload = JSON.parse(row.payload) as {
            customerName?: string;
            netTotalPaise?: number;
            amountPaise?: number;
          };
          const value = payload.netTotalPaise ?? payload.amountPaise ?? null;

          return (
            <Card key={row.id} style={{ borderLeftWidth: 3, borderLeftColor: C.danger }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
                    {label(row.entityType)}
                    {payload.customerName ? ` · ${payload.customerName}` : ''}
                  </Text>
                  {value != null ? (
                    <Text style={[type.caption, { marginTop: 2 }]}>{inr(value / 100)}</Text>
                  ) : null}
                </View>
                <Badge tone="danger">Refused</Badge>
              </View>

              {/* What the office actually said, verbatim. */}
              <View style={{ backgroundColor: C.dangerBg, borderRadius: radius.md, padding: 12, marginTop: 12 }}>
                <Text style={[type.small, { color: C.ink }]}>{row.failureReason}</Text>
              </View>

              {row.failureCode && WHAT_TO_DO[row.failureCode] ? (
                <Text style={[type.caption, { marginTop: 10 }]}>{WHAT_TO_DO[row.failureCode]}</Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <SecondaryButton
                  label="Open the customer"
                  onPress={() => {
                    const p = JSON.parse(row.payload) as { customerId?: string };
                    if (!p.customerId) return notify('This record does not name a customer');
                    useStore.getState().set({ custId: p.customerId });
                    router.push('/customer');
                  }}
                  style={{ flex: 1 }}
                />
                {/* Duplicates cannot be usefully resent — the office already has it. */}
                {row.failureCode !== 'duplicate' ? (
                  <PrimaryButton
                    label="Send it again"
                    onPress={async () => {
                      await retryItem(row.id);
                      load();
                      notify('Queued again — it will go out when you have signal');
                      void syncNow({ manual: true });
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
