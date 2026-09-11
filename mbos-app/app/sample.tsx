import React from 'react';
import { View, Image } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import {
  cancelSample,
  confirmReceived,
  feedbackFor,
  getSample,
  markDispatched,
  markTrialStarted,
  markTried,
  recordFeedback,
  whatIsOwed,
  type FunnelSample,
  type SampleFeedback,
  type TrialVerdict,
} from '../src/data/lead-samples';
import { VoiceField } from '../src/components/ui/dictate';
import { getCustomer } from '../src/data/customers';
import { getLead } from '../src/data/leads';
import { takePhoto } from '../src/native/capture';
import { FEEDBACK_FIELDS } from '../src/engines/funnel';
import { dmy, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

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
    default: return 'No verdict yet';
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
  const askConfirm = useStore((s) => s.askConfirm);

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
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) {
      setStatus('ready');
      return;
    }
    void Promise.all([getSample(id), feedbackFor(id)])
      .then(async ([s, f]) => {
        if (!live) return;
        setSample(s);
        setReview(f);
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
      <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            {status === 'reading'
              ? 'Reading…'
              : status === 'failed'
                ? 'That could not be read off this phone'
                : 'This sample is not on this phone'}
          </T>
        </Card>
      </AppFrame>
    );
  }

  const s = sample;
  const owed = whatIsOwed(s);
  const finished = s.state === 'Reviewed' || s.state === 'Converted' || s.state === 'Cancelled' || s.state === 'Rejected';

  return (
    <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>{who || 'Unknown shop'}</T>
            <T s="caption" style={{ marginTop: 2 }}>
              {[s.productName, s.cans ? plural(s.cans, 'can') : null].filter(Boolean).join(' · ')}
            </T>
          </View>
          <Badge tone={toneFor(s.state)}>{s.state}</Badge>
        </View>

        {owed ? (
          <T style={[{ fontSize: 15, lineHeight: 21, marginTop: 10, color: C.ink }, weight(500)]}>{owed}</T>
        ) : null}

        <Divider style={{ marginVertical: 12 }} />

        <View style={{ gap: 8 }}>
          <Line label="Asked for" value={pretty(isoDate(new Date(s.requestedAt)))} />
          {s.application ? <Line label="Used on" value={s.application} /> : null}
          {s.dispatchedAt ? <Line label="Sent" value={pretty(isoDate(new Date(s.dispatchedAt)))} /> : null}
          {s.courierDocket ? <Line label="Docket" value={[s.courierName, s.courierDocket].filter(Boolean).join(' · ')} /> : null}
          {s.expectedDeliveryDate ? <Line label="Due there" value={pretty(s.expectedDeliveryDate)} /> : null}
          {/* THE SHOP'S WORD, not the carrier's, and the two are not the same
              record. `receivedConfirmedAt` is what a confirmation made on this
              handset writes and `receivedAt` is the name the office writes the
              same fact under — reading only the first meant a sample the shop
              had confirmed to the office showed nothing here at all. */}
          {s.receivedConfirmedAt || s.receivedAt ? (
            <Line
              label="They confirmed it"
              value={pretty(isoDate(new Date((s.receivedConfirmedAt ?? s.receivedAt) as number)))}
            />
          ) : null}
          {/* BOTH trial dates, because the gap between them is the point. A can
              opened three weeks ago and never finished reads here as exactly
              that instead of looking identical to one nobody has touched. */}
          {s.trialStartedAt ? (
            <Line label="Trial started" value={pretty(isoDate(new Date(s.trialStartedAt)))} />
          ) : null}
          {s.trialCompletedAt ? (
            <Line label="Trial finished" value={pretty(isoDate(new Date(s.trialCompletedAt)))} />
          ) : null}
          {s.reviewedAt ? <Line label="Reviewed" value={pretty(isoDate(new Date(s.reviewedAt)))} /> : null}
          {s.cancelReason ? <Line label="Cancelled" value={s.cancelReason} /> : null}
          {/* WHY IT WAS REFUSED. §K demands the reason so that the next sample
              does not go out identical, and the salesman is the person who
              would change it — and was the one person never shown it. Until
              this line existed a refused sample was a red badge, no sentence
              under it (`whatIsOwed` is null for a finished one) and the whole
              action block hidden: a card with one word on it. */}
          {s.rejectionReason ? (
            <Line label="Refused because" value={s.rejectionReason} />
          ) : s.state === 'Rejected' ? (
            /* A missing reason is said rather than drawn as an empty card. The
               rule demands one, so its absence is itself worth knowing. */
            <Line
              label="Refused because"
              value="The office has not said why. Worth asking before the next one goes out."
            />
          ) : null}
          {s.satisfaction ? <Line label="They said" value={s.satisfaction} /> : null}
          {s.additionalRequirement ? <Line label="Also asked for" value={s.additionalRequirement} /> : null}
        </View>
      </Card>

      {/* ------------------------------------------------ §15 the next mark */}
      {finished ? null : (
        <View style={{ marginTop: 20, gap: 10 }}>
          <SectionLabel style={{ marginBottom: 0 }}>What happens next</SectionLabel>

          {s.state === 'Requested' ? (
            <Card>
              <T style={{ fontSize: 15, lineHeight: 21, color: C.muted }}>
                The office has to approve it before anything goes out. Nothing for you to do here yet.
              </T>
            </Card>
          ) : null}

          {s.state === 'Approved' ? (
            <PrimaryButton label="It has gone out" onPress={() => setDispatchOpen(true)} />
          ) : null}

          {s.state === 'Dispatched' ? (
            <>
              <PrimaryButton
                label={busy ? 'Saving…' : 'They have it — confirm with a photo'}
                disabled={busy}
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
                    if (!r.ok) return notify(r.message);
                    load();
                    /* "Delivered" was the carrier's word for a mark that is the
                       SHOP's. One tap cannot assert both, and the record now
                       only claims the one it is actually evidence of. */
                    notify(shot.ok ? 'They confirmed it, with a photo' : 'They confirmed it — no photo taken');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <SecondaryButton
                label="They have it — no photo"
                onPress={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    const r = await confirmReceived(s.id, null);
                    if (!r.ok) return notify(r.message);
                    load();
                    notify('They confirmed it');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </>
          ) : null}

          {s.state === 'Awaiting feedback' ? (
            <>
              <PrimaryButton label="Write down what they thought" onPress={() => setReviewOpen(true)} />
              {/* STARTED and FINISHED are two marks. Without the first, a shop
                  that opened the can three weeks ago and never got to the end
                  of it looks exactly like one that has not touched it — and
                  that stall is the commonest way a sample goes quiet. It is
                  offered once: the date is already on the record afterwards. */}
              {s.trialStartedAt ? null : (
                <SecondaryButton
                  label="They have started using it"
                  onPress={async () => {
                    if (busy) return;
                    setBusy(true);
                    try {
                      const r = await markTrialStarted(s.id);
                      if (!r.ok) return notify(r.message);
                      load();
                      notify('Trial started — the review is still what is owed');
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              )}
              <SecondaryButton
                label="They have tried it — I will ask later"
                onPress={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    const r = await markTried(s.id);
                    if (!r.ok) return notify(r.message);
                    load();
                    notify('Tried — the review is what is owed now');
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </>
          ) : null}

          {s.state === 'Tried' ? (
            <PrimaryButton label="Write down what they thought" onPress={() => setReviewOpen(true)} />
          ) : null}

          <DashedButton
            label="Cancel this sample"
            onPress={() =>
              askConfirm({
                title: 'Cancel this sample?',
                body: 'The record stays with your reason on it. It stops being chased.',
                reasonLabel: 'Why · required',
                confirmLabel: 'Cancel it',
                run: (reason) => {
                  void cancelSample(s.id, reason).then((r) => {
                    if (!r.ok) return notify(r.message);
                    load();
                    notify('Cancelled');
                  });
                },
              })
            }
          />
        </View>
      )}

      {/* ------------------------------------------------- §16 the review */}
      {review ? (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>What they said</SectionLabel>
          <Card>
            <View style={{ gap: 10 }}>
              {FEEDBACK_FIELDS.map((f) => {
                const said = (review as unknown as Record<string, string | null>)[f.id];
                if (!said) return null;
                return (
                  <View key={f.id}>
                    <T s="caption">{f.label}</T>
                    <T style={{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 2 }}>{said}</T>
                  </View>
                );
              })}
            </View>
            <Divider style={{ marginVertical: 12 }} />
            {/* FOUR verdicts. "They want to try it again" drawn as "No verdict
                yet" filed a trial that really happened as an unanswered one —
                which is the one reading of it that loses the trial. */}
            <T
              style={[
                {
                  fontSize: 15,
                  color:
                    review.trialOutcome === 'approved'
                      ? C.success
                      : review.trialOutcome === 'more_testing'
                        ? C.warnInk
                        : C.ink,
                },
                weight(600),
              ]}>
              {verdictSentence(review.trialOutcome)}
            </T>
            {review.photoId ? (
              <T s="caption" style={{ marginTop: 6 }}>A photograph was taken and is queued to upload.</T>
            ) : null}
            <SecondaryButton label="Change it" onPress={() => setReviewOpen(true)} style={{ marginTop: 12 }} />
          </Card>
        </View>
      ) : null}

      <SecondaryButton label="Back to samples" onPress={() => router.replace('/samples')} style={{ marginTop: 20 }} />

      <DispatchSheet
        key={dispatchOpen ? 'd-open' : 'd-shut'}
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        onSave={async (d) => {
          const r = await markDispatched(s.id, d);
          if (!r.ok) return notify(r.message);
          setDispatchOpen(false);
          load();
          notify('Sent · ' + d.courierDocket);
        }}
      />

      <ReviewSheet
        key={reviewOpen ? 'r-open' : 'r-shut'}
        open={reviewOpen}
        existing={review}
        onClose={() => setReviewOpen(false)}
        onSave={async (fields, outcome, photoId) => {
          const r = await recordFeedback(s.id, { customerId: s.customerId, fields, trialOutcome: outcome, photoId });
          if (!r.ok) return notify(r.message);
          setReviewOpen(false);
          load();
          notify('Written down');
        }}
        onPhoto={async () => {
          const shot = await takePhoto({ parentType: 'sample', parentId: s.id, kind: 'sample_proof' });
          if (!shot.ok) {
            notify(shot.reason === 'cancelled' ? 'No photo taken' : shot.reason);
            return null;
          }
          return { mediaId: shot.mediaId, uri: shot.uri };
        }}
      />
    </AppFrame>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
      <T s="caption" style={{ width: 110 }}>{label}</T>
      <T style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }}>{value}</T>
    </View>
  );
}

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
  onClose,
  onSave,
}: {
  open: boolean;
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

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>It has gone out</T>
      <T s="caption" style={{ marginTop: 2 }}>Who is carrying it, and under what number.</T>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Courier</SectionLabel>
        <Input value={courier} onChangeText={(v) => { setCourier(v); setErr(null); }} placeholder="Gati, VRL, our own vehicle" />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Docket number</SectionLabel>
        <Input value={docket} onChangeText={(v) => { setDocket(v); setErr(null); }} placeholder="The number on the slip" />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Should be there by</SectionLabel>
        <Choice
          label={date ? dmy(date) : 'Pick a day'}
          selected={Boolean(date)}
          onPress={() => setCal(!cal)}
          style={{ alignItems: 'flex-start', paddingHorizontal: 14, minHeight: 52 }}
        />
        {cal ? (
          <View style={{ marginTop: 10 }}>
            <Calendar selected={date ?? ''} onPick={(iso) => { setDate(iso); setCal(false); setErr(null); }} />
          </View>
        ) : null}
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label={saving ? 'Saving…' : 'Sent'}
          disabled={saving}
          onPress={async () => {
            if (saving) return;
            if (!courier.trim()) return setErr('Who is carrying it?');
            if (!docket.trim()) return setErr('The docket number — without it nobody can trace it.');
            if (!date) return setErr('When should it get there?');
            /* The sheet closes only after the write returns; a second tap
               before that queued a second dispatch mark for one parcel. */
            setSaving(true);
            try {
              await onSave({ courierName: courier.trim(), courierDocket: docket.trim(), expectedDeliveryDate: date });
            } finally {
              setSaving(false);
            }
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
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
    for (const f of FEEDBACK_FIELDS) out[f.id] = from[f.id] ?? '';
    return out;
  });
  const [outcome, setOutcome] = React.useState<TrialVerdict>(
    (existing?.trialOutcome as TrialVerdict) ?? 'pending',
  );
  const [photo, setPhoto] = React.useState<{ mediaId: string; uri: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        What did they think?
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        Their words, not a summary. Anything you leave empty stays empty.
      </T>

      {/* All seven are prose and all seven get the microphone. Six of them were
          single-line boxes, so a sentence scrolled sideways out of view as it
          was typed — on a sheet whose own instruction is "their words, not a
          summary", read by somebody typing slowly in a language he does not
          write. `VoiceField` is the same `Input` with a mic in it. */}
      {FEEDBACK_FIELDS.map((f) => (
        <View key={f.id} style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>{f.label}</SectionLabel>
          <VoiceField
            value={fields[f.id] ?? ''}
            onChangeText={(v) => { setFields({ ...fields, [f.id]: v }); setErr(null); }}
            placeholder={f.id === 'otherComments' ? 'Anything else worth knowing' : 'In their words'}
          />
        </View>
      ))}

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>So — were they happy with it?</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Choice label="Yes" selected={outcome === 'approved'} onPress={() => setOutcome('approved')} style={{ paddingHorizontal: 16 }} />
          <Choice label="No" selected={outcome === 'rejected'} onPress={() => setOutcome('rejected')} style={{ paddingHorizontal: 16 }} />
          {/* The third real verdict. Without it a trial that happened and
              produced "again, on something else" had to be filed as though
              nobody had answered. */}
          <Choice
            label="They want to try it again"
            selected={outcome === 'more_testing'}
            onPress={() => setOutcome('more_testing')}
            style={{ paddingHorizontal: 16 }}
          />
          <Choice label="Not decided" selected={outcome === 'pending'} onPress={() => setOutcome('pending')} style={{ paddingHorizontal: 16 }} />
        </View>
        <T s="caption" style={{ marginTop: 6 }}>
          Negotiation does not open until this is a yes. That is the rule, not the screen being awkward.
        </T>
      </View>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>A photograph, if there is one</SectionLabel>
        {photo ? (
          <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 160, borderRadius: radius.lg }} resizeMode="cover" />
        ) : null}
        <DashedButton
          label={photo ? 'Take another' : '+ The panel, the finish, the can on his shelf'}
          onPress={async () => {
            const shot = await onPhoto();
            if (shot) setPhoto(shot);
          }}
          style={{ marginTop: photo ? 10 : 0 }}
        />
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label={saving ? 'Saving…' : 'Save the review'}
          disabled={saving}
          onPress={async () => {
            if (saving) return;
            const any = FEEDBACK_FIELDS.some((f) => (fields[f.id] ?? '').trim());
            if (!any) return setErr('Write down at least one thing they said about it.');
            /* The sheet only closes once the write returns, so without this a
               second tap on a slow phone saved the review twice. */
            setSaving(true);
            try {
              await onSave(fields, outcome, photo?.mediaId ?? null);
            } finally {
              setSaving(false);
            }
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}
