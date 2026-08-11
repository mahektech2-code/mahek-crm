import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import { plural } from '../src/lib/format';
import { conflictCount, listQueue, queueCounts, retryItem, type QueueItem } from '../src/sync/queue';
import { mediaCounts } from '../src/sync/media';
import { syncNow } from '../src/sync/engine';
import { useStore } from '../src/state/store';

/**
 * The outbox.
 *
 * Nothing here is a failure of the app — it is a phone in a market with no
 * signal, which is the ordinary condition. What matters is that the salesman
 * can see his work is still on the phone rather than lost, and that the one
 * record somebody else overwrote is stated plainly rather than silently
 * dropped.
 *
 * "Send now" fires a sync and returns. It does not wait for it: a screen that
 * blocked on the network to show a queue would be the one thing in this app
 * that does.
 */

function stateLabel(s: string): string {
  return s === 'failed'
    ? 'Failed'
    : s === 'syncing'
      ? 'Sending'
      : s === 'rejected'
        ? 'Refused'
        : s === 'blocked'
          ? 'Held back'
          : 'Waiting';
}

function stateTone(s: string): BadgeTone {
  return s === 'failed' || s === 'rejected' ? 'danger' : s === 'syncing' ? 'info' : 'amber';
}

/** What a queued record is, in the words the salesman would use for it. */
const KIND: Record<string, string> = {
  visit: 'Visit',
  order: 'Order',
  payment: 'Payment',
  attendance: 'Attendance',
  task: 'Task',
  sample: 'Sample',
  complaint: 'Complaint',
  expense: 'Expense',
  leave: 'Leave',
  lead: 'Lead',
  approval: 'Approval',
  competitor: 'Competitor note',
};

function describe(item: QueueItem): string {
  const p = JSON.parse(item.payload) as { customerName?: string; title?: string; reason?: string };
  return p.customerName ?? p.title ?? p.reason ?? item.entityId.slice(-6).toUpperCase();
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export default function SyncScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  const [rows, setRows] = React.useState<QueueItem[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [media, setMedia] = React.useState({ pending: 0, failed: 0 });
  const [conflicts, setConflicts] = React.useState(0);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listQueue(), queueCounts(), mediaCounts(), conflictCount()]).then(([q, c, m, k]) => {
      if (!live) return;
      setRows(q);
      setCounts(c);
      setMedia(m);
      setConflicts(k);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const waiting = rows.length + media.pending + media.failed;
  const rejected = counts.rejected ?? 0;

  return (
    <AppFrame title="Waiting to send" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
          {waiting ? plural(waiting, 'thing') + ' waiting' : 'Everything has gone up'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 4 }}>
          Everything you save works offline. It goes out on its own when you have signal.
        </T>
        <PrimaryButton
          label="Send now"
          onPress={() => {
            /* Fired, not awaited. The queue on screen refreshes when it lands. */
            void syncNow({ manual: true }).then(load);
            notify('Sending everything now');
          }}
          style={{ marginTop: 14, borderRadius: radius.xl }}
        />
      </Card>

      {media.pending + media.failed > 0 ? (
        <T s="caption" style={{ marginTop: 10 }}>
          {plural(media.pending + media.failed, 'photo or recording') +
            ' uploading separately — records always go first.'}
        </T>
      ) : null}

      <ListCard style={{ marginTop: 12 }}>
        {rows.map((q, i) => (
          <View
            key={q.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
            }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 15, color: C.ink }}>{KIND[q.entityType] ?? q.entityType}</T>
              <T s="caption">{describe(q) + ' · ' + hhmm(q.createdAt)}</T>
            </View>
            <Badge tone={stateTone(q.state)}>{stateLabel(q.state)}</Badge>
            {q.state === 'failed' || q.state === 'blocked' ? (
              <Pressable
                onPress={async () => {
                  await retryItem(q.id);
                  load();
                  notify('Trying again');
                  void syncNow({ manual: true }).then(load);
                }}
                accessibilityRole="button"
                style={{
                  height: 48,
                  paddingHorizontal: 12,
                  borderWidth: 1,
                  borderColor: C.border,
                  backgroundColor: C.surface,
                  borderRadius: radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <T style={{ fontSize: 15, color: C.body }}>Retry</T>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ListCard>

      {/* A refusal is not a queue item to retry blindly — it goes to the screen
          that says what the office objected to and how to correct it. */}
      {rejected > 0 ? (
        <Pressable
          onPress={() => router.push('/rejections?from=sync')}
          accessibilityRole="button"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 56,
            paddingHorizontal: 16,
            marginTop: 12,
            borderWidth: 1,
            borderColor: C.dangerBg,
            backgroundColor: C.dangerBg,
            borderRadius: radius.card,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, color: C.danger }, weight(600)]}>Not accepted</T>
            <T s="caption" style={{ color: C.danger }}>
              {plural(rejected, 'record') + ' the office refused — nothing has been thrown away.'}
            </T>
          </View>
          <Icon name="forward" size={20} color={C.danger} strokeWidth={1.5} />
        </Pressable>
      ) : null}

      {conflicts > 0 ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: C.warnEdge,
            backgroundColor: C.warnBg,
            borderRadius: radius.card,
            padding: 16,
            marginTop: 12,
          }}>
          <T
            style={[
              { fontSize: 12, lineHeight: 16, letterSpacing: 0.48, textTransform: 'uppercase', color: C.warnInk },
              weight(500),
            ]}>
            One thing changed under you
          </T>
          <T s="small" style={{ color: C.ink, marginTop: 6 }}>
            Your edit was replaced by a newer one from the desk team. Your manager can see both.
          </T>
        </View>
      ) : null}
    </AppFrame>
  );
}
