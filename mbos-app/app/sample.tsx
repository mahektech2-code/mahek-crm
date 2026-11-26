import React from 'react';
import { ActivityIndicator, Animated, Image, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Badge, Input, T } from '../src/components/ui/primitives';
import { Pill, PillButton, SheetActions } from '../src/components/ui/v3';
import { Icon } from '../src/components/ui/Icon';
import { skuText } from '../src/components/ui/sku';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, weight, type BadgeTone } from '../src/theme/tokens';
import {
  cancelReasons,
  cancelSample,
  chaseFor,
  confirmReceived,
  feedbackFor,
  getSample,
  isAwaitingReview,
  markDispatched,
  markTrialStarted,
  markTried,
  recordFeedback,
  rejectionSaidWhy,
  REJECTION_NEEDS_WHY,
  reviewChaseDays,
  whatIsOwed,
  type FunnelSample,
  type SampleFeedback,
  type TrialVerdict,
} from '../src/data/lead-samples';
import { chaseCountSentence, nextChaseSentence, type ChaseSchedule } from '../src/lib/sample-chase';
import { VoiceField } from '../src/components/ui/dictate';
import { getCustomer } from '../src/data/customers';
import { getLead } from '../src/data/leads';
import { takePhoto } from '../src/native/capture';
import { ACTIVE_FEEDBACK_FIELDS, FEEDBACK_FIELDS, REASON_CODE_NEEDING_REMARKS, trialReviewProblem, type CodedOption } from '../src/engines/funnel';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import { dmy, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Pop, Presence, PressableScale, Swap, useShake } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { syncBadge } from '../src/sync/labels';

/**
 * One sample, from the godown to what the customer thought of it.
 *
 * Three marks and a review, and they are four separate acts rather than one
 * "update" because §15 chases the gaps between them separately. The screen
 * only ever offers the ONE that is next: a sample still waiting on the office
 * cannot be marked delivered, and offering the button would teach somebody to
 * press it and then wonder why nothing happened.
 *
 * The review is seven answers and not a paragraph. Six of them are named, and
 * every one is a different conversation with a different person afterwards —
 * "dries slow" goes to the works and "dearer than Asian" goes to the office,
 * and a single free-text box holding both can be read back as neither.
 *
 * THERE IS ONE OF THIS SCREEN, and there were briefly two. A second build of
 * it read `data/requests.ts` and drew the same lifecycle in fewer marks —
 * dispatch, delivered, received, trial, a verdict. One route can only open one
 * screen, and this is the one the funnel needs: `sample_feedback` is what the
 * gate in front of Negotiation reads, and only this screen writes it, so
 * keeping the other would have left that rung shut with nothing able to open
 * it. Nothing is lost in the store — every column the other build wrote is
 * still on `samples`, still filled by the pull, and `confirmReceived` still
 * sends `receivedAt` up the wire under the name the office reads.
 */

/**
 * The verdict, in words — one sentence for each of the FOUR the office takes.
 *
 * `more_testing` is not a shrug and must not be drawn as one: "they want to
 * try it again on a different substrate" is an answer, and rendering it as
 * "No verdict yet" says on the customer's record that nobody asked.
 */
function verdictSentence(outcome: string | null): string {
  switch (outcome) {
    case 'approved': return 'They were happy with it';
    case 'rejected': return 'They were not happy with it';
    case 'more_testing': return 'They want to try it again';
    default: return 'No answer yet';
  }
}

function toneFor(state: string): BadgeTone {
  switch (state) {
    case 'Converted':
    case 'Reviewed': return 'success';
    case 'Awaiting feedback':
    case 'Tried': return 'amber';
    case 'Requested': return 'info';
    case 'Rejected': return 'danger';
    case 'Cancelled': return 'neutral';
    default: return 'teal';
  }
}

