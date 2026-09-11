import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import type { UpdateVerdict } from '../src/engines/app-update';
import { checkForUpdate, openDownload } from '../src/native/update-check';
import { stalledAt as trackerStalledAt } from '../src/sync/trail';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import { isoDate, plural, pretty } from '../src/lib/format';
import { conflictCount, listQueue, queueCounts, queueDepth, retryItem, type QueueItem } from '../src/sync/queue';
import { mediaCounts, retryFailedMedia } from '../src/sync/media';
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
 * "Send now" waits on the pass only far enough to say what came of it, and the
 * screen is never blocked on the network while it does — one button goes quiet
 * and everything else stays live. That much is worth waiting for: this is the
 * screen somebody opens BECAUSE he thinks his work is stuck, and a toast fired
 * before the call could only ever repeat what he already hoped.
 */

/**
 * What state a row is in, in a word.
 *
 * `markFailure` puts an item back as `queued` for the first five attempts, so
 * everything that had tried and failed read "Waiting" — exactly like a record
 * saved a second ago. An order that has been refused by the tower five times
 * and one taken thirty seconds ago are the same badge, and the difference
 * between them is the whole reason somebody opens this screen.
 */
function stateLabel(q: QueueItem): string {
  return q.state === 'failed'
    ? 'Failed'
    : q.state === 'syncing'
      ? 'Sending'
      : q.state === 'rejected'
        ? 'Refused'
        : q.state === 'blocked'
          ? 'Held back'
          : q.attempts > 0
            ? 'Retrying'
            : 'Waiting';
}

/**
 * WHY IT IS STUCK, which nothing on this screen used to say.
 *
 * `failureReason` is written on every failure, every block and every refusal —
 * the tower's own words, the office's refusal, and for a held-back item the
 * sentence that names the real problem: a record it depends on did not go
 * through. All of it was in the table and read by nobody, so a salesman pressed
 * Retry on a payment for ever rather than being sent to the visit behind it.
 * The attempt count rides with it, because "tried 5 times" and "tried once" are
 * a different afternoon.
 */
