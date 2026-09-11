import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import { isoDate, plural, pretty } from '../src/lib/format';
import { conflictCount, listQueue, queueCounts, queueDepth, retryItem, type QueueItem } from '../src/sync/queue';
import { mediaCounts } from '../src/sync/media';
import { syncNow } from '../src/sync/engine';
import { useStore } from '../src/state/store';
import { runningBuild } from '../src/native/updates';

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

/**
 * `09:14` for something saved today, `9 Sep 09:14` for anything older.
 *
 * A time on its own made every row read as this morning — and the case this
 * screen exists for is precisely the one where that is wrong: a week offline,
 * or a queue that has stopped draining, where every row is from a different day
 * and all of them printed the same shape. Telling an order taken twenty minutes
 * ago from one stuck since Tuesday is the whole signal that something is wrong
 * rather than merely slow.
 */
function when(ms: number, today: string): string {
  const d = new Date(ms);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const day = isoDate(d);
  return day === today ? hm : pretty(day) + ' ' + hm;
}

export default function SyncScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  const [rows, setRows] = React.useState<QueueItem[]>([]);

  const [depth, setDepth] = React.useState(0);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [media, setMedia] = React.useState({ pending: 0, failed: 0 });
  const [conflicts, setConflicts] = React.useState(0);
  /* Read once rather than during render — the clock is impure, and every row
     on the list is compared against this one value. */
  const [today] = React.useState(() => isoDate(new Date()));

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listQueue(), queueCounts(), mediaCounts(), conflictCount(), queueDepth()]).then(([q, c, m, k, d]) => {
      if (!live) return;
      setRows(q);
      setCounts(c);
      setMedia(m);
      setConflicts(k);
      setDepth(d);
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
          {/* The plural form is given rather than derived: appending an `s` to
              the whole phrase reads "2 photo or recordings". */}
          {plural(media.pending + media.failed, 'photo or recording', 'photos and recordings') +
            ' uploading separately — records always go first.'}
        </T>
      ) : null}

      {/* An empty outbox drew an empty card: a bordered, rounded, shadowed slab
          two points tall sitting directly under the sentence saying everything
          has gone up, which reads as a row that failed to draw. `listQueue` and
          `queueDepth` ask the same question, so no rows means no depth and the
          caption below cannot be lost with it. */}
      {rows.length > 0 ? (
      <ListCard style={{ marginTop: 12 }}>
        {depth > rows.length ? (
          <T s="caption" style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            {`Showing the ${rows.length} most urgent of ${depth} waiting.`}
          </T>
        ) : null}
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
              <T s="caption">{describe(q) + ' · ' + when(q.createdAt, today)}</T>
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
      ) : null}

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
      {/* WHICH BUILD THIS IS. Without it, "the fix is not on my phone" and
          "the fix does not work" look identical from the office — which is
          exactly the hour that was lost to an APK that had been built and
          never published. `embedded` means it is running the bundle that came
          with the install; anything else is an update it has picked up. */}
      <T s="caption" style={{ textAlign: 'center', marginTop: 20 }}>
        {(() => {
          const b = runningBuild();
          return b.embedded
            ? 'Running the build that was installed'
            : `Running update ${b.id.slice(0, 8)}${b.channel ? ' · ' + b.channel : ''}`;
        })()}
      </T>
    </AppFrame>
  );
}