export default function SampleRecord() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('samples');
  const notify = useStore((s) => s.notify);

  const [sample, setSample] = React.useState<FunnelSample | null>(null);
  const [review, setReview] = React.useState<SampleFeedback | null>(null);
  const [who, setWho] = React.useState<string>('');
  /* READING is not the same answer as NOT HERE. Both start with an empty row,
     and this screen used to draw "This sample is not on this phone" on the
     first frame of every open — a definitive sentence about a record that was
     still being read out of SQLite, on a screen whose only control is a way
     back. It is never reset to `reading` on a refocus: the row is already on
     screen by then and a flash of "Reading…" over it says nothing true. */
  const [status, setStatus] = React.useState<'reading' | 'ready' | 'failed'>('reading');
  const [dispatchOpen, setDispatchOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  /* The eight, read off configuration once when the screen opens. An empty
     list is a real state and the sheet draws it — see `ReasonSheet`. */
  const [reasons, setReasons] = React.useState<CodedOption[]>([]);
  /* §16's ladder, off configuration rather than typed here. The registry's own
     default is the fallback, so a handset that has never pulled still draws a
     rhythm rather than an empty panel. */
  const [chaseDays, setChaseDays] = React.useState<number[]>([]);
  /* THE DAY, READ ON EVERY FOCUS rather than during render. This process lives
     for days — the salesman opens the app he left open last night — and a date
     frozen at mount would draw yesterday's ladder, in the direction that hides
     what is already due. Reading the clock in render is the other way to get
     this wrong and the compiler rules forbid it. */
  const [today, setToday] = React.useState(() => isoDate(new Date()));
  const [busy, setBusy] = React.useState(false);
  /* STEP 2 of Sample / Trial opens with a question: has the sample been received?
     No keeps the review shut; Yes offers the receipt, and the review only opens
     once the receipt is recorded and the sample is `Awaiting feedback`. */
  const [receivedAnswer, setReceivedAnswer] = React.useState<'yes' | 'no' | null>(null);
  /* A REF, not state: a second tap arrives before any re-render has happened,
     so a boolean in state is read at its old value and the cancellation is
     queued twice. The sheet closes on the first press and the write is still
     in flight behind it. */
  const cancelling = React.useRef(false);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) {
      setStatus('ready');
      return;
    }
    setToday(isoDate(new Date()));
    void Promise.all([getSample(id), feedbackFor(id), cancelReasons(), reviewChaseDays()])
      .then(async ([s, f, why, chase]) => {
        if (!live) return;
        setSample(s);
        setReview(f);
        setReasons(why);
        setChaseDays(chase);
        setStatus('ready');
        if (s) {
          const c = await getCustomer(s.customerId);
          const name = c?.name ?? (await getLead(s.customerId).then((l) => (l ? l.company?.trim() || l.name : '')));
          if (live) setWho(name ?? '');
        }
      })
      .catch(() => {
        if (live) setStatus('failed');
      });
    return () => {
      live = false;
    };
  }, [id]);

  useFocusEffect(load);

  if (!sample) {
    return (
      <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 14, paddingBottom: 24 }}>
        <View
          style={{
            backgroundColor: C.surface,
            borderRadius: 20,
            paddingHorizontal: 16,
            paddingVertical: 18,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}>
          {status === 'reading' ? <ActivityIndicator size="small" color={C.primary} /> : null}
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.ink, textAlign: 'center' }, weight(700)]}>
            {status === 'reading'
              ? 'Loading…'
              : status === 'failed'
                ? 'Could not open this on the phone'
                : 'This sample is not on this phone'}
          </T>
        </View>
      </AppFrame>
    );
  }

  const s = sample;
  const owed = whatIsOwed(s);
  /* Pure, and derived on the way past rather than held in state: the ladder is
     arithmetic over the receipt date, the configured days and today, and a
     cached second copy of it is a copy that can disagree with the record it
     sits on. */
  const chase = chaseFor(s, chaseDays, today);
  const awaiting = isAwaitingReview(s);
  const finished = s.state === 'Reviewed' || s.state === 'Converted' || s.state === 'Cancelled' || s.state === 'Rejected';
  const h = HERO.lavender;
  const day = (ms: number) => pretty(isoDate(new Date(ms)));
  const productLine = [skuText(s.sku), s.productName, s.cans ? plural(s.cans, 'can') : null].filter(Boolean).join(' · ');
  /* THE SHOP'S WORD, not the carrier's, and the two are not the same record.
     `receivedConfirmedAt` is what a confirmation made on this handset writes
     and `receivedAt` is the name the office writes the same fact under —
     reading only the first meant a sample the shop had confirmed to the office
     showed nothing here at all. */
  const confirmedAt = (s.receivedConfirmedAt ?? s.receivedAt) as number | null | undefined;
  const modeWord = s.sendingMode ? (s.sendingMode === 'hand_delivery' ? 'Hand Delivery' : 'Courier') : null;

  /* A finished sample is read as its journey: one dot per mark it actually
     made, left to right. BOTH trial dates are on it, because the gap between
     them is the point — a can opened three weeks ago and never finished reads
     here as exactly that instead of looking identical to one nobody touched. */
  const journey: { key: string; label: string; at: string; red?: boolean }[] = [
    { key: 'asked', label: 'Asked', at: day(s.requestedAt) },
    s.dispatchedAt ? { key: 'sent', label: 'Sent', at: day(s.dispatchedAt) } : null,
    confirmedAt ? { key: 'got', label: 'Got it', at: day(confirmedAt) } : null,
    s.trialStartedAt ? { key: 'on', label: 'Trial on', at: day(s.trialStartedAt) } : null,
    s.trialCompletedAt ? { key: 'off', label: 'Trial off', at: day(s.trialCompletedAt) } : null,
    s.reviewedAt ? { key: 'rev', label: 'Reviewed', at: day(s.reviewedAt), red: s.state === 'Rejected' } : null,
  ].filter((x): x is { key: string; label: string; at: string; red?: boolean } => !!x);
  const asJourney = finished && s.state !== 'Cancelled';

  /* The record's facts, as label/value cells. Every line the record has ever
     drawn is here; the order is the V3 grid's. */
  type Fact = { label: string; value: string; a11y?: string; icon?: React.ReactNode; good?: boolean };
  const facts: Fact[] = ([
    { label: 'Asked for', value: day(s.requestedAt) },
    s.plannedSendDate ? { label: 'Planned to go', value: pretty(s.plannedSendDate) } : null,
    modeWord
      ? {
          label: 'Mode',
          a11y: 'Sending mode',
          value: modeWord,
          icon: s.sendingMode === 'hand_delivery' ? null : <Truck color={C.ink} size={16} />,
        }
      : null,
    s.dispatchedAt ? { label: 'Sent', value: day(s.dispatchedAt) } : null,
    s.courierDocket ? { label: 'Docket', value: [s.courierName, s.courierDocket].filter(Boolean).join(' · ') } : null,
    s.expectedDeliveryDate ? { label: 'Should reach by', value: pretty(s.expectedDeliveryDate) } : null,
    s.application ? { label: 'Used on', value: s.application } : null,
    confirmedAt ? { label: 'They confirmed it', value: day(confirmedAt), good: true } : null,
    s.trialStartedAt ? { label: 'Trial started', value: day(s.trialStartedAt) } : null,
    s.trialCompletedAt ? { label: 'Trial finished', value: day(s.trialCompletedAt) } : null,
    s.reviewedAt ? { label: 'Reviewed', value: day(s.reviewedAt) } : null,
    s.satisfaction ? { label: 'They said', value: s.satisfaction } : null,
    s.additionalRequirement ? { label: 'Also asked for', value: s.additionalRequirement } : null,
  ] as (Fact | null)[]).filter((x): x is Fact => !!x);

  /* The count's colour. Red only once the named ladder has been walked to its
     end with no answer — that is the point at which a manager is meant to stop
     reading and ring the shop. Not asked yet, and not told, are both quiet. */
  const countInk =
    chase.asked == null || chase.asked === 0
      ? C.onNavyMuted
      : chase.asked >= chase.rungs.length
        ? '#FF8A80'
        : '#FFD27A';

  return (
    <AppFrame
      title="Sample"
      activeTab={null}
      onBack={back.go}
      showTitle={false}
      hero={
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 16 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              accessibilityRole="header"
              style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.48, color: h.ink }, weight(800)]}>
              {who || 'Unknown shop'}
            </Text>
            {productLine ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <Flask size={14} color={h.muted} />
                <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: h.muted }}>{productLine}</Text>
              </View>
            ) : null}
          </View>
          {/* The mark he just made, answered on the badge: it pops as the
              state moves on. The toast that confirmed the save is the buzz. */}
          <Pop trigger={s.state + (syncBadge(s.syncState)?.label ?? '')}>
            <Badge
              tone={syncBadge(s.syncState)?.tone ?? toneFor(s.state)}
              style={{ minHeight: 30, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 15 }}>
              {syncBadge(s.syncState)?.label ?? s.state}
            </Badge>
          </Pop>
        </View>
      }
      contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      {/* WHAT IS OWED, and — where a review is owed — HOW MANY TIMES IT HAS
          BEEN ASKED, at the top of the record and not buried in the panel
          below.

          The count is the number the whole mechanism exists to produce. A trial
          reviewed yesterday and one chased three times with no answer are the
          same badge and the same sentence otherwise, and they are two different
          mornings — the first is waiting and the second is picking the phone up
          yourself. Where the count has not reached this phone it says exactly
          that, in a differently shaped sentence, because a zero drawn for an
          absence reassures somebody about work nobody has checked. */}
      {owed || awaiting ? (
        <View style={{ backgroundColor: C.navy, borderRadius: 20, padding: 16 }}>
          {owed ? <Text style={[{ fontSize: 15, lineHeight: 21, color: '#FFFFFF' }, weight(700)]}>{owed}</Text> : null}
          {awaiting ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: owed ? 8 : 0 }}>
              <Icon name="call" size={14} color={countInk} strokeWidth={2.2} />
              <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: countInk }, weight(700)]}>
                {chaseCountSentence(chase.asked)}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* WHY IT WAS REFUSED. §K demands the reason so that the next sample
          does not go out identical, and the salesman is the person who would
          change it — and was the one person never shown it. Until this line
          existed a refused sample was a red badge, no sentence under it
          (`whatIsOwed` is null for a finished one) and the whole action block
          hidden: a card with one word on it. */}
      {s.rejectionReason || s.state === 'Rejected' ? (
        <View style={{ backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14 }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>Not accepted because</Text>
          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 4 }, weight(700)]}>
            {/* A missing reason is said rather than drawn as an empty card.
                The rule demands one, so its absence is itself worth knowing. */}
            {s.rejectionReason || 'The office has not said why. Ask them before the next sample goes.'}
          </Text>
        </View>
      ) : null}
      {s.cancelReason ? (
        <View style={{ backgroundColor: C.hairline, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14 }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>Cancelled</Text>
          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 4 }, weight(700)]}>{s.cancelReason}</Text>
        </View>
      ) : null}

      {asJourney ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            {journey.map((j) => (
              <View
                key={j.key}
                accessible
                accessibilityLabel={j.label + ', ' + j.at}
                style={{ flex: 1, alignItems: 'center' }}>
                <View
                  style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: j.red ? C.danger : C.primary, marginBottom: 4 }}
                />
                <Text style={{ fontSize: 11, color: C.muted, textAlign: 'center' }}>{j.label}</Text>
                <Text style={[{ fontSize: 11, color: C.ink, textAlign: 'center' }, weight(700)]}>{j.at}</Text>
              </View>
            ))}
          </View>
          {/* What the journey cannot draw as a date, as tags — nothing the
              record carries is dropped for being in the wrong shape. */}
          {(() => {
            const tags = [
              modeWord,
              s.plannedSendDate ? 'Planned to go: ' + pretty(s.plannedSendDate) : null,
              s.courierDocket ? 'Docket: ' + [s.courierName, s.courierDocket].filter(Boolean).join(' · ') : null,
              s.expectedDeliveryDate ? 'Should reach by: ' + pretty(s.expectedDeliveryDate) : null,
              s.application ? 'Used on: ' + s.application : null,
              s.satisfaction ? 'They said: ' + s.satisfaction : null,
              s.additionalRequirement ? 'Also asked for: ' + s.additionalRequirement : null,
            ].filter((x): x is string => !!x);
            return tags.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                {tags.map((t) => (
                  <Pill key={t} text={t} bg={C.canvas} fg={C.ink} height={28} />
                ))}
              </View>
            ) : null;
          })()}
        </View>
      ) : (
        <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 }}>
            {facts.map((f, i) => {
              const lastRow = i >= facts.length - (facts.length % 2 === 0 ? 2 : 1);
              return (
                <View
                  key={f.label}
                  accessible
                  accessibilityLabel={(f.a11y ?? f.label) + ': ' + f.value}
                  style={{
                    width: '47%',
                    flexGrow: 1,
                    paddingVertical: 10,
                    borderBottomWidth: lastRow ? 0 : 1,
                    borderBottomColor: C.hairline,
                  }}>
                  <Text style={{ fontSize: 11, color: C.muted }}>{f.label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {f.icon}
                    <Text style={[{ flexShrink: 1, fontSize: 15, lineHeight: 21, color: f.good ? C.success : C.ink }, weight(700)]}>
                      {f.value}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* ------------------------------------------------ §15 the next mark */}
      {/* Keyed on the state, so the next mark REPLACES the one just made in
          place — "They got it" gives way to "Trial started" — rather than the
          block snapping to a different height under his thumb. */}
      {finished ? null : (
        <Swap id={s.state}>
          <View style={{ gap: 10 }}>
            <Text accessibilityRole="header" accessibilityLabel="What happens next" style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 4 }, weight(700)]}>
              Next
            </Text>

            {s.state === 'Requested' ? (
              <View
                style={{
                  backgroundColor: C.surface,
                  borderRadius: 20,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                }}>
                <Icon name="shield" size={18} color={C.info} strokeWidth={2} />
                <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.muted }}>
                  <Text style={[{ color: C.ink }, weight(700)]}>Requested</Text>
                  {' · The office must approve it first. Nothing for you to do yet.'}
                </Text>
              </View>
            ) : null}

            {s.state === 'Approved' ? (
              <BigButton label="Mark as sent" icon={<Truck color="#FFFFFF" />} onPress={() => setDispatchOpen(true)} />
            ) : null}

            {s.state === 'Dispatched' ? (
              <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14 }}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>Dispatched · Sample received &amp; review</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                  <Text style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
                    Has the sample been received?
                  </Text>
                  <YesNo value={receivedAnswer} onChange={setReceivedAnswer} />
                </View>
                {receivedAnswer === 'yes' ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <Tile
                      label={busy ? 'Saving…' : 'Got it + photo'}
                      a11y="They got it. Take photo"
                      tone="primary"
                      disabled={busy}
                      icon={<Icon name="camera" size={18} color="#FFFFFF" strokeWidth={2} />}
                      onPress={async () => {
                        /* One press, one mark. Nothing here disabled while the write
                           was in flight and the sheet only closes once it returns,
                           so a double tap on a slow phone queued the mark twice. */
                        if (busy) return;
                        setBusy(true);
                        try {
                          const shot = await takePhoto({ parentType: 'sample', parentId: s.id, kind: 'sample_proof' });
                          /* A refused camera or a cancelled picker is not a reason to
                             lose the fact: the delivery is confirmed either way and
                             only the photograph is poorer for it. Every attachment in
                             this app follows that rule. */
                          const r = await confirmReceived(s.id, shot.ok ? shot.mediaId : null);
                          if (!r.ok) return notify(r.message, 'error');
                          load();
                          /* "Delivered" was the carrier's word for a mark that is the
                             SHOP's. One tap cannot assert both, and the record now
                             only claims the one it is actually evidence of. */
                          notify(shot.ok ? 'Saved. They got it. Photo taken.' : 'Saved. They got it. No photo taken.', shot.ok ? 'success' : 'warn');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                    <Tile
                      label="Got it, no photo"
                      a11y="They got it. No photo"
                      tone="wash"
                      icon={<Icon name="tick" size={18} color={C.success} strokeWidth={2.2} />}
                      onPress={async () => {
                        if (busy) return;
                        setBusy(true);
                        try {
                          const r = await confirmReceived(s.id, null);
                          if (!r.ok) return notify(r.message, 'error');
                          load();
                          notify('Saved. They got it.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  </View>
                ) : null}
                {receivedAnswer === 'no' ? (
                  <Text
                    accessibilityLabel="The review stays locked. Nothing is marked received or reviewed, and the lead cannot go to Negotiation until the sample has arrived."
                    style={{
                      marginTop: 10,
                      borderRadius: 14,
                      backgroundColor: C.canvas,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      fontSize: 13,
                      lineHeight: 18,
                      color: C.muted,
                      overflow: 'hidden',
                    }}>
                    No: review stays locked; nothing marked received; no Negotiation until it arrives.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {s.state === 'Awaiting feedback' ? (
              <>
                <BigButton label="Write their feedback" icon={<ChatGlyph />} onPress={() => setReviewOpen(true)} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {/* STARTED and FINISHED are two marks. Without the first, a shop
                      that opened the can three weeks ago and never got to the end
                      of it looks exactly like one that has not touched it — and
                      that stall is the commonest way a sample goes quiet. It is
                      offered once: the date is already on the record afterwards. */}
                  {s.trialStartedAt ? null : (
                    <Tile
                      label="They started using it"
                      a11y="They have started using it"
                      tone="white"
                      icon={<Icon name="play" size={18} color={C.primaryDeep} strokeWidth={2} />}
                      onPress={async () => {
                        if (busy) return;
                        setBusy(true);
                        try {
                          const r = await markTrialStarted(s.id);
                          if (!r.ok) return notify(r.message, 'error');
                          load();
                          notify('Trial started. Feedback is still pending.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  )}
                  <Tile
                    label="Tried. Ask later"
                    a11y="They tried it. Ask later"
                    tone="white"
                    icon={<Icon name="clock" size={18} color={C.warnInk} strokeWidth={2} />}
                    onPress={async () => {
                      if (busy) return;
                      setBusy(true);
                      try {
                        const r = await markTried(s.id);
                        if (!r.ok) return notify(r.message, 'error');
                        load();
                        notify('Tried. Feedback is pending now.');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </View>
              </>
            ) : null}

            {/* A Tried sample that already carries answers is a "Not decided"
                one, and the card below is where it is changed. */}
            {s.state === 'Tried' && !review ? (
              <BigButton label="Write their feedback" icon={<ChatGlyph />} onPress={() => setReviewOpen(true)} />
            ) : null}

            {/* WHY, AS ONE OF EIGHT AND NOT AS A BOX. This was the generic
                confirmation sheet, which offers a single multiline field — so
                every cancellation a salesman made arrived at the office as prose
                nobody could count, while the office had taken a code since the
                module shipped. The three problems the eight exist to separate —
                a product we could not source, a shop that stopped answering, a
                price objection — all read as "trial cancelled" until then. */}
            <Pressable
              onPress={() => setCancelOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Cancel this sample"
              style={({ pressed }) => ({
                minHeight: 48,
                paddingVertical: 8,
                borderRadius: 24,
                borderWidth: 1.5,
                borderStyle: 'dashed',
                borderColor: '#DCE3EE',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                opacity: pressed ? 0.7 : 1,
              })}>
              <Icon name="close" size={16} color={C.danger} strokeWidth={2.2} />
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(700)]}>Cancel this sample</Text>
            </Pressable>
          </View>
        </Swap>
      )}

      {/* REVIEWED, AND NOTHING ON THIS PHONE TO SHOW FOR IT. A review taken at
          the office, or before a reinstall, never comes down the wire — so the
          "Change it" card below has nothing to hang on and the actions above
          are gone with `finished`. Without this the sample offered no way to
          write the review at all, and the Negotiation rung that waits on it
          could not be opened from the phone. */}
      {s.state === 'Reviewed' && !review ? (
        <BigButton label="Write their feedback" icon={<ChatGlyph />} onPress={() => setReviewOpen(true)} />
      ) : null}

      {/* ------------------------------------------- §16 the chase ladder */}
      {awaiting ? <ChasePanel chase={chase} /> : null}

      {/* ------------------------------------------------- §16 the review */}
      {review ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 20, padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>
              What they said
            </Text>
            {review.photoId ? (
              <View accessible accessibilityLabel="A photo is attached." style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="camera" size={18} color={C.muted} strokeWidth={2} />
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>A photo is attached</Text>
              </View>
            ) : null}
          </View>
          <View style={{ gap: 10, marginTop: 10 }}>
            {FEEDBACK_FIELDS.map((f) => {
              const said = (review as unknown as Record<string, string | null>)[f.id];
              if (!said) return null;
              return (
                <View key={f.id}>
                  <Text style={{ fontSize: 11, color: C.muted }}>{f.label}</Text>
                  <Text style={{ marginTop: 2, fontSize: 15, lineHeight: 21, color: C.ink }}>{said}</Text>
                </View>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
            {/* FOUR verdicts. "They want to try it again" drawn as "No verdict
                yet" filed a trial that really happened as an unanswered one —
                which is the one reading of it that loses the trial. */}
            <VerdictChip outcome={review.trialOutcome} />
            <Pressable
              onPress={() => setReviewOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Change it"
              style={({ pressed }) => ({
                minHeight: 44,
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 22,
                backgroundColor: pressed ? C.hairline : C.canvas,
                alignItems: 'center',
                justifyContent: 'center',
              })}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Change it</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <PillButton label="Back to samples" variant="white" height={48} onPress={() => router.replace('/samples')} />

      <DispatchSheet
        key={dispatchOpen ? 'd-open' : 'd-shut'}
        open={dispatchOpen}
        byHand={s.sendingMode === 'hand_delivery'}
        onClose={() => setDispatchOpen(false)}
        onSave={async (d) => {
          const r = await markDispatched(s.id, d);
          if (!r.ok) return notify(r.message, 'error');
          setDispatchOpen(false);
          load();
          notify(d.courierDocket ? 'Sent · ' + d.courierDocket : 'Handed over');
        }}
      />

      <ReasonSheet
        key={cancelOpen ? 'c-open' : 'c-shut'}
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this sample?"
        body="The sample record stays, with the reason. No more follow-up on it."
        options={reasons}
        confirmLabel="Cancel it"
        noteLabel="What actually happened"
        notePlaceholder="Optional. In your own words"
        /* The one of the eight that costs a sentence, said on the sheet BEFORE
           the button is pressed, and refused again in `cancelSample`: a screen
           is not a rule, and this is the same pair the office keeps. */
        noteRequiredForCode={REASON_CODE_NEEDING_REMARKS}
        onConfirm={(code, said) => {
          if (cancelling.current) return;
          cancelling.current = true;
          setCancelOpen(false);
          void cancelSample(s.id, { reasonCode: code, remarks: said })
            .then((r) => {
              if (!r.ok) return notify(r.message, 'error');
              load();
              notify('Cancelled');
            })
            .finally(() => {
              cancelling.current = false;
            });
        }}
      />

      <ReviewSheet
        key={reviewOpen ? 'r-open' : 'r-shut'}
        open={reviewOpen}
        existing={review}
        onClose={() => setReviewOpen(false)}
        onSave={async (fields, outcome, photoId) => {
          const r = await recordFeedback(s.id, { customerId: s.customerId, fields, trialOutcome: outcome, photoId });
          if (!r.ok) return notify(r.message, 'error');
          setReviewOpen(false);
          load();
          notify('Saved');
        }}
        onPhoto={async () => {
          const shot = await takePhoto({ parentType: 'sample', parentId: s.id, kind: 'sample_proof' });
          if (!shot.ok) {
            notify(shot.reason === 'cancelled' ? 'No photo taken' : shot.reason, shot.reason === 'cancelled' ? 'info' : 'error');
            return null;
          }
          return { mediaId: shot.mediaId, uri: shot.uri };
        }}
      />
    </AppFrame>
  );
}

/**
 * §16 — the chase, drawn as a checklist that does not run out.
 *
 * Three things have to survive being put on a screen, and each of them is a way
 * this panel could quietly lie.
 *
 * THE CLOCK STARTS AT CONFIRMED RECEIPT. Not at dispatch, which is us saying it
 * went, and not at delivery, which is the carrier's word. A ladder counted from
 * either would tell a salesman to ring a shop still waiting for the parcel —
 * and that call teaches the shop we do not know where our own stock is. Before
 * the shop confirms, this panel draws no ladder at all and says why.
 *
 * THE LAST RUNG IS NOT THE LAST ASK. A finite three-item list that runs out
 * implies the chasing has stopped, and it has not: the last interval repeats
 * until there is an answer, because a trial nobody reviewed is stock given away
 * for nothing. So the named ladder is the checklist, what has gone past it is
 * counted in one line, and the sentence underneath always names the next day.
 *
 * NOT BEING TOLD IS NOT BEING TOLD NOTHING HAPPENED. The count lives in
 * `mbos_samples.review_chase_count` and does not travel on the wire, so every
 * handset today reads null — and the boxes are drawn hollow with the days said
 * plainly rather than ticked as unchased. The calendar is still ours: which
 * days have gone by is arithmetic this phone can do with no signal, and saying
 * that much is worth more than saying nothing.
 */
function ChasePanel({ chase }: { chase: ChaseSchedule }) {
  const next = nextChaseSentence(chase, pretty);

  if (!chase.startedOn) {
    return (
      <View
        accessible
        style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', gap: 10 }}>
        <Icon name="call" size={18} color={C.muted} strokeWidth={2} />
        <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: C.muted }}>
          <Text style={[{ color: C.ink }, weight(700)]}>Follow-up has not started.</Text>
          {' It starts on the day the shop says they got it. It does not start on the day it was sent. Mark it received first.'}
        </Text>
      </View>
    );
  }

  const allAsked = chase.asked != null && chase.asked >= chase.rungs.length && chase.rungs.length > 0;
  /* The ask that comes next wears the amber edge — the one a salesman is
     waiting on. */
  const nextAsk = chase.rungs.find((r) => r.asked !== true)?.ask ?? null;

  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 20, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="call" size={18} color={C.ink} strokeWidth={2} />
        <Text accessibilityRole="header" style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>
          {'Feedback follow-up · ' + chaseCountSentence(chase.asked)}
        </Text>
      </View>
      {allAsked ? (
        <Pill
          text="Call them yourself"
          icon="call"
          bg={C.dangerBg}
          fg={C.danger}
          height={28}
          style={{ marginTop: 8 }}
        />
      ) : null}
      <Text
        accessibilityLabel={'Counted from ' + pretty(chase.startedOn) + '. They got it that day.'}
        style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
        {'From ' + pretty(chase.startedOn) + ', the day they got it'}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {chase.rungs.map((r) => {
          /* A filled mark is the office saying the ask went. A hollow one
             means either it has not or nobody has told us, and the word under
             it is what tells the two apart — a tick that had to guess would be
             the one thing on this panel worth nothing. */
          const word =
            r.asked === true
              ? 'asked'
              : r.asked === false
                ? r.duePassed
                  ? 'not asked'
                  : 'to come'
                : r.duePassed
                  ? 'day passed'
                  : 'to come';
          const done = r.asked === true;
          return (
            <View
              key={r.ask}
              accessible
              accessibilityLabel={'Ask ' + r.ask + ', ' + pretty(r.dueOn) + ', ' + word}
              style={{
                flexGrow: 1,
                flexBasis: '30%',
                borderRadius: 16,
                backgroundColor: done ? C.successBg : C.canvas,
                padding: 10,
                alignItems: 'center',
                borderWidth: !done && r.ask === nextAsk ? 1.5 : 0,
                borderColor: C.warnInk,
              }}>
              {done ? (
                <Icon name="tick" size={18} color={C.success} strokeWidth={2.2} />
              ) : (
                <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: r.duePassed ? C.warnInk : C.muted, marginVertical: 1 }} />
              )}
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 2 }, weight(800)]}>{'Ask ' + r.ask}</Text>
              <Text
                style={[
                  { fontSize: 12, textAlign: 'center', color: done ? C.success : r.duePassed ? C.warnInk : C.muted },
                  weight(600),
                ]}>
                {pretty(r.dueOn) + ' · ' + word}
              </Text>
            </View>
          );
        })}
      </View>

      {/* PAST THE LADDER IS A COUNT, NOT MORE BOXES. Twenty rows for a trial
          that has gone quiet for six weeks is a list nobody reads, and the
          one number worth having out of it is how many times we have asked. */}
      {chase.beyondLadder ? (
        <Text style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.warnInk }, weight(600)]}>
          {'…and asked ' + plural(chase.beyondLadder, 'more time') + ' since then.'}
        </Text>
      ) : null}

      {next ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <Icon name="refresh" size={14} color={C.muted} strokeWidth={2} />
          <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>{next}</Text>
        </View>
      ) : null}

      {/* Said once, at the bottom, where somebody who has just read a row of
          hollow circles is asking why none of them is ticked. */}
      {chase.asked == null ? (
        <Text style={{ fontSize: 12, lineHeight: 17, marginTop: 8, color: C.muted }}>
          Only the office knows how many times they asked. This phone only knows the days. Ask the office before you call.
        </Text>
      ) : null}
    </View>
  );
}

/** The flask, the samples glyph. */
function Flask({ size = 26, color = C.primaryDeep }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The courier van V3 draws beside Courier and Mark as sent. */
function Truck({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Circle cx={7} cy={18} r={1.6} stroke={color} strokeWidth={2} />
      <Circle cx={17} cy={18} r={1.6} stroke={color} strokeWidth={2} />
    </Svg>
  );
}

/** The speech bubble on Write their feedback. */
function ChatGlyph({ color = '#FFFFFF', size = 18 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 20l1.5-4A8 8 0 1 1 9 19z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

/** The 56 primary pill the record's next mark is drawn as. */
function BigButton({ label, icon, onPress }: { label: string; icon?: React.ReactNode; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <View
        style={{
          minHeight: 56,
          paddingVertical: 8,
          borderRadius: 28,
          backgroundColor: C.primary,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}>
        {icon}
        <Text style={[{ fontSize: 16, lineHeight: 22, color: '#FFFFFF' }, weight(700)]}>{label}</Text>
      </View>
    </PressableScale>
  );
}

/** A 64-tall tile: the two smaller marks that sit beside each other. */
function Tile({
  label,
  a11y,
  icon,
  tone,
  disabled = false,
  onPress,
}: {
  label: string;
  a11y: string;
  icon: React.ReactNode;
  tone: 'primary' | 'white' | 'wash';
  disabled?: boolean;
  onPress: () => void;
}) {
  const bg = tone === 'primary' ? C.primary : tone === 'wash' ? C.canvas : C.surface;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 64,
        borderRadius: 20,
        backgroundColor: bg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 10,
        opacity: pressed || disabled ? 0.8 : 1,
      })}>
      {icon}
      <Text style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: tone === 'primary' ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

/** The Yes / No switch, navy on the picked side. */
function YesNo({ value, onChange }: { value: 'yes' | 'no' | null; onChange: (v: 'yes' | 'no') => void }) {
  return (
    <View
      accessibilityRole="radiogroup"
      style={{ minHeight: 44, borderRadius: 22, backgroundColor: C.canvas, padding: 4, flexDirection: 'row', gap: 4 }}>
      {(['yes', 'no'] as const).map((k) => {
        const on = value === k;
        return (
          <Pressable
            key={k}
            onPress={() => {
              if (!on) feedback('select');
              onChange(k);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={k === 'yes' ? 'Yes' : 'No'}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{
              width: 56,
              borderRadius: 18,
              backgroundColor: on ? C.navy : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text style={[{ fontSize: 14, lineHeight: 20, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>
              {k === 'yes' ? 'Yes' : 'No'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The verdict, as the coloured chip the review card ends on. */
function VerdictChip({ outcome }: { outcome: string | null }) {
  const look =
    outcome === 'approved'
      ? { bg: C.successBg, fg: C.success, icon: 'tick' as const }
      : outcome === 'rejected'
        ? { bg: C.dangerBg, fg: C.danger, icon: 'close' as const }
        : outcome === 'more_testing'
          ? { bg: C.warnBg, fg: C.warnInk, icon: 'refresh' as const }
          : { bg: C.canvas, fg: C.ink, icon: null };
  return (
    <View
      style={{
        flex: 1,
        minHeight: 36,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 18,
        backgroundColor: look.bg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}>
      {look.icon ? <Icon name={look.icon} size={14} color={look.fg} strokeWidth={2.2} /> : null}
      <Text style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: look.fg }, weight(700)]}>{verdictSentence(outcome)}</Text>
    </View>
  );
}

/** A sheet's header: the tinted disc, the title and the line under it. */
function SheetHead({ icon, title, sub, a11ySub }: { icon: React.ReactNode; title: string; sub: string; a11ySub?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
          {title}
        </Text>
        <Text accessibilityLabel={a11ySub} style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>
          {sub}
        </Text>
      </View>
    </View>
  );
}

/** The refusal box a sheet ends on, shaking when it speaks. */
function Refusal({ err, style }: { err: string | null; style: object }) {
  return (
    <Presence show={!!err}>
      <Animated.View
        style={[{ marginTop: 10, backgroundColor: C.dangerBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 }, style]}>
        <T style={[{ fontSize: 13, lineHeight: 18, color: C.danger }, weight(600)]}>{err}</T>
      </Animated.View>
    </Presence>
  );
}

/** The wash pill an answer is typed into on these sheets. */
const WASH_BOX = { backgroundColor: C.canvas, borderWidth: 0, borderRadius: 24, minHeight: 48, fontSize: 14, paddingHorizontal: 16 } as const;

/**
 * §15 — the courier and the docket, which are how a sample is traced.
 *
 * Both required, because a dispatch nobody can trace is a sample that will be
 * argued about in a fortnight with nothing to look up. The expected date is
 * what was PROMISED; when it actually lands is a separate mark, made by
 * somebody who saw it there.
 */
function DispatchSheet({
  open,
  byHand,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Step 1 said Hand Delivery: no courier and no docket to write. */
  byHand: boolean;
  onClose: () => void;
  onSave: (d: {
    courierName: string;
    courierDocket: string;
    expectedDeliveryDate: string;
  }) => Promise<void> | void;
}) {
  const [courier, setCourier] = React.useState('');
  const [docket, setDocket] = React.useState('');
  const [date, setDate] = React.useState<string | null>(null);
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /* The guard is a ref: `saving` is read from the render that drew the button,
     so a second tap landing before the re-render saw `false` and wrote the
     mark twice. The state stays for the label. */
  const savingRef = React.useRef(false);
  /* The box below the fields shakes when it refuses, and buzzes `warning`. */
  const refusal = useShake('warning');
  const refuse = (message: string) => {
    setErr(message);
    refusal.shake();
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <SheetHead
        icon={<Truck color={C.primaryDeep} size={22} />}
        title="Mark as sent"
        sub={byHand ? 'Hand delivery: only the day it should be there' : 'Who is taking it, and the docket number'}
      />

      {byHand ? null : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Input
              value={courier}
              onChangeText={(v) => {
                setCourier(v);
                setErr(null);
              }}
              accessibilityLabel="Courier"
              placeholder="Courier (Gati, VRL…)"
              style={WASH_BOX}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Input
              value={docket}
              onChangeText={(v) => {
                setDocket(v);
                setErr(null);
              }}
              accessibilityLabel="Docket number"
              placeholder="Docket no."
              style={WASH_BOX}
            />
          </View>
        </View>
      )}

      <Pressable
        onPress={() => setCal(!cal)}
        accessibilityRole="button"
        accessibilityLabel={'Should be there by: ' + (date ? dmy(date) : 'choose a day')}
        style={({ pressed }) => ({
          marginTop: 8,
          minHeight: 48,
          paddingVertical: 8,
          borderRadius: 24,
          backgroundColor: date ? C.primaryTint : pressed ? C.hairline : C.canvas,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        })}>
        <Icon name="cal" size={18} color={date ? C.primaryDeep : C.ink} strokeWidth={2} />
        <Text style={[{ fontSize: 14, lineHeight: 20, color: date ? C.primaryDeep : C.ink }, weight(date ? 700 : 600)]}>
          {'Should be there by · ' + (date ? dmy(date) : 'choose a day')}
        </Text>
      </Pressable>
      {cal ? (
        <View style={{ marginTop: 10 }}>
          <Calendar
            selected={date ?? ''}
            onPick={(iso) => {
              setDate(iso);
              setCal(false);
              setErr(null);
            }}
          />
        </View>
      ) : null}

      <Refusal err={err} style={refusal.style} />

      <SheetActions
        onCancel={onClose}
        label={saving ? 'Saving…' : 'Sent'}
        busy={saving}
        onPress={async () => {
          if (savingRef.current) return;
          if (!byHand && !courier.trim()) return refuse('Who is taking it? Write the courier.');
          if (!byHand && !docket.trim()) return refuse('Write the docket number. It is needed to track it.');
          if (!date) return refuse('Choose the day it should reach.');
          /* The sheet closes only after the write returns; a second tap
             before that queued a second dispatch mark for one parcel. */
          savingRef.current = true;
          setSaving(true);
          try {
            await onSave({ courierName: courier.trim(), courierDocket: docket.trim(), expectedDeliveryDate: date });
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        }}
      />
    </BottomSheet>
  );
}

/**
 * §16 — the seven-part review, and the verdict.
 *
 * The verdict is what the gate in front of Negotiation reads, so it is asked
 * here rather than inferred from the words: a review full of praise with the
 * trial still `pending` would leave the rung shut, and a review that read
 * badly and was marked approved would open it. Neither should be guessed from
 * prose.
 *
 * The photograph is a panel, a finish, a can on a shelf — evidence of the
 * trial rather than of the sample. It never blocks the save.
 */
function ReviewSheet({
  open,
  existing,
  onClose,
  onSave,
  onPhoto,
}: {
  open: boolean;
  existing: SampleFeedback | null;
  onClose: () => void;
  onSave: (fields: Record<string, string>, outcome: TrialVerdict, photoId: string | null) => Promise<void> | void;
  onPhoto: () => Promise<{ mediaId: string; uri: string } | null>;
}) {
  const [fields, setFields] = React.useState<Record<string, string>>(() => {
    const from = (existing ?? {}) as unknown as Record<string, string | null>;
    const out: Record<string, string> = {};
    for (const f of ACTIVE_FEEDBACK_FIELDS) out[f.id] = from[f.id] ?? '';
    return out;
  });
  /* No default: a verdict is mandatory, and one nobody chose is not one. A review
     recorded earlier opens on what it said. */
  const [outcome, setOutcome] = React.useState<'approved' | 'rejected' | 'more_testing' | null>(() => {
    const was = existing?.trialOutcome;
    return was === 'approved' || was === 'rejected' || was === 'more_testing' ? was : null;
  });
  const [photo, setPhoto] = React.useState<{ mediaId: string; uri: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /* The guard is a ref: `saving` is read from the render that drew the button,
     so a second tap landing before the re-render saw `false` and wrote the
     mark twice. The state stays for the label. */
  const savingRef = React.useRef(false);
  /* No buzz of its own: with a missing reason the button is disabled-with-a-
     reason and shakes and buzzes itself, and the empty-review refusal below
     buzzes by hand — one buzz per refusal, whichever path it came by. */
  const refusal = useShake(null);
  const refuse = (message: string) => {
    setErr(message);
    if (!owedWhy) feedback('warning');
    refusal.shake();
  };

  /*
   * A REJECTED SAMPLE HAS TO SAY WHY, and the button says so before it is
   * pressed.
   *
   * Any one of the seven answers used to be enough, so a No beside four
   * perfectly good notes about quality, performance, application and drying
   * saved a refusal with nothing in it that says WHY they refused — and the
   * next sample then goes out exactly the same, which is the whole point of
   * the rule. The three fields are `recordFeedback`'s own, imported rather
   * than retyped, because the office derives the stored rejection reason from
   * precisely those three and a check on a fourth would demand an answer and
   * still store nothing.
   *
   * Drawn on the button rather than raised on the press: the moment "No" is
   * picked the sheet knows exactly what is still owed, and a refusal held back
   * until the save is one that arrives after somebody thought they were done.
   */
  const owedWhy = outcome === 'rejected' && !rejectionSaidWhy(fields) ? REJECTION_NEEDS_WHY : null;
  /* The office's own rule, imported: a verdict and at least one meaningful answer. */
  const owed = trialReviewProblem(fields, outcome);

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <SheetHead
        icon={<ChatGlyph color={C.primaryDeep} size={22} />}
        title="What did they think?"
        sub="Sample received & review · their words · 1 box + verdict"
        a11ySub="Sample received & review · Write what they said, in their words. At least one box, and the verdict."
      />

      {/* All seven are prose and all seven get the microphone. Six of them were
          single-line boxes, so a sentence scrolled sideways out of view as it
          was typed — on a sheet whose own instruction is "their words, not a
          summary", read by somebody typing slowly in a language he does not
          write. `VoiceField` is the same `Input` with a mic in it. */}
      <View style={{ gap: 10, marginTop: 14 }}>
        {ACTIVE_FEEDBACK_FIELDS.map((f) => (
          <View key={f.id}>
            <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginBottom: 6 }, weight(700)]}>{f.label}</Text>
            <VoiceField
              value={fields[f.id] ?? ''}
              onChangeText={(v) => {
                setFields({ ...fields, [f.id]: v });
                setErr(null);
              }}
              accessibilityLabel={f.label}
              placeholder={f.id === 'otherComments' ? 'Anything else' : 'In their words'}
              style={[WASH_BOX, { paddingVertical: 13 }]}
            />
          </View>
        ))}
      </View>

      <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 14 }, weight(700)]}>Verdict</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
        {VERDICTS.map((v) => {
          const on = outcome === v.key;
          return (
            <Pressable
              key={v.key}
              onPress={() => {
                if (!on) feedback('select');
                setOutcome(v.key);
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={v.a11y}
              style={{
                flex: 1,
                minHeight: 64,
                paddingVertical: 8,
                borderRadius: 20,
                backgroundColor: on ? v.strong : v.bg,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                borderWidth: on ? 0 : 0,
              }}>
              <Icon name={v.icon} size={18} color={on ? '#FFFFFF' : v.fg} strokeWidth={2.2} />
              <Text style={[{ fontSize: 12, lineHeight: 17, color: on ? '#FFFFFF' : v.fg }, weight(700)]}>{v.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text
        accessibilityLabel="Negotiation opens only after an Approved verdict. That is the rule."
        style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
        Negotiation opens only after Approved.
      </Text>
      {/* Arrives the moment "No" is picked, in place, so the boxes above
          are not shoved down a line as his thumb leaves the chip. */}
      <Presence show={Boolean(owedWhy)}>
        <Text style={[{ fontSize: 12, lineHeight: 17, marginTop: 4, color: C.danger }, weight(600)]}>{owedWhy}</Text>
      </Presence>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
        {photo ? (
          <Image
            accessibilityLabel="The photo you took"
            source={{ uri: photo.uri }}
            style={{ width: 96, height: 72, borderRadius: 16, backgroundColor: '#DCE3EE' }}
            resizeMode="cover"
          />
        ) : null}
        <Pressable
          onPress={async () => {
            const shot = await onPhoto();
            if (shot) setPhoto(shot);
          }}
          accessibilityRole="button"
          accessibilityLabel={photo ? 'Take another' : 'Photo of the finish or the can, optional'}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: 72,
            paddingVertical: 8,
            borderRadius: 16,
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: '#B9A6FF',
            backgroundColor: pressed ? C.primaryTint : '#F7F4FF',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          })}>
          <Icon name="camera" size={18} color={C.primaryDeep} strokeWidth={2} />
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>
            {photo ? 'Take another' : 'Photo of the finish or the can'}
          </Text>
        </Pressable>
      </View>

      <Refusal err={err} style={refusal.style} />

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <PillButton label="Cancel" variant="outline" height={56} onPress={onClose} style={{ width: 120 }} />
        <PillButton
          label={saving ? 'Saving…' : 'Save feedback'}
          variant="navyLime"
          height={56}
          disabled={saving || Boolean(owedWhy)}
          whyDisabled={owedWhy ?? undefined}
          onRefused={(why) => refuse(why)}
          onPress={async () => {
            if (savingRef.current) return;
            if (owed) return refuse(owed);
            if (owedWhy) return refuse(owedWhy);
            /* The sheet only closes once the write returns, so without this a
               second tap on a slow phone saved the review twice. */
            savingRef.current = true;
            setSaving(true);
            try {
              await onSave(fields, outcome!, photo?.mediaId ?? null);
            } finally {
              savingRef.current = false;
              setSaving(false);
            }
          }}
          style={{ flex: 1 }}
        />
      </View>
    </BottomSheet>
  );
}

/** The three verdicts the office takes, as the review sheet draws them. */
const VERDICTS = [
  { key: 'approved', label: 'Approved', a11y: 'Approved', icon: 'tick', bg: C.successBg, fg: C.success, strong: C.success },
  { key: 'rejected', label: 'Rejected', a11y: 'Rejected', icon: 'close', bg: C.dangerBg, fg: C.danger, strong: C.danger },
  /* The third real verdict. Without it a trial that happened and produced
     "again, on something else" had to be filed as though nobody had
     answered. */
  {
    key: 'more_testing',
    label: 'More testing',
    a11y: 'More Testing Required',
    icon: 'refresh',
    bg: C.warnBg,
    fg: C.warnInk,
    strong: C.warnInk,
  },
] as const;