function whyStuck(q: QueueItem): string | null {
  const tries = q.attempts > 0 ? 'Tried ' + plural(q.attempts, 'time') : null;
  const parts = [tries, q.failureReason].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
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
  /* Whether this phone has been CAUGHT killing the tracker, rather than
     merely never set up — see `stalledAt`. The two read very differently and
     only one of them is urgent. */
  const [stalled, setStalled] = React.useState<number | null>(null);
  /* Whether a newer APK has been published. Sideloading has no auto-update,
     so being told is the only way a handset ever finds out — see
     `engines/app-update.ts`. */
  const [update, setUpdate] = React.useState<UpdateVerdict>({ kind: 'current' });
  const [conflicts, setConflicts] = React.useState(0);
  /* A pass is in flight. The button used to stay live throughout, so he could
     fire it six times and be told six times that everything was sending. */
  const [sending, setSending] = React.useState(false);
  /* Read once rather than during render — the clock is impure, and every row
     on the list is compared against this one value. */
  const [today] = React.useState(() => isoDate(new Date()));

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([
      listQueue(),
      queueCounts(),
      mediaCounts(),
      conflictCount(),
      queueDepth(),
      trackerStalledAt(),
    ]).then(([q, c, m, k, d, s]) => {
      if (!live) return;
      setRows(q);
      setCounts(c);
      setMedia(m);
      setConflicts(k);
      setDepth(d);
      setStalled(s);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  /**
   * SEND, AND THEN SAY WHAT CAME OF IT.
   *
   * The toast used to be raised BEFORE the call and `SyncOutcome.reason` thrown
   * on the floor — so "Sending everything now" appeared with no signal at all,
   * and again while a pass was already running, and again on the sixth press.
   * This is the one screen a salesman opens BECAUSE he suspects his work is
   * stuck, and it answered a real question with a reassurance: he walked away
   * believing the day had gone up.
   *
   * `syncNow` has always answered why it did not run. It simply had nowhere to
   * be read.
   */
  /* Asked once a screen opens and never awaited by anything — a handset on 2G
     must not wait on an update check to draw the queue. A failed check answers
     `current`, which draws nothing. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void checkForUpdate().then((v) => {
        if (live) setUpdate(v);
      });
      return () => {
        live = false;
      };
    }, []),
  );

  const sendNow = React.useCallback(async () => {
    setSending(true);
    try {
      const outcome = await syncNow({ manual: true });
      load();
      notify(
        !outcome.ran
          ? (outcome.reason ?? 'Nothing could be sent just now')
          : outcome.pushed === 0
            ? 'Nothing was waiting to go up'
            : outcome.accepted > 0
              ? plural(outcome.accepted, 'record') + ' sent'
              : outcome.rejected > 0
                ? plural(outcome.rejected, 'record') + ' the office would not accept'
                : (outcome.reason ?? 'Nothing went up — your work is still safe on this phone'),
      );
    } finally {
      setSending(false);
    }
  }, [load, notify]);

  /* The headline counts the QUEUE, not the rows drawn — `listQueue` caps at
     fifty, so a hundred and twenty waiting items said "50 things waiting"
     directly above a caption reading "of 120 waiting". `depth` and the status
     strip's own `pendingCount` are now one predicate, so all three agree. */
  const waiting = depth + media.pending + media.failed;
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
          label={sending ? 'Sending…' : 'Send now'}
          disabled={sending}
          onPress={() => void sendNow()}
          style={{ marginTop: 14, borderRadius: radius.xl }}
        />
      </Card>

      {media.pending > 0 ? (
        <T s="caption" style={{ marginTop: 10 }}>
          {/* The plural form is given rather than derived: appending an `s` to
              the whole phrase reads "2 photo or recordings". */}
          {plural(media.pending, 'photo or recording', 'photos and recordings') +
            ' uploading separately — records always go first.'}
        </T>
      ) : null}

      {/* A PHOTOGRAPH THAT GAVE UP IS NOT ONE STILL UPLOADING.
          Both halves were added together under the word "uploading", and
          `failed` was terminal — nothing in the app moved a media row back, so
          the sentence was describing a file that was never going anywhere
          again. It matters most for the one file that IS the record: an
          attendance selfie is the only evidence that whoever marked the day
          worked it, and a cheque photograph is what accounts match a receipt
          against. Neither can be taken a second time tomorrow. */}
      {media.failed > 0 ? (
        <View
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
            <T style={[{ fontSize: 15, color: C.danger }, weight(600)]}>Could not be sent</T>
            <T s="caption" style={{ color: C.danger }}>
              {plural(media.failed, 'photo or recording', 'photos and recordings') +
                ' gave up — they are still on this phone.'}
            </T>
          </View>
          <Pressable
            onPress={() => {
              void retryFailedMedia().then((n) => {
                load();
                notify(
                  n === 0
                    ? 'Nothing left to try again'
                    : plural(n, 'photo or recording', 'photos and recordings') + ' back in the queue',
                );
                /* Media rides out on the back of a pass — see the `finally` in
                   `syncNow`. Queuing them and never asking for one would leave
                   him pressing a button that changed a column and nothing else. */
                void syncNow({ manual: true }).then(load);
              });
            }}
            accessibilityRole="button"
            style={{
              height: 48,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderColor: C.danger,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <T style={{ fontSize: 15, color: C.danger }}>Retry</T>
          </Pressable>
        </View>
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
            {/* "records" rather than a bare count: photographs are counted in
                the headline above and called out in their own line, and a
                second unqualified number on one screen is how this screen came
                to disagree with itself three ways in the first place. */}
            {`Showing the ${rows.length} most urgent of ${plural(depth, 'record')} waiting.`}
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
              {/* Coloured to match the badge beside it — an item still
                  retrying is amber, not red. */}
              {whyStuck(q) ? (
                <T s="caption" style={{ color: stateTone(q.state) === 'danger' ? C.danger : C.warnInk, marginTop: 2 }}>
                  {whyStuck(q)}
                </T>
              ) : null}
            </View>
            <Badge tone={stateTone(q.state)}>{stateLabel(q)}</Badge>
            {q.state === 'failed' || q.state === 'blocked' ? (
              <Pressable
                onPress={async () => {
                  await retryItem(q.id);
                  load();
                  /* The local half is true whatever the radio is doing — the
                     item is back in the queue. What the pass itself managed is
                     the half that used to be discarded. */
                  await sendNow();
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

      {/* A NEWER BUILD EXISTS AND THIS PHONE CANNOT FETCH IT ITSELF.
      
          Android refuses an unattended install without device-owner enrolment
          nobody here has, so the honest most this can do is say so and hand
          the file to the browser. That is still the difference between one tap
          and a fortnight: the field ran 1.0.0 and 1.1.0 while 1.4.0 had been
          published for hours, and three bugs were diagnosed against builds
          that did not contain their own fixes. */}
      {update.kind === 'available' ? (
        <Pressable
          onPress={() => void openDownload(update.url)}
          accessibilityRole="button"
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: C.primary,
            backgroundColor: C.primaryTint,
          }}>
          <T style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>
            {'Update to ' + update.version}
          </T>
          <T style={{ fontSize: 13, lineHeight: 19, color: C.body, marginTop: 4 }}>
            A newer MahekOne has been released. Tap to download it, then open the file to install —
            nothing on this phone is lost and you stay signed in.
          </T>
        </Pressable>
      ) : null}

      {/* WHY A DAY GOES QUIET, and the two switches that decide it.
          
          Everything else on this screen is about work that is waiting to go
          up. This one is about the handset being allowed to record at all —
          which is upstream of all of it, and is the commonest reason a trail
          has a two-hour hole in it with every permission reading granted. */}
      <Pressable
        onPress={() => router.push('/tracking-setup?from=sync')}
        accessibilityRole="button"
        style={{
          marginTop: 14,
          padding: 16,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: stalled ? C.danger : C.border,
          backgroundColor: C.surface,
        }}>
        <T style={[{ fontSize: 15, color: stalled ? C.danger : C.ink }, weight(600)]}>
          {stalled ? 'Your phone stopped the tracker' : 'Keep tracking on'}
        </T>
        <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 4 }}>
          {stalled
            ? 'Your route stopped being recorded while the app was in your pocket. Two settings stop it happening again.'
            : 'If your route has holes in it, your phone is stopping MahekOne to save battery. Two settings fix it.'}
        </T>
      </Pressable>

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
