import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { Icon } from '../src/components/ui/Icon';
import { Pop, Pulse, Stagger, animateLayoutFor } from '../src/components/ui/motion';
import type { UpdateVerdict } from '../src/engines/app-update';
import { checkForUpdate } from '../src/native/update-check';
import { backgroundStartFailure, stalledAt as trackerStalledAt } from '../src/sync/trail';
import { batteryExemption } from '../src/native/phone-setup';
import { trackerNotice, type StartFailure } from '../src/engines/tracker-notice';
import type { BatteryExemption } from '../src/engines/phone-readiness';
import { color as C, weight } from '../src/theme/tokens';
import { isoDate, plural, pretty } from '../src/lib/format';
import { listQueue, queueCounts, queueDepth, retryItem, type QueueItem } from '../src/sync/queue';
import { describePayload, entityLabel } from '../src/sync/labels';
import { pullProblems, type PullProblems } from '../src/sync/pull';
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
        ? 'Not accepted'
        : q.state === 'blocked'
          ? 'On hold'
          : q.attempts > 0
            ? 'Trying again'
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

function stateTone(s: string): 'danger' | 'info' | 'amber' {
  return s === 'failed' || s === 'rejected' ? 'danger' : s === 'syncing' ? 'info' : 'amber';
}

function describe(item: QueueItem): string {
  return describePayload(item.payload, item.entityId);
}

/**
 * WHAT A HELD ROW IS WAITING ON. "Try again" on it did nothing — the record it
 * depends on is still refused, so the next pass blocked it again at once. It
 * names that record instead, which is the one he can actually do something
 * about.
 */
function heldBehind(q: QueueItem, all: QueueItem[]): string | null {
  if (q.state !== 'blocked') return null;
  let deps: string[] = [];
  try {
    deps = JSON.parse(q.dependsOn) as string[];
  } catch {
    return null;
  }
  const parent = all.find((r) => deps.includes(r.entityId) && r.state !== 'blocked');
  return parent
    ? `Waiting on the ${entityLabel(parent.entityType).toLowerCase()} for ${describe(parent)}. Sort that one out first.`
    : null;
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
  const offerUpdate = useStore((s) => s.offerUpdate);

  const [rows, setRows] = React.useState<QueueItem[]>([]);

  const [depth, setDepth] = React.useState(0);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [media, setMedia] = React.useState({ pending: 0, failed: 0 });
  /* Whether this phone has been CAUGHT killing the tracker, rather than
     merely never set up — see `stalledAt`. The two read very differently and
     only one of them is urgent. */
  const [stalled, setStalled] = React.useState<number | null>(null);
  /* WHETHER THE BATTERY MANAGER WILL LET THE TRACKER RUN — the one answer
     Android actually gives about this, and the one this card was not reading.
     It printed a hypothetical on every handset, including the ones provably
     about to have the service killed. `unknown` until the phone answers, which
     is also what iOS and any ROM that refuses leave it at. */
  const [exemption, setExemption] = React.useState<BatteryExemption>('unknown');
  /* Why the real tracker is not running, where it is not. Four causes with
     four different cures, which `startBackground` used to answer with one
     `false` — see `engines/tracker-notice.ts`. */
  const [failure, setFailure] = React.useState<StartFailure | null>(null);
  /* Whether a newer APK has been published. Sideloading has no auto-update,
     so being told is the only way a handset ever finds out — see
     `engines/app-update.ts`. */
  const [update, setUpdate] = React.useState<UpdateVerdict>({ kind: 'current' });
  /* What the last pull could not save on this phone. See `applyPull`. */
  const [problems, setProblems] = React.useState<PullProblems | null>(null);
  /* A pass is in flight. The button used to stay live throughout, so he could
     fire it six times and be told six times that everything was sending. */
  const [sending, setSending] = React.useState(false);
  /* Read once rather than during render — the clock is impure, and every row
     on the list is compared against this one value. */
  const [today] = React.useState(() => isoDate(new Date()));

  const load = React.useCallback(() => {
    let live = true;
    /* In memory rather than in the database — it describes a registration this
       process made — so it is read here rather than during render, which the
       React Compiler rules would object to and which would be a different
       answer on every pass anyway. */
    setFailure(backgroundStartFailure()?.why ?? null);
    void Promise.all([
      listQueue(),
      queueCounts(),
      mediaCounts(),
      pullProblems().catch(() => null),
      queueDepth(),
      trackerStalledAt(),
      /* Read fresh on every focus rather than once: the whole shape of this
         feature is him walking out to Settings and coming back, and a card
         still warning about a battery saver he has just switched off is how
         somebody concludes the screen is wrong about his phone. */
      batteryExemption().catch<BatteryExemption>(() => 'unknown'),
    ]).then(([q, c, m, k, d, s, x]) => {
      if (!live) return;
      /* After a pass, the rows that went up leave and the rest close the gap —
         which is the screen SHOWING his work going, rather than a list that is
         simply shorter. `listQueue` caps at fifty, under the layout limit. */
      animateLayoutFor(q.length);
      setRows(q);
      setCounts(c);
      setMedia(m);
      setProblems(k);
      setDepth(d);
      setStalled(s);
      setExemption(x);
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
      const outcome = await syncNow({ manual: true }).catch((e: unknown) => ({
        ran: false,
        pushed: 0,
        accepted: 0,
        rejected: 0,
        failed: 0,
        pulled: 0,
        reason: e instanceof Error ? e.message : 'Could not send now. Try again in a minute.',
      }));
      load();
      notify(
        !outcome.ran
          ? (outcome.reason ?? 'Could not send now. Try again in a minute.')
          : outcome.reason && outcome.accepted === 0
            ? /* A pass that ran and failed — signed out, no answer, a book that
                 would not save — says so. It used to read "Nothing was waiting
                 to send" whenever nothing had been pushed, whatever went wrong. */
              outcome.reason
            : outcome.pushed === 0
              ? 'Nothing was waiting to send. Your book is up to date.'
            : outcome.accepted > 0
              ? plural(outcome.accepted, 'entry', 'entries') + ' sent to the office'
              : outcome.rejected > 0
                ? plural(outcome.rejected, 'entry', 'entries') + ' not accepted by the office'
                : (outcome.reason ?? 'Nothing was sent. Your work is still safe on this phone.'),
        !outcome.ran || (outcome.reason && outcome.accepted === 0)
          ? 'error'
          : outcome.pushed === 0
            ? 'info'
            : outcome.accepted > 0
              ? 'success'
              : outcome.rejected > 0
                ? 'error'
                : 'warn',
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
  /* One rule, in one pure place, for what this card says — see
     `engines/tracker-notice.ts`. It read `stalled` and nothing else, so a
     handset whose battery manager was readably switched on was told the same
     hypothetical as one with nothing wrong with it. */
  const notice = trackerNotice({ stalled: stalled !== null, exemption, failure });
  const rejected = counts.rejected ?? 0;

  return (
    <AppFrame
      tone="canvas"
      title="Waiting to send"
      activeTab={null}
      onBack={back.go}
      showTitle={false}
      hero={
        <Text
          accessibilityRole="header"
          style={[{ fontSize: 20, lineHeight: 26, letterSpacing: -0.4, color: HERO.lavender.ink, marginTop: 14 }, weight(800)]}>
          Waiting to send
        </Text>
      }
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <View style={{ backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
        {/* The count pops when a pass changes it — "4 waiting" becoming "1
            waiting" is the outcome he pressed the button for, and a digit
            changing in place is easy to miss. It breathes while a pass is in
            flight, so the headline itself says something is happening. */}
        <Pulse active={sending} style={{ alignSelf: 'flex-start' }}>
          <Pop trigger={waiting} from={0.9}>
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={waiting ? plural(waiting, 'thing') + ' waiting to send' : 'All sent to the office'}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {waiting ? (
                <Glyph shapes={CLOUD_UP} size={34} color={C.lime} strokeWidth={1.8} />
              ) : (
                <View
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 26,
                    backgroundColor: C.lime,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <Icon name="tick" size={24} color={C.navy} strokeWidth={2.6} />
                </View>
              )}
              {waiting ? (
                <View>
                  <Text style={[{ fontSize: 40, lineHeight: 42, letterSpacing: -0.8, color: '#FFFFFF' }, weight(800)]}>
                    {waiting}
                  </Text>
                  <Text style={{ marginTop: 4, fontSize: 13, lineHeight: 18, color: C.onNavyMuted }}>
                    {waiting === 1 ? 'thing waiting to send' : 'things waiting to send'}
                  </Text>
                </View>
              ) : (
                <Text style={[{ flexShrink: 1, fontSize: 22, lineHeight: 31, letterSpacing: -0.44, color: '#FFFFFF' }, weight(800)]}>
                  All sent to the office
                </Text>
              )}
            </View>
          </Pop>
        </Pulse>
        <Text
          accessibilityLabel="You can save without signal. It sends by itself when you have signal."
          style={{ fontSize: 13, lineHeight: 18, color: '#C9D1E0', marginTop: 10 }}>
          Save without signal — it sends itself when signal comes back.
        </Text>
        <Pressable
          onPress={sending ? undefined : () => void sendNow()}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={sending ? 'Sending…' : 'Send now'}
          accessibilityState={{ disabled: sending, busy: sending }}
          style={({ pressed }) => ({
            marginTop: 14,
            minHeight: 56,
            paddingVertical: 8,
            borderRadius: 28,
            backgroundColor: waiting ? C.lime : 'rgba(255,255,255,0.12)',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            opacity: sending ? 0.55 : pressed ? 0.88 : 1,
          })}>
          {waiting ? <Glyph shapes={PLANE} size={18} color={C.navy} strokeWidth={2.4} /> : null}
          <Text style={[{ flexShrink: 1, fontSize: 16, lineHeight: 22, color: waiting ? C.navy : '#FFFFFF' }, weight(waiting ? 800 : 700)]}>
            {sending ? 'Sending…' : 'Send now'}
          </Text>
        </Pressable>
      </View>

      {media.pending > 0 ? (
        <View
          accessible
          accessibilityLabel={
            plural(media.pending, 'photo or recording', 'photos and recordings') + ' sending. Your entries go first.'
          }
          style={{
            marginTop: 10,
            alignSelf: 'flex-start',
            minHeight: 32,
            paddingVertical: 4,
            paddingHorizontal: 12,
            borderRadius: 16,
            backgroundColor: C.surface,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}>
          <Glyph shapes={CAMERA} size={14} color={C.body} />
          {/* The plural form is given rather than derived: appending an `s` to
              the whole phrase reads "2 photo or recordings". */}
          <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.body }, weight(600)]}>
            {media.pending + ' sending · entries go first'}
          </Text>
        </View>
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
            paddingVertical: 14,
            paddingHorizontal: 16,
            marginTop: 10,
            backgroundColor: C.dangerBg,
            borderRadius: 22,
          }}>
          <Glyph shapes={CAMERA} size={22} color={C.danger} />
          <View
            accessible
            accessibilityLabel={
              'Could not be sent. ' +
              plural(media.failed, 'photo or recording', 'photos and recordings') +
              ' did not send. They are still on this phone.'
            }
            style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 21, color: C.danger }, weight(800)]}>{'Could not be sent · ' + media.failed}</Text>
            <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.danger }}>
              {(media.failed === 1 ? 'Photo or recording' : 'Photos and recordings') + ' — still on this phone.'}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              void retryFailedMedia().then((n) => {
                load();
                notify(
                  n === 0
                    ? 'Nothing to try again'
                    : plural(n, 'photo or recording', 'photos and recordings') + ' waiting to send again',
                  n === 0 ? 'info' : 'success',
                );
                /* Media rides out on the back of a pass — see the `finally` in
                   `syncNow`. Queuing them and never asking for one would leave
                   him pressing a button that changed a column and nothing else. */
                void syncNow({ manual: true }).then(load);
              });
            }}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              borderWidth: 2,
              borderColor: C.danger,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}>
            <Icon name="refresh" size={20} color={C.danger} strokeWidth={2.2} />
          </Pressable>
        </View>
      ) : null}

      {/* An empty outbox drew an empty card: a bordered, rounded, shadowed slab
          two points tall sitting directly under the sentence saying everything
          has gone up, which reads as a row that failed to draw. `listQueue` and
          `queueDepth` ask the same question, so no rows means no depth and the
          caption below cannot be lost with it. */}
      {rows.length > 0 ? (
        <>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 14, paddingHorizontal: 4 }}>
            <Text accessibilityRole="header" style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: C.ink }, weight(800)]}>
              Most urgent first
            </Text>
            {depth > rows.length ? (
              /* "entries" rather than a bare count: photographs are counted in
                 the headline above and called out in their own line, and a
                 second unqualified number on one screen is how this screen came
                 to disagree with itself three ways in the first place. */
              <Text
                accessibilityLabel={`Showing the ${rows.length} most urgent of ${plural(depth, 'entry', 'entries')} waiting.`}
                style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: C.faint }, weight(600)]}>
                {`${rows.length} of ${plural(depth, 'entry', 'entries')}`}
              </Text>
            ) : null}
          </View>
          <View style={{ marginTop: 8, backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 14 }}>
            {rows.map((q, i) => {
              const tone = stateTone(q.state);
              const note = heldBehind(q, rows) ?? whyStuck(q);
              const lead = LEAD[q.entityType] ?? LEAD_DEFAULT;
              return (
                <Stagger
                  key={q.id}
                  index={i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: C.hairline,
                  }}>
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      backgroundColor: lead.bg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    <Glyph shapes={lead.glyph} size={18} color={lead.ink} />
                  </View>
                  <View
                    accessible
                    accessibilityLabel={[entityLabel(q.entityType), describe(q), when(q.createdAt, today), stateLabel(q), note]
                      .filter(Boolean)
                      .join('. ')}
                    style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={2} style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>
                      {describe(q)}
                    </Text>
                    <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }}>
                      {entityLabel(q.entityType) + ' · ' + when(q.createdAt, today)}
                    </Text>
                    {/* Coloured to match the badge beside it — an item still
                        retrying is amber, not red. */}
                    {note ? (
                      <Text style={{ fontSize: 12, lineHeight: 16, color: tone === 'danger' ? C.danger : C.warnInk }}>
                        {note}
                      </Text>
                    ) : null}
                  </View>
                  <View
                    style={{
                      minHeight: 26,
                      paddingVertical: 3,
                      paddingHorizontal: 9,
                      borderRadius: 13,
                      justifyContent: 'center',
                      backgroundColor: BADGE[tone].bg,
                    }}>
                    <Text style={[{ fontSize: 11, color: BADGE[tone].ink }, weight(800)]}>{stateLabel(q)}</Text>
                  </View>
                  {q.state === 'failed' || (q.state === 'blocked' && !heldBehind(q, rows)) ? (
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
                      accessibilityLabel={'Try again: ' + describe(q)}
                      style={({ pressed }) => ({
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: pressed ? C.hairline : C.canvas,
                        alignItems: 'center',
                        justifyContent: 'center',
                      })}>
                      <Icon name="refresh" size={18} color={C.ink} strokeWidth={2.2} />
                    </Pressable>
                  ) : null}
                </Stagger>
              );
            })}
          </View>
        </>
      ) : null}

      {/* A NEWER BUILD EXISTS.

          The tap opens the same Update now / Update later modal the refresh
          button raises, so there is one install path in the app — downloaded
          in-app where the build allows it, through the browser where it does
          not. Android still asks to confirm the install either way: an
          unattended one needs device-owner enrolment nobody here has. It is
          the difference between one tap and a fortnight: the field ran 1.0.0
          and 1.1.0 while 1.4.0 had been published for hours, and three bugs
          were diagnosed against builds that did not contain their own fixes. */}
      {update.kind === 'available' ? (
        <Pressable
          onPress={() => offerUpdate({ kind: 'install', version: update.version, url: update.url })}
          accessibilityRole="button"
          accessibilityLabel={'Update to ' + update.version + '. A new version of the app is out. Tap to update. Nothing on this phone is lost. You stay signed in.'}
          style={({ pressed }) => ({
            marginTop: 14,
            padding: 16,
            borderRadius: 22,
            backgroundColor: C.lavender,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            opacity: pressed ? 0.85 : 1,
          })}>
          <View
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="download" size={20} color="#FFFFFF" strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 21, color: C.primaryDeep }, weight(800)]}>{'Update to ' + update.version}</Text>
            <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.body }}>
              Tap to update. Nothing is lost; you stay signed in.
            </Text>
          </View>
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
        accessibilityLabel={notice.title + '. ' + notice.detail}
        style={({ pressed }) => ({
          marginTop: 10,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderRadius: 22,
          borderWidth: notice.tone === 'danger' ? 2 : 0,
          borderColor: C.danger,
          backgroundColor: C.surface,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          opacity: pressed ? 0.85 : 1,
        })}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: notice.tone === 'danger' ? C.dangerBg : C.canvas,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Glyph shapes={TARGET} size={20} color={notice.tone === 'danger' ? C.danger : C.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[{ fontSize: 15, lineHeight: 21, color: notice.tone === 'danger' ? C.danger : C.ink }, weight(800)]}>
            {notice.title}
          </Text>
          <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>{notice.detail}</Text>
        </View>
        <Icon name="forward" size={18} color={notice.tone === 'danger' ? C.danger : C.muted} strokeWidth={2} />
      </Pressable>

      {/* A refusal is not a queue item to retry blindly — it goes to the screen
          that says what the office objected to and how to correct it. */}
      {rejected > 0 ? (
        <Pressable
          onPress={() => router.push('/rejections?from=sync')}
          accessibilityRole="button"
          accessibilityLabel={'Not accepted. ' + plural(rejected, 'entry', 'entries') + ' not accepted by the office. Nothing is lost.'}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 14,
            paddingHorizontal: 16,
            marginTop: 10,
            backgroundColor: C.dangerBg,
            borderRadius: 22,
            opacity: pressed ? 0.85 : 1,
          })}>
          <Text style={[{ fontSize: 24, lineHeight: 30, color: C.danger, minWidth: 30, textAlign: 'center' }, weight(800)]}>{rejected}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 21, color: C.danger }, weight(800)]}>Not accepted</Text>
            <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.danger }}>by the office. Nothing is lost.</Text>
          </View>
          <Icon name="forward" size={18} color={C.danger} strokeWidth={2} />
        </Pressable>
      ) : null}

      {/* WHAT THE OFFICE SENT AND THIS PHONE COULD NOT SAVE. One bad row
          used to stop every update; now it costs that row, and this is where
          that is said rather than the book quietly missing something. */}
      {problems ? (
        <View
          accessible
          style={{
            backgroundColor: C.warnBg,
            borderRadius: 22,
            paddingVertical: 14,
            paddingHorizontal: 16,
            marginTop: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}>
          <Glyph shapes={CLOUD_ALERT} size={22} color={C.warnInk} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 21, color: C.warnInk }, weight(800)]}>
              {plural(problems.count, 'update', 'updates') + ' from the office could not be saved'}
            </Text>
            <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.ink }}>
              Everything else came through. Tell your manager if it stays after the next send.
            </Text>
          </View>
        </View>
      ) : null}
      {/* WHICH BUILD THIS IS. Without it, "the fix is not on my phone" and
          "the fix does not work" look identical from the office — which is
          exactly the hour that was lost to an APK that had been built and
          never published. `embedded` means it is running the bundle that came
          with the install; anything else is an update it has picked up. */}
      <Text style={{ fontSize: 12, lineHeight: 17, color: C.faint, textAlign: 'center', marginTop: 16 }}>
        {(() => {
          const b = runningBuild();
          return b.embedded
            ? 'App version: as installed'
            : `App update ${b.id.slice(0, 8)}${b.channel ? ' · ' + b.channel : ''}`;
        })()}
      </Text>
    </AppFrame>
  );
}

const BADGE = {
  danger: { bg: C.dangerBg, ink: C.danger },
  info: { bg: C.infoBg, ink: C.info },
  amber: { bg: C.warnBg, ink: C.warnInk },
} as const;

const CLOUD_UP: GlyphShape[] = [{ p: 'M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z' }, { p: 'M12 11v5M10 13l2-2 2 2' }];
const CLOUD_ALERT: GlyphShape[] = [{ p: 'M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z' }, { p: 'M12 10v4M12 16h.01' }];
const PLANE: GlyphShape[] = [{ p: 'M4 12l16-8-6 16-2-6z' }];
const CAMERA: GlyphShape[] = [{ r: [3, 7, 18, 13, 2] }, { c: [12, 13, 3] }, { p: 'M9 7l1.5-2h3L15 7' }];
const TARGET: GlyphShape[] = [{ c: [12, 12, 7] }, { c: [12, 12, 2] }, { p: 'M12 2v3M12 19v3M2 12h3M19 12h3' }];

/** The mark that leads a row: what kind of thing is waiting. */
const LEAD_DEFAULT = { glyph: [{ p: 'M7 3h7l5 5v13H7z' }, { p: 'M14 3v5h5' }] as GlyphShape[], bg: C.canvas, ink: C.body };
const LEAD: Record<string, { glyph: GlyphShape[]; bg: string; ink: string }> = {
  order: {
    glyph: [{ p: 'M4 5h2l2 10h10l2-7H7' }, { c: [9, 19, 1.5] }, { c: [17, 19, 1.5] }],
    bg: C.primaryTint,
    ink: C.primaryDeep,
  },
  order_change_request: {
    glyph: [{ p: 'M4 5h2l2 10h10l2-7H7' }, { c: [9, 19, 1.5] }, { c: [17, 19, 1.5] }],
    bg: C.primaryTint,
    ink: C.primaryDeep,
  },
  payment: { glyph: [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18' }], bg: C.successBg, ink: C.success },
  visit: {
    glyph: [{ p: 'M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z' }, { c: [12, 10, 2.5] }],
    bg: C.canvas,
    ink: C.body,
  },
  lead: { glyph: [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }], bg: C.primaryTint, ink: C.primaryDeep },
  expense: { glyph: [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }, { p: 'M9 8h6M9 12h6' }], bg: C.canvas, ink: C.body },
  complaint: { glyph: [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }], bg: C.dangerBg, ink: C.danger },
  sample: {
    glyph: [{ p: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' }],
    bg: C.primaryTint,
    ink: C.primaryDeep,
  },
};
